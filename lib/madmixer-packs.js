/**
 * lib/madmixer-packs.js — Mad Mixer's loop packs in the MADMixer database (Ian, 2026-10-08).
 *
 * MADMixer (FM Cloud, beside MadStreamer) has a table Pack_Loops with a layout "Packs": one record per
 * loop — Pack_ID, Pack_Title, Pack_Song, Loop_Label, File_Name, BPM, Bars, Seconds, Bytes, Audio_S3_URL,
 * Sort, Visible (0 hides it). MAD reads that layout and hands the packs to Mad Mixer (subscribers only).
 * The WAVs live in S3 under packs/<Pack_ID>/<first 10 hex of the SHA-256>-<file name> — a new name for
 * new audio, so the media CDN (30-day cache) never plays an old copy. The same naming as the Mad Mixer
 * repo's scripts/publish-packs.mjs, so either tool can publish the same pack.
 *
 * Writes only through upsertLoop(): find by Pack_ID + File_Name, update it, or create it (Visible 1 on
 * create only — a loop hidden in FileMaker stays hidden). Never deletes.
 *
 * Credentials: MADMIXER_FM_USER/_PASS, else the MadStreamer / Gallo pair (the same FM Cloud account).
 */
const env = process.env
const HOST = (env.MADMIXER_FM_HOST || env.MADSTREAMER_FM_HOST || 'digitalcupboard.fmcloud.fm').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const DB = env.MADMIXER_FM_DB || 'MADMixer'
const LAYOUT = env.MADMIXER_FM_PACKS_LAYOUT || 'Packs'
const USER = env.MADMIXER_FM_USER || env.MADSTREAMER_FM_USER || env.GALLO_FM_USER
const PASS = env.MADMIXER_FM_PASS || env.MADSTREAMER_FM_PASS || env.GALLO_FM_PASS
const base = `https://${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const L = `/layouts/${encodeURIComponent(LAYOUT)}`

export const PACK_FIELDS = ['Pack_ID', 'Pack_Title', 'Pack_Song', 'Loop_Label', 'File_Name', 'BPM', 'Bars', 'Seconds', 'Bytes', 'Audio_S3_URL', 'Sort', 'Visible']
export const S3_BASE = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/'
export const PACK_ID_RE = /^[a-z0-9-]{1,80}$/
export const PACK_KEY_RE = /^packs\/([a-z0-9-]{1,80})\/[0-9a-f]{10}-[A-Za-z0-9 ._-]{1,200}\.wav$/
export const urlForPackKey = (key) => S3_BASE + key.split('/').map(encodeURIComponent).join('/')

let token = null, tokenAt = 0
async function getToken() {
  if (token && Date.now() - tokenAt < 12 * 60_000) return token
  if (!USER || !PASS) throw new Error('MADMixer credentials not set (MADMIXER_FM_USER/_PASS or GALLO_FM_USER/_PASS)')
  const r = await fetch(`${base}/sessions`, { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') }, body: '{}' })
  const j = await r.json().catch(() => ({}))
  if (!j.response?.token) throw new Error('MADMixer sign-in failed: ' + (j.messages?.[0]?.message || r.status))
  token = j.response.token; tokenAt = Date.now()
  return token
}
async function fm(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` }, body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    const code = String(j.messages?.[0]?.code ?? '')
    if (code === '952') { token = null; continue }   // session expired
    return { code, message: j.messages?.[0]?.message || `HTTP ${r.status}`, response: j.response || {} }
  }
  throw new Error('MADMixer session could not be renewed')
}

// The Packs layout is there, with every field ON it (the Data API silently drops fields that aren't).
export async function checkLayout() {
  const m = await fm('GET', L)
  if (m.code !== '0') return { ok: false, error: `MADMixer "${LAYOUT}" layout: ${m.message}` }
  const have = new Set((m.response.fieldMetaData || []).map((f) => f.name))
  const missing = PACK_FIELDS.filter((f) => !have.has(f))
  return missing.length ? { ok: false, error: `Not on the "${LAYOUT}" layout: ${missing.join(', ')}` } : { ok: true }
}

// Every pack record (a few hundred at most).
export async function listLoops() {
  const out = []
  for (let off = 1; ; off += 500) {
    const r = await fm('GET', `${L}/records?_offset=${off}&_limit=500`)
    if (r.code === '401') break                                   // no records
    if (r.code !== '0') throw new Error(`MADMixer packs: ${r.message}`)
    out.push(...(r.response.data || []).map((d) => ({ recordId: d.recordId, ...d.fieldData })))
    if ((r.response.data || []).length < 500) break
  }
  return out
}

// Packs as the Mixer sees them, for the tab's "In Mad Mixer now" list.
export function groupPacks(loops) {
  const by = new Map()
  for (const l of loops) {
    const id = String(l.Pack_ID || '').trim()
    if (!by.has(id)) by.set(id, { id, title: l.Pack_Title || id, song: l.Pack_Song || '', bpm: Number(l.BPM) || 0, bars: Number(l.Bars) || 0, loops: 0, hidden: 0, sort: Infinity })
    const p = by.get(id)
    p.loops++; if (String(l.Visible ?? '').trim() === '0') p.hidden++
    p.sort = Math.min(p.sort, Number(l.Sort) || 9999)
  }
  // sortBase: the pack's hundreds (101–199 → 100), so a re-published pack keeps its place in the Mixer's list
  return [...by.values()].sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title)).map(({ sort, ...p }) => ({ ...p, sortBase: Number.isFinite(sort) ? Math.floor(sort / 100) * 100 : 0 }))
}

// Create or update one loop's record. fields: everything but Visible (and Audio_S3_URL comes from key).
export async function upsertLoop(f) {
  const fields = {
    Pack_ID: f.Pack_ID, Pack_Title: f.Pack_Title, Pack_Song: f.Pack_Song, Loop_Label: f.Loop_Label, File_Name: f.File_Name,
    BPM: f.BPM, Bars: f.Bars, Seconds: f.Seconds, Bytes: f.Bytes, Audio_S3_URL: urlForPackKey(f.key), Sort: f.Sort,
  }
  const q = (v) => `=="${String(v).replace(/"/g, '\\"')}"`
  const found = await fm('POST', `${L}/_find`, { query: [{ Pack_ID: q(f.Pack_ID), File_Name: q(f.File_Name) }], limit: 2 })
  if (found.code === '0' && found.response.data?.length) {
    const id = found.response.data[0].recordId
    const r = await fm('PATCH', `${L}/records/${id}`, { fieldData: fields })
    if (r.code !== '0') throw new Error(`update ${f.File_Name}: ${r.message}`)
    return { action: 'updated', recordId: id }
  }
  if (found.code !== '401' && found.code !== '0') throw new Error(`find ${f.File_Name}: ${found.message}`)
  const r = await fm('POST', `${L}/records`, { fieldData: { ...fields, Visible: 1 } })
  if (r.code !== '0') throw new Error(`create ${f.File_Name}: ${r.message}`)
  return { action: 'created', recordId: r.response.recordId }
}
