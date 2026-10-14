/**
 * scripts/generate-covers.mjs — give MAM albums that have NO cover a generated one in their genre's style
 * (Ian, 2026-10-14: "use the genre styles, start with albums that have audio and when complete mark the comment field
 * Artwork Done, Start with 20").
 *
 * Per album (record ids in a JSON list): read the MAM album live and skip it unless it still has no artwork, its
 * catalogue is set and no other MAM album shares it; render the cover (lib/cover-styles.js, vinyl when no genre);
 * set it through the normal pipeline (lib/album-cover.js setAlbumCover → GMVi number, S3 artwork/<GMVi>.jpg, MAM
 * Artwork_S3_URL + Artwork_Vision_URL, MADStreamer Tape Files, original on Vision); then — only when MAM took it —
 * write "Artwork Done" into the album's Comment (appended if the Comment already holds text). Generated covers are
 * archived in their own Vision folder so real sleeves can replace them later.
 *
 *   VISION_COVER_FOLDER="/gallo-music-files-wavs/Digital Sleeves/Generated covers" node scripts/generate-covers.mjs <ids.json>
 */
import 'dotenv/config'
import fs from 'node:fs'
import { renderStyled, styleFor } from '../lib/cover-styles.js'
import { isRealCatalogue } from '../lib/cover-template.js'
import { setAlbumCover } from '../lib/album-cover.js'

const ids = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).map(String)
const OUT = process.env.HOME + '/Downloads/mam-covers/generated', LOG = process.env.HOME + '/Downloads/mam-covers/generate-log.jsonl'
fs.mkdirSync(OUT, { recursive: true })
if (!/Generated covers/.test(process.env.VISION_COVER_FOLDER || '')) { console.log('Set VISION_COVER_FOLDER to the Generated covers folder first'); process.exit(1) }

const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
let token
const login = async () => { token = (await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()).response.token }
async function call(method, path, body, retry = true) {
  const r = await (await fetch(MB + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) })).json()
  const code = r?.messages?.[0]?.code
  if (code === '952' && retry) { await login(); return call(method, path, body, false) }
  if (code === '401') return { data: [] }
  if (code !== '0') throw new Error(`FM ${code} ${r?.messages?.[0]?.message}`)
  return r.response
}
const blank = (v) => v == null || String(v).trim() === ''
await login()
const tally = {}
try {
  for (const id of ids) {
    const rec = { id, at: new Date().toISOString() }
    try {
      const a = (await call('GET', `/layouts/Albums/records/${id}`)).data[0].fieldData
      Object.assign(rec, { cat: a['Album Catalogue Number'], title: a['Album Title'], artist: a['Album Artist'], genre: a.Genre })
      if (!blank(a.Artwork_S3_URL) || !blank(a.Artwork_Vision_URL)) { rec.result = 'skipped — has a cover now'; continue }
      if (blank(a['Album Catalogue Number'])) { rec.result = 'skipped — no catalogue number'; continue }
      if (!isRealCatalogue(a['Album Catalogue Number']) && !process.env.ALLOW_ODD_CATALOGUE) { rec.result = 'skipped — catalogue number looks like Artist_Title (data fault)'; continue }
      const same = (await call('POST', '/layouts/Albums/_find', { query: [{ 'Album Catalogue Number': '==' + a['Album Catalogue Number'] }], limit: 5 })).data || []
      if (same.length !== 1) { rec.result = `skipped — ${same.length} MAM albums share this catalogue`; continue }
      rec.style = styleFor(a.Genre) || 'vinyl'
      const jpg = await renderStyled({ title: a['Album Title'], artist: a['Album Artist'], catalogue: a['Album Catalogue Number'], year: a['Year of Release'], label: a.Label, genre: a.Genre })
      fs.writeFileSync(`${OUT}/${String(a['Album Catalogue Number']).replace(/[^A-Za-z0-9]+/g, '_')}.jpg`, jpg)
      const res = await setAlbumCover(a['Album Catalogue Number'], jpg, { label: 'generated cover' })
      Object.assign(rec, { gmvi: res.gmvi, createdArtworkRecord: res.createdArtworkRecord, url: res.url, vision: res.vision?.path || res.vision?.reason, mam: res.mam, madstreamer: res.madstreamer?.ok ? 'linked' : (res.madstreamer?.reason || 'not on the site') })
      if (!res.mam?.ok || String(res.mam.recordId) !== id) { rec.result = 'cover uploaded but MAM not updated — Comment left alone'; continue }
      const now = (await call('GET', `/layouts/Albums/records/${id}`)).data[0].fieldData
      const comment = blank(now.Comment) ? 'Artwork Done' : (/Artwork Done/.test(now.Comment) ? now.Comment : `${now.Comment}\nArtwork Done`)
      await call('PATCH', `/layouts/Albums/records/${id}`, { fieldData: { Comment: comment } })
      const back = (await call('GET', `/layouts/Albums/records/${id}`)).data[0].fieldData
      rec.result = back.Artwork_S3_URL === res.url && /Artwork Done/.test(back.Comment) ? 'done' : 'CHECK — read-back differs'
      rec.commentBefore = now.Comment ?? ''
    } catch (e) { rec.result = 'failed — ' + e.message }
    finally {
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
      tally[rec.result.split(' —')[0]] = (tally[rec.result.split(' —')[0]] || 0) + 1
      console.log(`${(rec.result || '').padEnd(10).slice(0, 60)} | ${rec.cat} | ${rec.style || ''} | ${rec.gmvi || ''} | MadStreamer: ${rec.madstreamer || ''}`)
    }
  }
} finally { await fetch(`${MB}/sessions/${token}`, { method: 'DELETE' }).catch(() => {}) }
console.log(JSON.stringify(tally))
process.exit(0)
