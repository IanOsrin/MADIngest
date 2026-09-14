/**
 * scripts/fix-streamer-dates.mjs — the MAM date cleanup, applied to MadStreamer.
 *
 * Same three shapes, same two rules, same evidence. Streamer's API_Album_Songs
 * layout carries all three date fields on one record:
 *
 *   Original Release date   1,503 slashed of 64,846   → ISO
 *   Release Date            1,524 slashed of 58,326   → ISO
 *   Year of Release           127 dashed  of 65,068   → bare year
 *
 * Month-first is evidenced here too, not inherited from the MAM run: across the
 * slashed values, 1,032 (Original Release date) and 583 (Release Date) have a
 * second part above 12, and ZERO have a first part above 12. Ten values carry the
 * year 1885, which the converter refuses as out of range — commercial recording
 * did not exist then, so those are typos for a human.
 *
 * THIS IS THE LIVE DATABASE THE WEBSITE READS. Two things were checked first:
 *   - the host is pinned to FMCloud below, never inherited from GALLO_FM_HOST,
 *     because that inheritance is how a composer repair once ran to completion
 *     against a backup copy nobody reads;
 *   - the app tolerates the change. lib/catalog-mapper.js derives a year with
 *     /\b(19|20)\d{2}\b/, which matches "9/25/1978" and "1978-09-25" alike, and
 *     "Year of Release" is rendered RAW — so cleaning it fixes a live display
 *     bug where 127 records show "1973-06-26" in a slot meant for "1973".
 *
 * Converters are imported from the MAM scripts rather than re-typed: they have
 * been run against 16,886 records and unit-checked, and a second copy is a
 * second thing to get wrong.
 *
 * DRY RUN unless --apply.
 */
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { toIso } from './fix-mam-dates.mjs'
import { toYear } from './fix-mam-year-of-release.mjs'

const APPLY = process.argv.includes('--apply')

// PINNED. MadStreamer lives on FMCloud; everything else lives on
// digitalcupboard.app. See lib/madstreamer.js and the hosts-split note.
const HOST   = 'https://digitalcupboard.fmcloud.fm'
const DB     = process.env.MADSTREAMER_FM_DB || 'MadStreamer'
const USER   = process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER
const PASS   = process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS
const LAYOUT = 'API_Album_Songs'
const BASE   = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const LOG    = 'tmp/fix-streamer-dates.log.jsonl'

const journal = (row) => { try { appendFileSync(LOG, JSON.stringify(row) + '\n') } catch { /* never block a write on logging */ } }

/**
 * `selector` is what the find matches, and it must be something a CONVERTED row
 * stops matching — that is what makes each pass shorter than the last and the
 * whole script idempotent. For the two date fields "contains a slash" does it.
 * Year of Release cannot work that way (a bare year is still non-empty), so it
 * pages instead.
 */
const TARGETS = [
  { field: 'Original Release date', selector: '*/*', convert: toIso,  paged: false },
  { field: 'Release Date',          selector: '*/*', convert: toIso,  paged: false },
  { field: 'Year of Release',       selector: '*',   convert: toYear, paged: true  },
]

async function main() {
  if (!USER || !PASS) { console.error('MADSTREAMER_FM_USER/PASS (or GALLO_FM_USER/PASS) must be set'); process.exit(1) }
  console.log(`host ${HOST} · db "${DB}" · ${LAYOUT} · ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (APPLY) { try { mkdirSync('tmp', { recursive: true }) } catch { /* already there */ } ; console.log(`journal → ${LOG}`) }
  console.log()

  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  const login = await (await fetch(BASE + '/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}',
  })).json()
  const tok = login?.response?.token
  if (!tok) { console.error('login failed:', JSON.stringify(login?.messages)); process.exit(1) }
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }

  // Guard against the restored-copy trap: the live file has sign-ins today.
  const act = await (await fetch(
    `${BASE}/layouts/API_Access_Tokens/records?_limit=3&_sort=${encodeURIComponent(JSON.stringify([{ fieldName: 'Session_Last_Activity', sortOrder: 'descend' }]))}`,
    { headers: H })).json()
  const newest = (act?.response?.data || []).map(r => r.fieldData['Session_Last_Activity']).filter(Boolean)[0]
  console.log(`newest session activity on this file: ${newest || '(unknown)'}${newest ? '' : ' — CHECK THIS IS THE LIVE FILE'}\n`)

  try {
    for (const { field, selector, convert, paged } of TARGETS) {
      console.log(`════ ${field}`)
      const skipped = new Map()
      let seen = 0, converted = 0, failed = 0, offset = 1

      for (;;) {
        const usePaging = paged || !APPLY
        const r = await (await fetch(`${BASE}/layouts/${LAYOUT}/_find`, {
          method: 'POST', headers: H,
          body: JSON.stringify({ query: [{ [field]: selector }], limit: 200, offset: usePaging ? offset : 1 }),
        })).json()
        if (r?.messages?.[0]?.code === '401') break
        const rows = r?.response?.data || []
        if (!rows.length) break

        let changedThisPage = 0
        for (const rec of rows) {
          seen++
          const before = rec.fieldData[field]
          const after  = convert(before)
          if (after === null) {
            const v = String(before ?? '').trim()
            // Only report values that are genuinely unhandled, not ones already correct.
            if (v && !(field === 'Year of Release' ? /^\d{4}$/.test(v) : /^\d{4}-\d{2}-\d{2}$/.test(v))) {
              const shape = v.replace(/\d/g, '#')
              const s = skipped.get(shape) || { count: 0, sample: v }
              s.count++; skipped.set(shape, s)
            }
            continue
          }
          if (!APPLY) { if (converted < 5) console.log(`   e.g. ${String(before).padEnd(14)} → ${after}`); converted++; continue }
          try {
            journal({ layout: LAYOUT, field, recordId: rec.recordId, before, after })
            const w = await (await fetch(`${BASE}/layouts/${LAYOUT}/records/${rec.recordId}`, {
              method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { [field]: after } }),
            })).json()
            if (w?.messages?.[0]?.code === '0') { converted++; changedThisPage++ }
            else { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, w?.messages?.[0]?.message) }
          } catch (e) { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, e.message) }
          if (converted && converted % 500 === 0) console.log(`   … ${converted} converted`)
        }

        if (usePaging) { offset += 200; if (offset > 80000) break }
        else if (changedThisPage === 0) break   // nothing on this page was convertible
      }

      console.log(`   scanned ${seen} · ${APPLY ? 'converted' : 'would convert'} ${converted}${failed ? ` · FAILED ${failed}` : ''}`)
      if (skipped.size) {
        console.log('   left alone — needs a human:')
        for (const [shape, s] of [...skipped.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)) {
          console.log(`      ${shape.padEnd(14)} ${String(s.count).padStart(5)}   e.g. ${JSON.stringify(s.sample)}`)
        }
      }
      console.log()
    }
    if (!APPLY) console.log('DRY RUN — nothing written. Add --apply')
  } finally {
    await fetch(BASE + '/sessions/' + tok, { method: 'DELETE', headers: H }).catch(() => {})
  }
}

main()
