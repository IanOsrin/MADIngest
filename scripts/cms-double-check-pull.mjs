/**
 * scripts/cms-double-check-pull.mjs — CMS 2024 Song Files where Statusx = "Double check", plus each song's state in
 * MAM (by CMS_recid link, else catalogue + Filename, else catalogue + title) and MadStreamer (mirror: by ISRC,
 * catalogue + Filename, catalogue + title) → tmp/cms-double-check.json. Read-only; a targeted _find, not a scan.
 * (Ian, 2026-10-14: "check cms 2024 where the field Statusx is marked Double check … status on Mam and Streamer")
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { getLayoutFields, findRecords } from '../lib/fm-cms2024.js'
import { mirrorQuery } from '../lib/mirror-db.js'

const known = await getLayoutFields()
const statusField = [...known].find((f) => f.toLowerCase() === 'statusx')
if (!statusField) { console.log('No Statusx field on the CMS layout. Fields like status:', [...known].filter((f) => /status/i.test(f))); process.exit(1) }
const cms = []
for (let off = 0; ; off += 500) {
  const { records, foundCount } = await findRecords({ [statusField]: '=="Double check"' }, { limit: 500, offset: off, timeoutMs: 60000 })
  cms.push(...records); if (off === 0) console.log(`CMS "${statusField}" = Double check: ${foundCount}`)
  if (cms.length >= foundCount || !records.length) break
}
if (!cms.length) {   // maybe not an exact match — show the values that exist
  const { records, foundCount } = await findRecords({ [statusField]: '*' }, { limit: 200, timeoutMs: 60000 })
  const vals = {}; for (const r of records) vals[r.fieldData[statusField]] = (vals[r.fieldData[statusField]] || 0) + 1
  console.log('No exact "Double check". Values seen in the first 200 of', foundCount, 'filled:', vals); process.exit(1)
}

// MAM — Songs records linked to these CMS records, or on the same catalogues
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const token = (await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()).response.token
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
const cats = [...new Set(cms.map((r) => String(r.fieldData['Album Catalogue Number'] || r.fieldData['Reference Catalogue Number'] || '').trim()).filter(Boolean))]
const mam = []
for (const c of cats) {
  const r = await (await fetch(`${MB}/layouts/Songs/_find`, { method: 'POST', headers: H, body: JSON.stringify({ query: [{ 'Album Catalogue': '==' + c }], limit: 300 }), signal: AbortSignal.timeout(30000) })).json()
  for (const x of r.response?.data || []) mam.push({ id: x.recordId, ...x.fieldData })
  await new Promise((s) => setTimeout(s, 120))
}
// CMS-linked MAM records on other catalogues
const linked = new Set(mam.map((m) => String(m.CMS_recid)))
for (const r of cms.filter((r) => !linked.has(String(r.recordId)))) {
  const x = await (await fetch(`${MB}/layouts/Songs/_find`, { method: 'POST', headers: H, body: JSON.stringify({ query: [{ CMS_recid: '==' + r.recordId }], limit: 5 }), signal: AbortSignal.timeout(30000) })).json()
  for (const y of x.response?.data || []) mam.push({ id: y.recordId, ...y.fieldData })
}
await fetch(`${MB}/sessions/${token}`, { method: 'DELETE' }).catch(() => {})

// MadStreamer (nightly mirror)
const { rows: ms } = await mirrorQuery(`SELECT fm_record_id::text id, catalogue_no cat, album_title album, track_title title, track_seq seq, raw->>'Filename' file,
  coalesce(raw->>'ISRC','') isrc, nullif(trim(coalesce(raw->>'UPC','')),'') upc, visibility, raw->>'Version' version, (s3_audio_url IS NOT NULL AND s3_audio_url <> '') has_audio,
  (s3_artwork_url IS NOT NULL AND s3_artwork_url <> '') has_art FROM tracks WHERE catalogue_no = ANY($1) OR raw->>'ISRC' = ANY($2)`,
  [cats, cms.map((r) => String(r.fieldData.ISRC || '').trim()).filter(Boolean)])
writeFileSync('tmp/cms-double-check.json', JSON.stringify({ at: new Date().toISOString(), statusField, cms: cms.map((r) => ({ id: r.recordId, ...r.fieldData })), mam, ms }))
console.log(`CMS ${cms.length} songs on ${cats.length} catalogues · MAM records looked at ${mam.length} · MadStreamer rows ${ms.length}`)
process.exit(0)
