/**
 * scripts/link-album-audio.mjs — point an album's songs at their Vision WAVs.
 *
 * The files land in a folder computed from the album, so there is no searching:
 * list that one folder and match its files to the album's tracks by normalised
 * title. Sequence position is deliberately NOT used — Vision lists
 * alphabetically and albums are often part-digitised, so position means nothing.
 *
 * Writes Audio_Vision_URL only where it is EMPTY. An existing link is left
 * alone; re-pointing audio is a separate decision from filling a gap.
 *
 *   node scripts/link-album-audio.mjs ALB-RMG1177            # dry run
 *   node scripts/link-album-audio.mjs ALB-RMG1177 --apply
 */
import 'dotenv/config'
import { visionListKeys } from '../lib/vision-drive.js'
import { visionFolderForAlbum } from '../lib/vision-destination.js'

const albumID = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!albumID) { console.error('usage: link-album-audio.mjs <AlbumID> [--apply]'); process.exit(1) }

const AUDIO = /\.(wav|flac|aiff?|mp3|m4a)$/i
const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
// leading track numbers are a filename habit, not part of the title
const titleFromFile = f => tn(String(f).replace(AUDIO, '').replace(/^\s*\d{1,3}[\s._-]+/, ''))

const base = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const s = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
const token = s.response.token
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
const find = async (layout, query, limit = 200) => {
  const j = await (await fetch(`${base}/layouts/${layout}/_find`, { method: 'POST', headers: H, body: JSON.stringify({ query, limit }) })).json()
  return j?.response?.data || []
}

const album = (await find('Albums', [{ AlbumID: '==' + albumID }], 1))[0]
if (!album) { console.error(`no album ${albumID}`); process.exit(1) }
const af = album.fieldData
const dest = visionFolderForAlbum({ artist: af['Album Artist'], title: af['Album Title'],
  catalogue: af['Album Catalogue Number'] || af['Reference Catalogue Number'] })
console.log(`${af['Album Artist']} — ${af['Album Title']}  [${af['Album Catalogue Number']}]`)
console.log(`folder: ${dest.folder}\n`)

// visionListKeys returns a Map of key -> size (NOT an array — .length is undefined)
const listed = await visionListKeys(dest.folder)
const files = [...listed.keys()].filter(k => AUDIO.test(k))
console.log(`audio files in that folder: ${files.length}`)
if (!files.length) { console.log('nothing to link'); process.exit(0) }

const songs = await find('Songs', [{ AlbumID: '==' + albumID }], 500)
console.log(`songs on the album: ${songs.length}\n`)

const byTitle = new Map()
for (const f of files) {
  const t = titleFromFile(f.split('/').pop())
  if (!byTitle.has(t)) byTitle.set(t, [])
  byTitle.get(t).push(f)
}

let linked = 0, already = 0, noMatch = 0, ambiguous = 0
const actions = []
for (const s of songs) {
  const g = s.fieldData
  if (String(g['Audio_Vision_URL'] || '').trim()) { already++; continue }
  const t = tn(g['Track Name'])
  const cands = byTitle.get(t) || []
  if (cands.length === 1) { actions.push({ rec: s, path: cands[0], title: g['Track Name'] }); linked++ }
  else if (cands.length > 1) { ambiguous++; console.log(`  ambiguous: "${g['Track Name']}" matches ${cands.length} files`) }
  else { noMatch++; console.log(`  no file for: "${g['Track Name'] || '(blank title)'}"`) }
}
const unusedFiles = files.filter(f => !actions.some(a => a.path === f))
console.log(`\nto link ${linked}, already linked ${already}, no match ${noMatch}, ambiguous ${ambiguous}`)
if (unusedFiles.length) {
  console.log(`files with no song: ${unusedFiles.length}`)
  for (const f of unusedFiles.slice(0, 10)) console.log(`   ${f.split('/').pop()}`)
}
for (const a of actions) console.log(`   link "${a.title}" -> ${a.path.split('/').pop()}`)

if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply'); process.exit(0) }
let ok = 0, fail = 0
for (const a of actions) {
  const w = await fetch(`${base}/layouts/Songs/records/${a.rec.recordId}`, { method: 'PATCH', headers: H,
    body: JSON.stringify({ fieldData: { 'Audio_Vision_URL': a.path, 'Audio_Truth': 'Vision' } }) })
  w.status === 200 ? ok++ : fail++
}
console.log(`\nlinked ${ok}, failed ${fail}`)
await fetch(base + '/sessions/' + token, { method: 'DELETE', headers: H })
