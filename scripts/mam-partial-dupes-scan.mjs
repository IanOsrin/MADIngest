/**
 * scripts/mam-partial-dupes-scan.mjs — read every MAM song live (pages of 500, paced) and keep the full record for
 * every catalogue where the same song title appears more than once → tmp/mam-partial-dupes.json. Read-only.
 * (Ian, 2026-10-14: "run the check across all 536" — albums where SOME songs are held twice.)
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TO = () => AbortSignal.timeout(60000)
const cat = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const nt = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
let token
const login = async () => { token = (await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}', signal: TO() })).json())?.response?.token; if (!token) throw new Error('MAM login failed') }
await login()
const all = []
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
  for (const s of rows) all.push({ id: s.recordId, ...s.fieldData })
  if (off % 25000 === 1) console.log(`  MAM ${all.length.toLocaleString()}`)
  await sleep(250)
}
await fetch(`${MB}/sessions/${token}`, { method: 'DELETE', signal: TO() }).catch(() => {})
const n = {}
for (const s of all) { const k = cat(s['Album Catalogue']) + '|' + nt(s['Track Name']); if (nt(s['Track Name'])) n[k] = (n[k] || 0) + 1 }
const dupCats = new Set(Object.entries(n).filter(([, v]) => v > 1).map(([k]) => k.split('|')[0]))
const keep = all.filter((s) => dupCats.has(cat(s['Album Catalogue'])))
writeFileSync('tmp/mam-partial-dupes.json', JSON.stringify({ at: new Date().toISOString(), total: all.length, records: keep }))
console.log(`MAM songs ${all.length.toLocaleString()} · catalogues with a repeated title ${dupCats.size} · records kept ${keep.length}`)
process.exit(0)
