/**
 * scripts/fix-mam-year-of-release.mjs — reduce Albums::Year of Release to a bare year.
 *
 * The field is meant to hold "1955". Most of it does (11,017 of 11,827), but the
 * rest accumulated whatever the source database happened to have:
 *
 *   1973-06-26              a full ISO date
 *   15-07-1984              a DAY-first date — 15 is not a month
 *   recorded 30 March 1976  a curator's prose note
 *   c1965                   circa
 *   1987-01 · 7-1978        partial dates, either way round
 *   -0-0 · 09-0 · reco      junk with no year in it at all
 *
 * This is why it gets its own script rather than riding along with the release-date
 * fix: that field is uniformly month-first, and this one contains day-first values.
 * Any rule that tried to parse these as dates would have to guess. So it doesn't
 * parse them as dates at all — it pulls out the four-digit year and discards the
 * rest, which is the only part the field is supposed to hold anyway. "15-07-1984"
 * and "recorded 30 March 1976" both answer the only question being asked.
 *
 * Left strictly alone:
 *   - values that are already a bare year
 *   - values with NO plausible year (-0-0, reco) — nothing to derive
 *   - values with MORE THAN ONE distinct year (a range) — a guess, not a fix
 *
 * Every write is journalled first, same as the release-date run.
 * DRY RUN unless --apply.
 */
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const HOST = process.env.GALLO_FM_HOST
const USER = process.env.GALLO_FM_USER
const PASS = process.env.GALLO_FM_PASS
const BASE = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const LAYOUT = 'Albums'
const FIELD  = 'Year of Release'
const LOG    = 'tmp/fix-mam-year-of-release.log.jsonl'

const journal = (row) => { try { appendFileSync(LOG, JSON.stringify(row) + '\n') } catch { /* never block a write on logging */ } }

/** The bare year, or null to leave the value exactly as it is. */
export function toYear(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/^\d{4}$/.test(v)) return null                              // already correct
  const years = [...new Set([...v.matchAll(/\d{4}/g)]
    .map(m => +m[0])
    .filter(y => y >= 1900 && y <= 2100))]
  if (years.length !== 1) return null                             // none, or a range
  return String(years[0])
}

async function main() {
  if (!HOST || !USER || !PASS) { console.error('GALLO_FM_* must be set'); process.exit(1) }
  console.log(`host ${HOST} · db "Music Arena Master" · ${LAYOUT}::${FIELD} · ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (APPLY) { try { mkdirSync('tmp', { recursive: true }) } catch { /* already there */ } ; console.log(`journal → ${LOG}`) }
  console.log()

  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  const login = await (await fetch(BASE + '/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}',
  })).json()
  const tok = login?.response?.token
  if (!tok) { console.error('login failed:', JSON.stringify(login?.messages)); process.exit(1) }
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }

  let seen = 0, converted = 0, failed = 0
  const left = new Map()
  try {
    // Converting does not change whether a row is non-empty, so the found set is
    // stable and paging by offset stays valid all the way through.
    for (let offset = 1; ; offset += 200) {
      const r = await (await fetch(`${BASE}/layouts/${LAYOUT}/_find`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: [{ [FIELD]: '*' }], limit: 200, offset }),
      })).json()
      if (r?.messages?.[0]?.code === '401') break
      const rows = r?.response?.data || []
      if (!rows.length) break

      for (const rec of rows) {
        seen++
        const before = rec.fieldData[FIELD]
        const after  = toYear(before)
        if (after === null) {
          const v = String(before ?? '').trim()
          if (v && !/^\d{4}$/.test(v)) {                          // not already correct → worth reporting
            const shape = v.replace(/\d/g, '#')
            const s = left.get(shape) || { count: 0, sample: v }
            s.count++; left.set(shape, s)
          }
          continue
        }
        if (!APPLY) { if (converted < 8) console.log(`   ${JSON.stringify(before).padEnd(26)} → ${after}`); converted++; continue }
        try {
          journal({ layout: LAYOUT, field: FIELD, recordId: rec.recordId, before, after })
          const w = await (await fetch(`${BASE}/layouts/${LAYOUT}/records/${rec.recordId}`, {
            method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { [FIELD]: after } }),
          })).json()
          if (w?.messages?.[0]?.code === '0') converted++
          else { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, w?.messages?.[0]?.message) }
        } catch (e) { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, e.message) }
      }
      if (offset > 20000) break                                   // backstop
    }

    console.log(`\nscanned ${seen} non-empty · ${APPLY ? 'converted' : 'would convert'} ${converted}${failed ? ` · FAILED ${failed}` : ''}`)
    if (left.size) {
      console.log('\nleft alone — no single year to derive, needs a human:')
      for (const [shape, s] of [...left.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(`   ${shape.padEnd(14)} ${String(s.count).padStart(5)}   e.g. ${JSON.stringify(s.sample)}`)
      }
    }
    if (!APPLY) console.log('\nDRY RUN — nothing written. Add --apply')
  } finally {
    await fetch(BASE + '/sessions/' + tok, { method: 'DELETE', headers: H }).catch(() => {})
  }
}

main()
