/**
 * scripts/isrc-gap-compare.mjs — where is an ISRC missing: MadStreamer, MAM, or the metadata cache?
 * Read-only (Ian, 2026-10-13: "run a comparison between MAM MadStreamer and Metadata cache looking for where
 * ISRC are missing in the databases").
 *
 *   MadStreamer  the Postgres mirror of API_Album_Songs (copied nightly ~03:00) — what the website runs on
 *   MAM          Music Arena Master Songs, read live (pages of 500, paced)
 *   cache        the metadata cache (Ingrooves extract + ISRC register, S3)
 * Pairing: MadStreamer ↔ MAM by catalogue + Filename (the proven key); either ↔ cache by catalogue + normalised
 * title, and only when that title is unique on the cache album. An ISRC that isn't 12 characters of the
 * CC-XXX-YY-NNNNN shape (e.g. "XX") counts as missing and is flagged.
 *
 *   node scripts/isrc-gap-compare.mjs [out.json]
 */
import 'dotenv/config'
import { writeFileSync, readFileSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { mirrorQuery } from '../lib/mirror-db.js'

const OUT = process.argv[2] || 'tmp/isrc-gap-compare.json'
const MAM_SAVE = 'tmp/isrc-gap-mam.json'          // the MAM scan, reused for 12 h so a rerun skips it
const PROGRESS = 'tmp/isrc-gap-progress.log'
const say = (m) => { const l = `${new Date().toISOString().slice(0, 19)} ${m}`; console.log(l); appendFileSync(PROGRESS, l + '\n') }
// every network step has a deadline: an S3 read once sat silent for 30 min
const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))])
const TO = () => AbortSignal.timeout(60000)
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tn = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const cat = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const fileKey = (f) => String(f || '').trim().toUpperCase().replace(/\.(WAV|MP3)$/i, '')
const raw = (v) => String(v ?? '').trim()
const isrc = (v) => { const s = raw(v).replace(/[\s-]/g, '').toUpperCase(); return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : '' }

// MAM, live
let token
async function login() {
  const r = await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}', signal: TO() })).json()
  token = r?.response?.token; if (!token) throw new Error('MAM login failed')
}
async function scan(layout) {
  const out = []
  for (let off = 1; ; off += 500) {
    let r
    for (let t = 0; ; t++) {
      try {
        r = await (await fetch(`${MB}/layouts/${encodeURIComponent(layout)}/records?_limit=500&_offset=${off}`, { headers: { Authorization: 'Bearer ' + token }, signal: TO() })).json()
      } catch (e) { if (t < 3) { say(`  MAM page ${off} ${e.message} — retrying`); await sleep(3000 * (t + 1)); continue } throw e }
      const code = r?.messages?.[0]?.code
      if (code === '952' && t < 2) { await login(); continue }
      if (code !== '0' && code !== '401' && t < 3) { await sleep(2000 * (t + 1)); continue }
      break
    }
    const rows = r?.response?.data || []; if (!rows.length) break
    out.push(...rows); if (off % 10000 === 1) say(`  MAM ${out.length.toLocaleString()}`)
    await sleep(250)
  }
  return out
}
say('START')
// cache first — the step that hung
const mc = await import('../lib/metadata-cache.js')
for (let t = 1; ; t++) {
  try { await within(180000, mc.loadMetadata(), 'metadata cache load'); if (mc.getStatus().count) break; throw new Error('cache came back empty') }
  catch (e) { say(`  cache try ${t}: ${e.message}`); if (t >= 3) throw e; await sleep(5000) }
}
say(`cache rows ${mc.getStatus().count.toLocaleString()} (from ${mc.getStatus().source})`)

// MAM, live (or the scan saved in the last 12 h)
let mam
if (existsSync(MAM_SAVE) && Date.now() - statSync(MAM_SAVE).mtimeMs < 12 * 3600e3) { mam = JSON.parse(readFileSync(MAM_SAVE, 'utf8')); say(`MAM songs ${mam.length.toLocaleString()} (saved scan)`) }
else {
  await login()
  mam = (await scan(process.env.MAM_FM_SONGS_LAYOUT || 'Songs')).map((s) => ({ id: s.recordId, cat: raw(s.fieldData['Album Catalogue']), file: raw(s.fieldData.Filename),
    title: raw(s.fieldData['Track Name']), seq: s.fieldData['Sequence Number'], isrcRaw: raw(s.fieldData.ISRC) }))
  await fetch(`${MB}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, signal: TO() }).catch(() => {})
  writeFileSync(MAM_SAVE, JSON.stringify(mam))
  say(`MAM songs ${mam.length.toLocaleString()}`)
}

// MadStreamer (mirror)
const { rows: ms } = await within(300000, mirrorQuery(`SELECT fm_record_id id, catalogue_no cat, raw->>'Filename' file, track_title title, track_seq seq, album_title album, track_artist artist,
  coalesce(raw->>'ISRC','') isrc_raw, visibility, nullif(trim(coalesce(raw->>'UPC','')),'') upc, (SELECT max(synced_at) FROM tracks) synced FROM tracks`), 'MadStreamer query')
say(`MadStreamer songs ${ms.length.toLocaleString()} (copy of ${ms[0]?.synced?.toISOString?.() || ms[0]?.synced})`)

const cacheBy = new Map()        // CAT|title → isrc ('' = several rows share that title: not usable)
for (const r of mc.getAllRows()) {
  const k = cat(r.catalogue) + '|' + tn(r.track_name); if (!r.catalogue || !r.track_name) continue
  cacheBy.set(k, cacheBy.has(k) ? null : isrc(r.isrc) || '')
}
const cacheIsrc = (c, t) => { const v = cacheBy.get(cat(c) + '|' + tn(t)); return v === undefined ? { found: false, isrc: '' } : { found: v !== null, isrc: v || '' } }

// pair MadStreamer ↔ MAM by catalogue + Filename
const mamBy = new Map()
for (const m of mam) { if (!m.file) continue; const k = cat(m.cat) + '|' + fileKey(m.file); if (!mamBy.has(k)) mamBy.set(k, m) }
const usedMam = new Set()
const rows = []
for (const s of ms) {
  const m = s.file ? mamBy.get(cat(s.cat) + '|' + fileKey(s.file)) : null
  if (m) usedMam.add(m.id)
  const c = cacheIsrc(s.cat, s.title)
  rows.push({ where: 'MadStreamer', cat: s.cat, album: s.album, title: s.title, artist: s.artist, seq: s.seq, file: s.file, msId: s.id, mamId: m?.id || null,
    ms: isrc(s.isrc_raw), msRaw: raw(s.isrc_raw), mam: m ? isrc(m.isrcRaw) : null, mamRaw: m?.isrcRaw ?? null, cache: c.found ? c.isrc : null, onSite: !!s.upc && (s.visibility || '').toLowerCase() !== 'hide' })
}
for (const m of mam) {                 // MAM songs with no MadStreamer twin
  if (usedMam.has(m.id)) continue
  const c = cacheIsrc(m.cat, m.title)
  rows.push({ where: 'MAM only', cat: m.cat, album: '', title: m.title, artist: '', seq: m.seq, file: m.file, msId: null, mamId: m.id,
    ms: null, msRaw: null, mam: isrc(m.isrcRaw), mamRaw: m.isrcRaw, cache: c.found ? c.isrc : null, onSite: false })
}
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), mamSongs: mam.length, msSongs: ms.length, cacheRows: mc.getStatus().count, rows }))
say(`DONE rows ${rows.length.toLocaleString()} → ${OUT}`)
process.exit(0)
