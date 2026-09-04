/**
 * scripts/fix-mam-dates.mjs — normalise MAM release dates to ISO (YYYY-MM-DD).
 *
 * MAM holds release dates in three shapes, because it was merged from three
 * databases that each had their own idea:
 *
 *   1978-09-25   ISO. Already correct — the majority, and left alone.
 *   9/25/1978    US month-first. The bulk of what needs fixing.
 *   1977/04/10   ISO with the wrong separator. Fixed by swapping the slashes.
 *
 * Month-first is not an assumption. A 2,000-value sample found 1,064 with a
 * second part above 12 — impossible unless that part is the day — and ZERO
 * with a first part above 12 once the year-first shape is excluded. So no
 * value in this field is day-first, and 9/25 cannot be 9 May.
 *
 * Anything that does not match one of the two convertible shapes exactly, or
 * whose month/day fall outside 1-12 / 1-31, is REPORTED AND LEFT ALONE. A date
 * this script cannot read is a date a human should look at, not one it should
 * guess at.
 *
 * Idempotent by construction: it finds records by "contains a slash", so a
 * converted record drops out of the find. Re-running is a no-op, and an
 * interrupted run resumes simply by being run again.
 *
 * DRY RUN unless --apply.
 *
 * NOTE: this targets Music Arena Master on GALLO_FM_HOST. It is not a
 * MadStreamer script and must never be pointed at one — see the composer
 * repair that ran to completion against a backup copy nobody read.
 */
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')

/**
 * Every write is journalled before it happens: layout, recordId, before, after.
 *
 * "9/25" is only unambiguous because the whole field is month-first; a value
 * like "5/5/1969" carries no evidence of its own. If a day-first source ever
 * turns up inside this data, the original strings have to still exist
 * somewhere, and once converted the field itself can no longer tell you which
 * they were. This file is that somewhere.
 */
const LOG = 'tmp/fix-mam-dates.log.jsonl'
const journal = (row) => { try { appendFileSync(LOG, JSON.stringify(row) + '\n') } catch { /* never block a write on logging */ } }
const HOST = process.env.GALLO_FM_HOST
const USER = process.env.GALLO_FM_USER
const PASS = process.env.GALLO_FM_PASS
const BASE = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`

/** The fields to normalise. Albums::Year of Release is deliberately NOT here. */
const TARGETS = [
  { layout: 'Songs',  field: 'Original Release Date' },
  { layout: 'Albums', field: 'Release Date' },
]

const pad = (n) => String(n).padStart(2, '0')

/**
 * Convert one value, or return null to leave it untouched.
 * Returns null for empty, already-ISO, unrecognised shapes and impossible dates.
 */
export function toIso(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null

  let y, m, d
  let mm = v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)          // 1977/04/10
  if (mm) { [, y, m, d] = mm }
  else {
    mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)            // 9/25/1978
    if (mm) { [, m, d, y] = mm }
    else return null
  }

  const Y = +y, M = +m, D = +d
  if (M < 1 || M > 12 || D < 1 || D > 31) return null          // not a date we trust
  if (Y < 1900 || Y > 2100) return null

  const iso = `${Y}-${pad(M)}-${pad(D)}`
  return iso === v ? null : iso
}

async function main() {
  if (!HOST || !USER || !PASS) {
    console.error('GALLO_FM_HOST / GALLO_FM_USER / GALLO_FM_PASS must be set')
    process.exit(1)
  }
  console.log(`host ${HOST} · db "Music Arena Master" · ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  if (APPLY) { try { mkdirSync('tmp', { recursive: true }) } catch { /* already there */ } ; console.log(`journal → ${LOG}`) }
  console.log()

  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  const login = await (await fetch(BASE + '/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}',
  })).json()
  const tok = login?.response?.token
  if (!tok) { console.error('login failed:', JSON.stringify(login?.messages)); process.exit(1) }
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }

  try {
    for (const { layout, field } of TARGETS) {
      console.log(`════ ${layout}::${field}`)
      const skipped = new Map()
      let converted = 0, failed = 0, seen = 0, offset = 1

      for (;;) {
        // On a dry run we must page, because nothing drops out of the find.
        // On apply we always take the first page: converted rows stop matching,
        // so the next page of work is always at the top.
        const body = { query: [{ [field]: '*/*' }], limit: 200, offset: APPLY ? 1 : offset }
        const r = await (await fetch(`${BASE}/layouts/${layout}/_find`, {
          method: 'POST', headers: H, body: JSON.stringify(body),
        })).json()
        if (r?.messages?.[0]?.code === '401') break            // no more matches
        const rows = r?.response?.data || []
        if (!rows.length) break

        let convertedThisPage = 0
        for (const rec of rows) {
          seen++
          const before = rec.fieldData[field]
          const after  = toIso(before)
          if (after === null) {
            const shape = String(before ?? '').trim().replace(/\d/g, '#')
            const s = skipped.get(shape) || { count: 0, sample: String(before ?? '').trim() }
            s.count++; skipped.set(shape, s)
            continue
          }
          if (!APPLY) { if (converted < 5) console.log(`   e.g. ${String(before).padEnd(12)} → ${after}`); converted++; continue }
          try {
            journal({ layout, field, recordId: rec.recordId, before, after })
            const w = await (await fetch(`${BASE}/layouts/${layout}/records/${rec.recordId}`, {
              method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { [field]: after } }),
            })).json()
            if (w?.messages?.[0]?.code === '0') { converted++; convertedThisPage++ }
            else { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, w?.messages?.[0]?.message) }
          } catch (e) { failed++; if (failed < 5) console.warn('   FAIL', rec.recordId, e.message) }
          if (converted % 500 === 0) console.log(`   … ${converted} converted`)
        }

        if (APPLY) {
          // Every row on this page was unconvertible — paging past them is the
          // only way forward, otherwise the same page repeats for ever.
          if (convertedThisPage === 0) break
        } else {
          offset += 200
          if (offset > 40000) break
        }
      }

      console.log(`   scanned ${seen}, ${APPLY ? 'converted' : 'would convert'} ${converted}${failed ? `, FAILED ${failed}` : ''}`)
      if (skipped.size) {
        console.log('   left alone (unrecognised or already correct):')
        for (const [shape, s] of [...skipped.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)) {
          console.log(`      ${shape.padEnd(14)} ${String(s.count).padStart(6)}   e.g. ${JSON.stringify(s.sample)}`)
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
