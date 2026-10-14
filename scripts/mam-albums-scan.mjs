/**
 * scripts/mam-albums-scan.mjs — read every MAM album (Albums layout, pages of 500, paced) → tmp/mam-albums.json.
 * Read-only. (Ian, 2026-10-14: "can you see where there is no cover in MAM".)
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TO = () => AbortSignal.timeout(60000)
let token
const login = async () => { token = (await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}', signal: TO() })).json())?.response?.token; if (!token) throw new Error('MAM login failed') }
await login()
const all = []
for (let off = 1; ; off += 500) {
  let r
  for (let t = 0; ; t++) {
    try { r = await (await fetch(`${MB}/layouts/Albums/records?_limit=500&_offset=${off}`, { headers: { Authorization: 'Bearer ' + token }, signal: TO() })).json() }
    catch (e) { if (t < 3) { await sleep(3000 * (t + 1)); continue } throw e }
    const code = r?.messages?.[0]?.code
    if (code === '952' && t < 2) { await login(); continue }
    if (code !== '0' && code !== '401' && t < 3) { await sleep(2000 * (t + 1)); continue }
    break
  }
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const s of rows) { const f = { id: s.recordId }; for (const [k, v] of Object.entries(s.fieldData)) if (typeof v !== 'object') f[k] = v; all.push(f) }
  await sleep(250)
}
await fetch(`${MB}/sessions/${token}`, { method: 'DELETE', signal: TO() }).catch(() => {})
writeFileSync('tmp/mam-albums.json', JSON.stringify(all))
console.log(`MAM albums ${all.length} → tmp/mam-albums.json · fields: ${Object.keys(all[0] || {}).join(' | ')}`)
process.exit(0)
