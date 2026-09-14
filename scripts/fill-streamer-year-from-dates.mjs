/**
 * scripts/fill-streamer-year-from-dates.mjs — recover Year of Release from the
 * dates on the SAME record, for the rows fix-streamer-dates.mjs could not derive
 * a year from (115 of them holding "18-0", plus stragglers).
 *
 * Simpler than the MAM equivalent. There, Year of Release lives on Albums and the
 * dates had to be gathered from Songs across a catalogue-number join, which raised
 * the question of what to do when a compilation's tracks disagree. Streamer's
 * API_Album_Songs is track-level and carries all three fields on one row, so the
 * answer is just sitting in the next column.
 *
 *   1. Original Release date   preferred — it is the original, which is what a
 *                              "Year of Release" is asking about
 *   2. Release Date            fallback, often a reissue or digital-release date
 *
 * Runs AFTER fix-streamer-dates.mjs, which is what makes both of those reliably
 * ISO in the first place.
 *
 * Refuses a year equal to the current year: on the Gallo Vault batches the date
 * fields carry the day the batch was ingested, not a release. Writing that would
 * be worse than leaving "18-0" — junk announces itself, a plausible wrong year
 * does not.
 *
 * Only touches rows whose Year of Release is not already a bare year, so it can
 * never overwrite a good value. Journals every write. DRY RUN unless --apply.
 */
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')

// PINNED to FMCloud — see fix-streamer-dates.mjs.
const HOST   = 'https://digitalcupboard.fmcloud.fm'
const DB     = process.env.MADSTREAMER_FM_DB || 'MadStreamer'
const USER   = process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER
const PASS   = process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS
const LAYOUT = 'API_Album_Songs'
const FIELD  = 'Year of Release'
const BASE   = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const LOG    = 'tmp/fill-streamer-year-from-dates.log.jsonl'

const journal = (row) => { try { appendFileSync(LOG, JSON.stringify(row) + '\n') } catch { /* never block a write on logging */ } }

const THIS_YEAR  = String(new Date().getFullYear())
const isBareYear = (v) => /^\d{4}$/.test(String(v ?? '').trim())
const yearOf = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{4})-\d{1,2}-\d{1,2}/)
  const y = m ? +m[1] : NaN
  return (y >= 1900 && y <= 2100) ? String(y) : null
}

async function main() {
  if (!USER || !PASS) { console.error('MADSTREAMER_FM_USER/PASS (or GALLO_FM_USER/PASS) must be set'); process.exit(1) }
  console.log(`host ${HOST} · db "${DB}" · ${LAYOUT}::${FIELD} · ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (APPLY) { try { mkdirSync('tmp', { recursive: true }) } catch { /* already there */ } ; console.log(`journal → ${LOG}`) }
  console.log()

  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  const login = await (await fetch(BASE + '/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}',
  })).json()
  const tok = login?.response?.token
  if (!tok) { console.error('login failed:', JSON.stringify(login?.messages)); process.exit(1) }
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }

  const stats = { fromOriginal: 0, fromRelease: 0, failed: 0 }
  const unresolved = new Map()
  try {
    for (let offset = 1; ; offset += 200) {
      const r = await (await fetch(`${BASE}/layouts/${LAYOUT}/_find`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: [{ [FIELD]: '*' }], limit: 200, offset }),
      })).json()
      if (r?.messages?.[0]?.code === '401') break
      const rows = r?.response?.data || []
      if (!rows.length) break

      for (const rec of rows) {
        const before = String(rec.fieldData[FIELD] ?? '').trim()
        if (!before || isBareYear(before)) continue

        let year = yearOf(rec.fieldData['Original Release date'])
        let via  = 'Original Release date'
        if (!year) { year = yearOf(rec.fieldData['Release Date']); via = 'Release Date' }

        let why = null
        if (!year) why = 'no usable date on the record'
        else if (year === THIS_YEAR) why = `date is ${THIS_YEAR} — a vault load stamp, not a release year`
        if (why) {
          const k = `${before.replace(/\d/g, '#')} · ${why}`
          const u = unresolved.get(k) || { count: 0, sample: before }
          u.count++; unresolved.set(k, u)
          continue
        }

        if (via === 'Original Release date') stats.fromOriginal++; else stats.fromRelease++
        if (!APPLY) {
          if (stats.fromOriginal + stats.fromRelease <= 8) console.log(`   ${JSON.stringify(before).padEnd(10)} → ${year}   via ${via}`)
          continue
        }
        try {
          journal({ layout: LAYOUT, field: FIELD, recordId: rec.recordId, before, after: year, via })
          const w = await (await fetch(`${BASE}/layouts/${LAYOUT}/records/${rec.recordId}`, {
            method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { [FIELD]: year } }),
          })).json()
          if (w?.messages?.[0]?.code !== '0') { stats.failed++; if (stats.failed < 5) console.warn('   FAIL', rec.recordId, w?.messages?.[0]?.message) }
        } catch (e) { stats.failed++; if (stats.failed < 5) console.warn('   FAIL', rec.recordId, e.message) }
      }
      if (offset > 80000) break
    }

    const filled = stats.fromOriginal + stats.fromRelease
    console.log(`\n${APPLY ? 'filled' : 'would fill'} ${filled}` +
                `  (${stats.fromOriginal} from Original Release date, ${stats.fromRelease} from Release Date)` +
                `${stats.failed ? ` · FAILED ${stats.failed}` : ''}`)
    if (unresolved.size) {
      console.log('\nstill unresolved:')
      for (const [k, u] of [...unresolved.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(`   ${String(u.count).padStart(5)}   e.g. ${JSON.stringify(u.sample).padEnd(10)}  ${k.split(' · ')[1]}`)
      }
    }
    if (!APPLY) console.log('\nDRY RUN — nothing written. Add --apply')
  } finally {
    await fetch(BASE + '/sessions/' + tok, { method: 'DELETE', headers: H }).catch(() => {})
  }
}

main()
