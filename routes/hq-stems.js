// routes/hq-stems.js — the HQ Stems tab: sets of studio stems on Vision, listed for Mad Mixer (Ian, 2026-10-08).
// A set is its own thing, like a loop pack — not tied to the song list ("there may never be a match").
//
// The stems stay in a dedicated Vision folder; MAD streams them to subscribers. Publishing only writes records.
//
//   GET  /api/hq-stems                      → { ok, layout: {ok, error?}, prefix, sets: [{ setId, title, stems, hidden, labels }] }
//   GET  /api/hq-stems/preview?path=        → { ok, setId, title, stems: [{ path, file, label, bytes, seconds, format, status }], warning }
//                                             the WAVs in that Vision folder (the set = the folder); status published | new | changed
//   POST /api/hq-stems/publish { setId, setTitle, stems: [{ path, file, label, bytes, seconds, sort }] }
//                                           → { ok, results: [{ file, action | error }] } — writes the HQ_Stems records
//
// Vision is only READ here (listing + each WAV's header); nothing on Vision is written, moved or deleted.
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionList, visionStatus } from '../lib/vision-drive.js'
import { readVisionWavInfo } from '../lib/wav-info.js'
import { checkHqLayout, listHqStems, groupHq, upsertHqStem, labelFor, byStemOrder, hqVisionPrefix, setIdFor } from '../lib/madmixer-hq.js'

const router = Router()
const fail = (res, status, error) => res.status(status).json({ ok: false, error })
const text = (v, n = 300) => String(v ?? '').trim().slice(0, n)
const SET_ID_RE = /^[a-z0-9-]{1,80}$/
const goodPath = (p) => typeof p === 'string' && p.startsWith('/') && !p.split('/').includes('..') && p.length < 1000
const outsideNote = (path) => {
  const prefix = hqVisionPrefix()
  if (!prefix) return 'The dedicated HQ folder isn’t set on this GalloIngest (MIXER_HQ_VISION_PREFIX) — make sure this folder is inside it, or Mad Mixer won’t play the stems.'
  return (path + '/').startsWith(prefix) ? '' : `This folder is outside the HQ stems folder (${prefix}) — Mad Mixer won’t play stems from here. Move them into it on Vision first.`
}

router.get('/', adminAuth, async (_req, res) => {
  try {
    const layout = await checkHqLayout()
    res.json({ ok: true, layout, prefix: hqVisionPrefix(), sets: layout.ok ? groupHq(await listHqStems()) : [] })
  } catch (err) { fail(res, 502, err.message) }
})

router.get('/preview', adminAuth, async (req, res) => {
  const path = text(req.query.path, 1000).replace(/\/+$/, '')
  if (!goodPath(path) || path.split('/').filter(Boolean).length < 2) return fail(res, 400, 'Choose the Vision folder that holds the stems')
  const folder = path.split('/').pop(), setId = setIdFor(folder)
  if (!visionStatus().configured) return fail(res, 503, 'Vision is not configured on this GalloIngest')
  try {
    const listing = await visionList(path)
    const wavs = (listing.entries || []).filter((e) => e.type !== 'dir' && /\.wav$/i.test(e.name) && !e.name.startsWith('.'))
    const warnings = []
    const outside = outsideNote(path); if (outside) warnings.push(outside)
    let records = []
    try { records = await listHqStems() } catch (e) { warnings.push(`${e.message} — create the HQ_Stems table and layout in MADMixer before publishing`) }
    const mine = new Map(records.filter((r) => String(r.Song_ID) === setId).map((r) => [r.File_Name, r]))
    const published = records.find((r) => String(r.Song_ID) === setId)
    const stems = []
    for (const w of wavs) {
      const vp = `${path}/${w.name}`
      let seconds = 0, format = ''
      try {
        const wi = await readVisionWavInfo(vp)
        if (wi?.info) { seconds = wi.info.durationSec || 0; format = [wi.info.sampleRateHz && `${wi.info.sampleRateHz / 1000} kHz`, wi.info.sampleSizeBits && `${wi.info.sampleSizeBits}-bit`, wi.info.channels === 1 ? 'mono' : wi.info.channels === 2 ? 'stereo' : ''].filter(Boolean).join(' · ') }
      } catch { /* header unreadable — still listed */ }
      const rec = mine.get(w.name)
      const status = !rec ? 'new' : (rec.Vision_Path === vp && Number(rec.Bytes) === w.size ? 'published' : 'changed')
      stems.push({ path: vp, file: w.name, label: rec?.Stem_Label || labelFor(w.name), bytes: w.size, seconds, format, status })
    }
    stems.sort(byStemOrder)
    res.json({ ok: true, path, setId, title: published?.Song_Title || folder, stems, warning: warnings.join('\n'), others: (listing.entries || []).filter((e) => e.type !== 'dir').length - wavs.length })
  } catch (err) { fail(res, 502, err.message) }
})

router.post('/publish', adminAuth, async (req, res) => {
  const b = req.body || {}, setId = text(b.setId, 80), setTitle = text(b.setTitle, 120)
  const stems = Array.isArray(b.stems) ? b.stems.slice(0, 64) : []
  if (!SET_ID_RE.test(setId) || !setTitle || !stems.length) return fail(res, 400, 'A set name and at least one stem are needed')
  const items = []
  for (const s of stems) {
    if (!goodPath(s.path) || !/\.wav$/i.test(s.path)) return fail(res, 400, `Bad Vision path for ${text(s.file)}`)
    const bytes = Number(s.bytes), seconds = Number(s.seconds), sort = Number(s.sort)
    if (!(bytes > 0) || !(seconds >= 0) || !(sort >= 0)) return fail(res, 400, `Bad numbers for ${text(s.file)}`)
    items.push({ path: s.path, file: text(s.file), label: text(s.label, 40) || labelFor(text(s.file)), bytes, seconds, sort })
  }
  const prefix = hqVisionPrefix()
  if (prefix && items.some((i) => !i.path.startsWith(prefix))) return fail(res, 400, `Every stem must be inside the HQ stems folder (${prefix})`)
  try {
    const layout = await checkHqLayout()
    if (!layout.ok) return fail(res, 409, layout.error + ' — create it in MADMixer first')
  } catch (err) { return fail(res, 502, err.message) }
  const results = []
  for (const it of items) {
    try {
      const r = await upsertHqStem({ Song_ID: setId, Song_Title: setTitle, Stem_Label: it.label, File_Name: it.file, Vision_Path: it.path,
        Bytes: it.bytes, Seconds: Math.round(it.seconds * 1000) / 1000, Sort: it.sort })
      results.push({ file: it.file, action: r.action })
      console.log(`[hq-stems] ${r.action} set ${setId} / ${it.label} (record ${r.recordId})`)
    } catch (err) { results.push({ file: it.file, error: err.message }) }
  }
  res.json({ ok: true, results })
})

export default router
