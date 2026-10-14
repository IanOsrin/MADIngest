/**
 * scripts/mam-songs-scan.mjs — every MAM song (live, pages of 500, paced) with the fields needed to judge an album's
 * metadata → tmp/mam-songs.json. Read-only. (Ian, 2026-10-14: generated covers only "where the metadata is also
 * complete especially ISRC and Barcode".)
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TO = () => AbortSignal.timeout(60000)
const F = ['Album Catalogue', 'AlbumID', 'Track Name', 'Track Artist', 'Sequence Number', 'ISRC', 'Filename', 'Audio_Vision_URL', 'Duration', 'Version']
let token
const login = async () => { token = (await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}', signal: TO() })).json())?.response?.token; if (!token) throw new Error('MAM login failed') }
await login()
const out = []
for (let off = 1; ; off += 500) {
  let r
  for (let t = 0; ; t++) {
    try { r = await (await fetch(`${MB}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: { Authorization: 'Bearer ' + token }, signal: TO() })).json() }
    catch (e) { if (t < 3) { await sleep(3000 * (t + 1)); continue } throw e }
    const code = r?.messages?.[0]?.code
    if (code === '952' && t < 2) { await login(); continue }
    if (code !== '0' && code !== '401' && t < 3) { await sleep(2000 * (t + 1)); continue }
    break
  }
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const s of rows) { const o = { id: s.recordId }; for (const k of F) o[k] = s.fieldData[k] ?? ''; out.push(o) }
  await sleep(250)
}
await fetch(`${MB}/sessions/${token}`, { method: 'DELETE', signal: TO() }).catch(() => {})
writeFileSync('tmp/mam-songs.json', JSON.stringify(out))
console.log(`MAM songs ${out.length} → tmp/mam-songs.json`)
process.exit(0)
