/**
 * scripts/mam-merge-cat2-dupes.mjs
 *
 * One release, two albums. CMS carries a parallel "ABC nnnnn" numbering in its
 * Cat:2 field, and because Cat:2 lives only on Tape Files it was never in the
 * song exports the merge was built from — so a release numbered both GALP 1298
 * and ABC 23214 became two albums in Music Arena Master.
 *
 * Keeps the album with more tracks, preferring the non-ABC number on a tie
 * (that is the one Ian's other systems use), repoints the other's songs to it,
 * deletes the emptied album, and recomputes Track Count.
 *
 * Album identity is re-read LIVE at merge time — the candidate list was built
 * from a cached copy, and albums have changed since.
 *
 *   node scripts/mam-merge-cat2-dupes.mjs            # dry run
 *   node scripts/mam-merge-cat2-dupes.mjs --apply
 */
import 'dotenv/config'
import fs from 'node:fs'

const APPLY = process.argv.includes('--apply')
const SC = '/private/tmp/claude-501/-Users-ianosrin-Downloads/0597787b-013a-4af1-be4b-854e6b947a83/scratchpad/'
const base = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`

let token = null
async function auth() {
  const a = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const j = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: a }, body: '{}' })).json()
  token = j?.response?.token
  if (!token) throw new Error('Music Arena Master auth failed')
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
    const j = await (await call(`/layouts/${layout}/records?_limit=1000&_offset=${off}`)).json()
    const r = j?.response?.data; if (!r?.length) break
    if (total === null) total = j.response.dataInfo.foundCount
    out.push(...r); off += r.length
  }
  return out
}

await auth()
const albums = await readAll('Albums')
const songs  = await readAll('Songs')
console.log(`live: albums ${albums.length.toLocaleString()}  songs ${songs.length.toLocaleString()}`)

const albById = new Map(albums.map(a => [a.fieldData.AlbumID, a]))
const songsBy = new Map()
for (const s of songs) {
  const k = s.fieldData.AlbumID
  if (!songsBy.has(k)) songsBy.set(k, [])
  songsBy.get(k).push(s)
}

const pairs = JSON.parse(fs.readFileSync(SC + 'mam-cat2-real.json', 'utf8')).filter(f => f.strong)
const isABC = c => /^ABC/i.test(String(c || '').trim())
const norm  = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const tnorm = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const plan = []
let vanished = 0
for (const f of pairs) {
  const A = albById.get(f.a.id), B = albById.get(f.b.id)
  if (!A || !B) { vanished++; continue }          // one side already merged or deleted
  const na = (songsBy.get(f.a.id) || []).length, nb = (songsBy.get(f.b.id) || []).length
  // more tracks wins; on a tie the non-ABC number wins
  let keep, drop, keepN, dropN
  if (na !== nb) [keep, drop, keepN, dropN] = na > nb ? [A, B, na, nb] : [B, A, nb, na]
  else {
    const aIsAbc = isABC(A.fieldData['Album Catalogue Number'] || A.fieldData['Reference Catalogue Number'])
    ;[keep, drop, keepN, dropN] = aIsAbc ? [B, A, nb, na] : [A, B, na, nb]
  }
  // The two albums are usually the SAME record twice, so most of the dropped
  // album's tracks already exist on the kept one — repointing them all would
  // give the survivor the album twice over. Match on ISRC first, then title.
  const kept = songsBy.get(keep.fieldData.AlbumID) || []
  const titles = new Set(kept.map(s => tnorm(s.fieldData['Track Name'])).filter(Boolean))
  const isrcs  = new Set(kept.map(s => norm(s.fieldData.ISRC)).filter(Boolean))
  const moving = [], dupes = []
  for (const s of songsBy.get(drop.fieldData.AlbumID) || []) {
    const t = tnorm(s.fieldData['Track Name']), i = norm(s.fieldData.ISRC)
    if ((i && isrcs.has(i)) || (t && titles.has(t))) dupes.push(s)
    else { moving.push(s); if (t) titles.add(t); if (i) isrcs.add(i) }
  }
  plan.push({ keep, drop, keepN, dropN, moving, dupes })
}
// never touch an album twice
const claimed = new Set(); const final = []
for (const p of plan) {
  const ids = [p.keep.fieldData.AlbumID, p.drop.fieldData.AlbumID]
  if (ids.some(i => claimed.has(i))) continue
  ids.forEach(i => claimed.add(i)); final.push(p)
}

console.log(`\npairs ${pairs.length} | already resolved ${vanished} | to merge ${final.length}`)
console.log(`albums to delete ${final.length}  songs to repoint ${final.reduce((s, p) => s + p.moving.length, 0)}  duplicate songs to delete ${final.reduce((s, p) => s + p.dupes.length, 0)}`)
for (const p of final.slice(0, 12)) {
  console.log(`  keep ${p.keep.fieldData.AlbumID.padEnd(17)}(${String(p.keepN).padStart(2)}) "${String(p.keep.fieldData['Album Title']).slice(0, 22)}"` +
              `   drop ${p.drop.fieldData.AlbumID.padEnd(17)}(${String(p.dropN).padStart(2)})  move ${p.moving.length} dup ${p.dupes.length}`)
}
if (final.length > 12) console.log(`  … and ${final.length - 12} more`)

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply'); process.exit(0) }

fs.writeFileSync(SC + 'mam-cat2-merge-backup.json', JSON.stringify(final.map(p => ({
  keep: p.keep.fieldData.AlbumID,
  droppedAlbum: { recordId: p.drop.recordId, fieldData: p.drop.fieldData },
  songs: [...p.moving, ...p.dupes].map(s => ({ recordId: s.recordId, MasterID: s.fieldData.MasterID, wasAlbumID: s.fieldData.AlbumID, fieldData: s.fieldData })),
})), null, 1))
console.log('\nbackup -> mam-cat2-merge-backup.json')

let moved = 0, deleted = 0, dupGone = 0, failed = 0
for (const p of final) {
  const keepId = p.keep.fieldData.AlbumID
  for (const s of p.moving) {
    const w = await call(`/layouts/Songs/records/${s.recordId}`, { method: 'PATCH', body: JSON.stringify({ fieldData: { AlbumID: keepId } }) })
    w.status === 200 ? moved++ : failed++
  }
  for (const s of p.dupes) {
    const d = await call(`/layouts/Songs/records/${s.recordId}`, { method: 'DELETE' })
    d.status === 200 ? dupGone++ : failed++
  }
  const w = await call(`/layouts/Albums/records/${p.drop.recordId}`, { method: 'DELETE' })
  w.status === 200 ? deleted++ : failed++
  await call(`/layouts/Albums/records/${p.keep.recordId}`, { method: 'PATCH',
    body: JSON.stringify({ fieldData: { 'Track Count': String(p.keepN + p.moving.length) } }) })
}
console.log(`\nsongs repointed ${moved}, duplicate songs deleted ${dupGone}, albums deleted ${deleted}, failed ${failed}`)
await call('/sessions/' + token, { method: 'DELETE' })
