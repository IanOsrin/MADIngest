/**
 * scripts/madstreamer-consolidate-sides.mjs
 *
 * A release should exist once on the streamer. CMS is the tape vault, where an
 * A and a B side are genuinely separate reels; MADStreamer is the website, where
 * they are one album (Ian, 2026-08-31).
 *
 * 18 stems still carry variants — BL 308 alongside BL 308A and BL 308B, and
 * BL 186 alongside BL186 differing only by a space. Two different situations:
 *   - the variant's tracks DUPLICATE the kept record's  → delete the duplicates
 *   - the variant holds tracks the kept record lacks    → repoint them across
 * so nothing playable is lost and nothing is listed twice.
 *
 * Everything is backed up before a single delete.
 *
 *   node scripts/madstreamer-consolidate-sides.mjs            # dry run
 *   node scripts/madstreamer-consolidate-sides.mjs --apply
 */
import 'dotenv/config'
import fs from 'node:fs'

const APPLY = process.argv.includes('--apply')
const SC = '/private/tmp/claude-501/-Users-ianosrin-Downloads/0597787b-013a-4af1-be4b-854e6b947a83/scratchpad/'

const base = `https://${String(process.env.MADSTREAMER_FM_HOST).replace(/^https?:\/\//, '')}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MADSTREAMER_FM_DB)}`
let token = null
async function auth() {
  const a = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const j = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: a }, body: '{}' })).json()
  token = j?.response?.token
  if (!token) throw new Error('MADStreamer auth failed')
}
const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token })
async function call(p, o = {}, retry = true) {
  if (!token) await auth()
  const r = await fetch(base + p, { ...o, headers: H() })
  if (r.status === 401 && retry) { token = null; return call(p, o, false) }
  return r
}
async function readAll(layout) {
  const out = []; let off = 1, total = null
  while (total === null || off <= total) {
    const j = await (await call(`/layouts/${encodeURIComponent(layout)}/records?_limit=1000&_offset=${off}`)).json()
    const r = j?.response?.data; if (!r?.length) break
    if (total === null) total = j.response.dataInfo.foundCount
    out.push(...r); off += r.length
  }
  return out
}

const n  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const SIDE = /^(.*\d)\s*([A-Za-z])$/

await auth()
const tapes = await readAll('Tape Files Master')
const songs = await readAll('Song Files')
console.log(`tapes ${tapes.length.toLocaleString()}  songs ${songs.length.toLocaleString()}`)

const byRef = new Map()
for (const s of songs) {
  const k = n(s.fieldData['Reference Catalogue Number'])
  if (!byRef.has(k)) byRef.set(k, [])
  byRef.get(k).push(s)
}

// group tape records by their catalogue stem (side letter and spacing removed)
const stems = new Map()
for (const t of tapes) {
  const ref = String(t.fieldData['Reference Catalogue Number'] || '').trim()
  if (!ref) continue
  const m = SIDE.exec(ref)
  const key = m ? n(m[1]) : n(ref)
  if (!stems.has(key)) stems.set(key, [])
  stems.get(key).push({ rec: t, ref, songs: byRef.get(n(ref)) || [] })
}
const groups = [...stems.entries()].filter(([, v]) => v.length > 1 && new Set(v.map(x => x.ref)).size > 1)

const plan = []
for (const [stem, members] of groups) {
  // keep the record with the most tracks; ties go to the one without a letter
  const sorted = [...members].sort((a, b) =>
    b.songs.length - a.songs.length || (SIDE.test(a.ref) ? 1 : 0) - (SIDE.test(b.ref) ? 1 : 0))
  const keep = sorted[0], drop = sorted.slice(1)
  const keepTitles = new Set(keep.songs.map(s => tn(s.fieldData['Track Name'])).filter(Boolean))
  const keepIsrc   = new Set(keep.songs.map(s => n(s.fieldData.ISRC)).filter(Boolean))
  const move = [], remove = []
  for (const d of drop) for (const s of d.songs) {
    const t = tn(s.fieldData['Track Name']), i = n(s.fieldData.ISRC)
    if ((i && keepIsrc.has(i)) || (t && keepTitles.has(t))) remove.push(s)
    else { move.push(s); if (t) keepTitles.add(t); if (i) keepIsrc.add(i) }
  }
  plan.push({ stem, keep, drop, move, remove })
}

const tot = plan.reduce((a, p) => ({
  tapes: a.tapes + p.drop.length, move: a.move + p.move.length, remove: a.remove + p.remove.length }),
  { tapes: 0, move: 0, remove: 0 })
console.log(`\ngroups ${plan.length}  |  tape records to delete ${tot.tapes}  |  songs to repoint ${tot.move}  |  duplicate songs to delete ${tot.remove}`)
for (const p of plan) {
  console.log(`  ${p.stem.padEnd(12)} keep ${p.keep.ref}(${p.keep.songs.length})  drop ${p.drop.map(d => `${d.ref}(${d.songs.length})`).join(', ')}` +
              `  → move ${p.move.length}, delete ${p.remove.length}`)
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply'); process.exit(0) }

fs.writeFileSync(SC + 'mad-consolidate-backup.json', JSON.stringify(plan.map(p => ({
  stem: p.stem, keepRef: p.keep.ref,
  tapes: [p.keep, ...p.drop].map(x => ({ recordId: x.rec.recordId, fieldData: x.rec.fieldData })),
  songs: [...p.move, ...p.remove].map(s => ({ recordId: s.recordId, fieldData: s.fieldData })),
})), null, 1))
console.log('\nbackup written to mad-consolidate-backup.json')

let moved = 0, deleted = 0, tapesGone = 0, failed = 0
for (const p of plan) {
  for (const s of p.move) {
    const w = await call(`/layouts/Song%20Files/records/${s.recordId}`, { method: 'PATCH',
      body: JSON.stringify({ fieldData: { 'Reference Catalogue Number': p.keep.ref, 'Album Catalogue Number': p.keep.ref } }) })
    w.status === 200 ? moved++ : failed++
  }
  for (const s of p.remove) {
    const w = await call(`/layouts/Song%20Files/records/${s.recordId}`, { method: 'DELETE' })
    w.status === 200 ? deleted++ : failed++
  }
  for (const d of p.drop) {
    const w = await call(`/layouts/Tape%20Files%20Master/records/${d.rec.recordId}`, { method: 'DELETE' })
    w.status === 200 ? tapesGone++ : failed++
  }
  const total = p.keep.songs.length + p.move.length
  await call(`/layouts/Tape%20Files%20Master/records/${p.keep.rec.recordId}`, { method: 'PATCH',
    body: JSON.stringify({ fieldData: { 'Track Count': String(total) } }) })
}
console.log(`\nrepointed ${moved}, duplicate songs deleted ${deleted}, tape records deleted ${tapesGone}, failed ${failed}`)
await call('/sessions/' + token, { method: 'DELETE' })
