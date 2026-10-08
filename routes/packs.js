// routes/packs.js — the Packs tab: publish Mad Mixer loop packs from a folder on any drive (Ian, 2026-10-08).
//
// The browser reads the chosen folder (one sub-folder per pack, WAVs exported from Mad Mixer), works out
// each loop's tempo, length and SHA-256, and drives these calls:
//
//   GET  /api/packs                 → { ok, layout: {ok, error?}, packs: [{ id, title, song, bpm, bars, loops, hidden }] }
//   POST /api/packs/check  { loops: [{ key, packId, file }] }
//                                   → { ok, loops: [{ key, onS3, s3Bytes, record: { recordId, url, visible } | null }] }
//   POST /api/packs/presign { key } → { ok, uploadUrl } — a 1-hour PUT straight from the browser to S3
//   POST /api/packs/record { …fields, key }
//                                   → { ok, action: 'created' | 'updated', recordId } — only once the WAV is
//                                     on S3 at exactly that size; never deletes, Visible set on create only
//
// Keys are always packs/<pack>/<sha10>-<name>.wav (lib/madmixer-packs.js PACK_KEY_RE) — nothing else in the
// bucket can be written from here.
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { headAnyKey, presignPutKey } from '../lib/s3-imports.js'
import { checkLayout, listLoops, groupPacks, upsertLoop, urlForPackKey, PACK_ID_RE, PACK_KEY_RE } from '../lib/madmixer-packs.js'

const router = Router()
const fail = (res, status, error) => res.status(status).json({ ok: false, error })
const text = (v, n = 300) => String(v ?? '').trim().slice(0, n)
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : NaN }

router.get('/', adminAuth, async (_req, res) => {
  try {
    const layout = await checkLayout()
    const packs = layout.ok ? groupPacks(await listLoops()) : []
    res.json({ ok: true, layout, packs })
  } catch (err) { fail(res, 502, err.message) }
})

router.post('/check', adminAuth, async (req, res) => {
  const loops = Array.isArray(req.body?.loops) ? req.body.loops.slice(0, 500) : null
  if (!loops) return fail(res, 400, 'loops missing')
  try {
    const records = await listLoops()
    const byFile = new Map(records.map((r) => [`${r.Pack_ID}\u0000${r.File_Name}`, r]))
    const out = []
    for (const l of loops) {
      const key = text(l.key, 400)
      if (!PACK_KEY_RE.test(key)) { out.push({ key, error: 'bad key' }); continue }
      const h = await headAnyKey(key)
      const r = byFile.get(`${text(l.packId, 80)}\u0000${text(l.file)}`)
      out.push({ key, onS3: h.exists, s3Bytes: h.size || 0,
        record: r ? { recordId: r.recordId, url: r.Audio_S3_URL, visible: String(r.Visible ?? '').trim() !== '0' } : null })
    }
    res.json({ ok: true, loops: out })
  } catch (err) { fail(res, 502, err.message) }
})

router.post('/presign', adminAuth, async (req, res) => {
  const key = text(req.body?.key, 400)
  if (!PACK_KEY_RE.test(key)) return fail(res, 400, 'Not a pack key (packs/<pack>/<sha>-<name>.wav)')
  try { res.json({ ok: true, uploadUrl: await presignPutKey(key, 'audio/wav') }) }
  catch (err) { fail(res, 502, err.message) }
})

router.post('/record', adminAuth, async (req, res) => {
  const b = req.body || {}
  const key = text(b.key, 400), m = PACK_KEY_RE.exec(key)
  const f = { key, Pack_ID: text(b.Pack_ID, 80), Pack_Title: text(b.Pack_Title), Pack_Song: text(b.Pack_Song), Loop_Label: text(b.Loop_Label, 40),
    File_Name: text(b.File_Name), BPM: num(b.BPM), Bars: num(b.Bars), Seconds: num(b.Seconds), Bytes: num(b.Bytes), Sort: num(b.Sort) }
  if (!m || m[1] !== f.Pack_ID || !PACK_ID_RE.test(f.Pack_ID)) return fail(res, 400, 'The key and Pack_ID don’t match')
  if (!f.Pack_Title || !f.Loop_Label || !f.File_Name) return fail(res, 400, 'Pack_Title, Loop_Label and File_Name are needed')
  if ([f.BPM, f.Bars, f.Seconds, f.Bytes, f.Sort].some(Number.isNaN)) return fail(res, 400, 'BPM, Bars, Seconds, Bytes and Sort must be numbers')
  try {
    const h = await headAnyKey(key)
    if (!h.exists) return fail(res, 409, 'The WAV isn’t on S3 yet — upload it first')
    if (h.size !== f.Bytes) return fail(res, 409, `The WAV on S3 is ${h.size} bytes, not ${f.Bytes}`)
    const r = await upsertLoop(f)
    console.log(`[packs] ${r.action} ${f.Pack_ID} / ${f.Loop_Label} (record ${r.recordId})`)
    res.json({ ok: true, ...r, url: urlForPackKey(key) })
  } catch (err) { fail(res, 502, err.message) }
})

export default router
