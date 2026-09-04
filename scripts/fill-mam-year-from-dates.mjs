/**
 * scripts/fill-mam-year-from-dates.mjs — recover Albums::Year of Release from the
 * dates, for the rows fix-mam-year-of-release.mjs could not derive a year from.
 *
 * That script refused 183 albums because the field itself held no single year:
 * mostly "-0-0" and "09-0" (152 + 13 of them), plus truncated and text values.
 * The year is not gone though — it is sitting in the release dates, which are now
 * all ISO after the fix-mam-dates run.
 *
 * Two sources, in order of trust:
 *
 *   1. Albums::Release Date        the album's own date, same record
 *   2. Songs::Original Release Date  its tracks, joined on
 *                                   Albums::Album Catalogue Number == Songs::Album Catalogue
 *
 * For source 2 the year has to be UNANIMOUS across the tracks that have one. A
 * compilation whose tracks span 1969 and 1970 is exactly the case the earlier
 * script refused to guess at, and pulling a majority year here would be the same
 * guess wearing a different hat — those stay for a human.
 *
 * Only touches albums whose Year of Release is not already a bare year, so it can
 * never overwrite a good value. Journals every write. DRY RUN unless --apply.
 */
import 'dotenv/config'
import { appendFileSync, mkdirSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const HOST = process.env.GALLO_FM_HOST
const USER = process.env.GALLO_FM_USER
const PASS = process.env.GALLO_FM_PASS
const BASE = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const LOG  = 'tmp/fill-mam-year-from-dates.log.jsonl'

const journal = (row) => { try { appendFileSync(LOG, JSON.stringify(row) + '\n') } catch { /* never block a write on logging */ } }

/** The year in an ISO-ish date string, or null. */
const yearOf = (v) => {
  const m = String(v ?? '').trim().match(/^(\d{4})-\d{1,2}-\d{1,2}/)
  const y = m ? +m[1] : NaN
  return (y >= 1900 && y <= 2100) ? String(y) : null
}

const isBareYear = (v) => /^\d{4}$/.test(String(v ?? '').trim())

/**
 * A resolved year equal to THIS year is a load stamp, not a release.
 *
 * GMDA 2064 is "Music Inferno - The Indestructible Beat Tour1988-89" by
 * Mahlathini and the Mahotella Queens, on the Gallo Vault label — and its album
 * row and all five tracks carry 2026-05-07, the day the vault batch was
 * ingested. Writing "2026" there would be worse than leaving "-0-0": junk
 * announces itself, a plausible wrong year does not. These are reported, not
 * written.
 */
const THIS_YEAR = String(new Date().getFullYear())

async function main() {
  if (!HOST || !USER || !PASS) { console.error('GALLO_FM_* must be set'); process.exit(1) }
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
  const find = (layout, query, limit, offset = 1) =>
    fetch(`${BASE}/layouts/${layout}/_find`, { method: 'POST', headers: H, body: JSON.stringify({ query, limit, offset }) }).then(r => r.json())

  const stats = { fromAlbumDate: 0, fromTracks: 0, failed: 0 }
  const unresolved = []
  try {
    // Collect the albums still holding a non-year.
    const bad = []
    for (let offset = 1; ; offset += 200) {
      const r = await find('Albums', [{ 'Year of Release': '*' }], 200, offset)
      if (r?.messages?.[0]?.code === '401') break
      const rows = r?.response?.data || []
      if (!rows.length) break
      for (const rec of rows) {
        const v = rec.fieldData['Year of Release']
        if (String(v ?? '').trim() && !isBareYear(v)) bad.push(rec)
      }
      if (offset > 20000) break
    }
    console.log(`${bad.length} albums still hold a non-year in Year of Release\n`)

    for (const rec of bad) {
      const before = String(rec.fieldData['Year of Release'] ?? '').trim()
      const cat    = String(rec.fieldData['Album Catalogue Number'] ?? '').trim()
      const title  = String(rec.fieldData['Album Title'] ?? '').trim()

      // 1. the album's own release date
      let year = yearOf(rec.fieldData['Release Date'])
      let via  = 'Albums::Release Date'

      // 2. its tracks — but only if they agree
      if (!year && cat) {
        const s = await find('Songs', [{ 'Album Catalogue': '==' + cat }], 200)
        const years = new Set()
        for (const song of (s?.response?.data || [])) {
          const y = yearOf(song.fieldData['Original Release Date'])
          if (y) years.add(y)
        }
        if (years.size === 1) { year = [...years][0]; via = 'Songs::Original Release Date' }
        else if (years.size > 1) { unresolved.push({ cat, title, before, why: `tracks disagree: ${[...years].sort().join(', ')}` }); continue }
      }

      if (!year) { unresolved.push({ cat, title, before, why: 'no dated album row and no dated tracks' }); continue }
      if (year === THIS_YEAR) { unresolved.push({ cat, title, before, why: `date is ${THIS_YEAR} — a vault load stamp, not a release year` }); continue }

      if (via === 'Albums::Release Date') stats.fromAlbumDate++; else stats.fromTracks++
      if (!APPLY) {
        console.log(`   ${(cat || '(no cat)').padEnd(14)} ${JSON.stringify(before).padEnd(12)} → ${year}   via ${via}`)
        continue
      }
      try {
        journal({ layout: 'Albums', field: 'Year of Release', recordId: rec.recordId, catalogue: cat, before, after: year, via })
        const w = await (await fetch(`${BASE}/layouts/Albums/records/${rec.recordId}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { 'Year of Release': year } }),
        })).json()
        if (w?.messages?.[0]?.code !== '0') { stats.failed++; console.warn('   FAIL', cat, w?.messages?.[0]?.message) }
      } catch (e) { stats.failed++; console.warn('   FAIL', cat, e.message) }
    }

    console.log(`\n${APPLY ? 'filled' : 'would fill'} ${stats.fromAlbumDate + stats.fromTracks}` +
                `  (${stats.fromAlbumDate} from the album's own Release Date, ${stats.fromTracks} from its tracks)` +
                `${stats.failed ? ` · FAILED ${stats.failed}` : ''}`)
    console.log(`still unresolved: ${unresolved.length}`)
    for (const u of unresolved.slice(0, 25)) {
      console.log(`   ${(u.cat || '(no cat)').padEnd(14)} ${JSON.stringify(u.before).padEnd(14)} ${String(u.title).slice(0, 32).padEnd(32)} ${u.why}`)
    }
    if (unresolved.length > 25) console.log(`   … and ${unresolved.length - 25} more`)
    if (!APPLY) console.log('\nDRY RUN — nothing written. Add --apply')
  } finally {
    await fetch(BASE + '/sessions/' + tok, { method: 'DELETE', headers: H }).catch(() => {})
  }
}

main()
