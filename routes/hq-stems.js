// routes/hq-stems.js — the HQ Stems tab: a catalogue song's studio stems, from Vision to Mad Mixer (Ian, 2026-10-08).
//
//   GET  /api/hq-stems                      → { ok, layout: {ok, error?}, songs: [{ songId, title, stems, hidden, labels }] }
//   GET  /api/hq-stems/songs?q=             → { ok, songs: [{ songId, title, artist, album, duration, hasMp3 }] } (MADMixer Songs)
//   GET  /api/hq-stems/preview?path=&song=  → { ok, stems: [{ path, file, label, bytes, seconds, format, key, status }] }
//                                             the WAVs in that Vision folder; status published | new | new audio
//   POST /api/hq-stems/publish { songId, songTitle, stems: [{ path, file, label, bytes, seconds, key, sort }] }
//                                           → { ok, jobId } — copies each WAV Vision → S3 (hqstems/…), checks the size,
//                                             then writes its HQ_Stems record; runs in the background
//   GET  /api/hq-stems/job/:id              → { ok, done, steps: [{ file, label, status }], error? }
//
// Vision is only READ here (visionList / visionOpen / the WAV header); nothing on Vision is written or deleted.
import { Router } from 'express'
import { randomUUID } from 'crypto'
import { adminAuth } from '../lib/admin-auth.js'
import { visionList, visionOpen, visionStatus } from '../lib/vision-drive.js'
import { readVisionWavInfo } from '../lib/wav-info.js'
import { headAnyKey, uploadStreamKey } from '../lib/s3-imports.js'
import { checkHqLayout, listHqStems, groupHq, searchSongs, upsertHqStem, hqKey, labelFor, ORDER, HQ_KEY_RE, urlForHqKey } from '../lib/madmixer-hq.js'

const router = Router()
const fail = (res, status, error) => res.status(status).json({ ok: false, error })
const text = (v, n = 300) => String(v ?? '').trim().slice(0, n)
const SONG_RE = /^\d{1,12}$/
const goodPath = (p) => typeof p === 'string' && p.startsWith('/') && !p.split('/').includes('..') && p.length < 1000

router.get('/', adminAuth, async (_req, res) => {
  try {
    const layout = await checkHqLayout()
    res.json({ ok: true, layout, songs: layout.ok ? groupHq(await listHqStems()) : [] })
  } catch (err) { fail(res, 502, err.message) }
})

router.get('/songs', adminAuth, async (req, res) => {
  try { res.json({ ok: true, songs: await searchSongs(req.query.q) }) }
  catch (err) { fail(res, 502, err.message) }
})

router.get('/preview', adminAuth, async (req, res) => {
  const path = text(req.query.path, 1000).replace(/\/+$/, ''), songId = text(req.query.song, 12)
  if (!goodPath(path)) return fail(res, 400, 'Choose a Vision folder')
  if (!SONG_RE.test(songId)) return fail(res, 400, 'Choose the song first')
  if (!visionStatus().configured) return fail(res, 503, 'Vision is not configured on this GalloIngest')
  try {
    const listing = await visionList(path)
    const wavs = (listing.entries || []).filter((e) => e.type !== 'dir' && /\.wav$/i.test(e.name) && !e.name.startsWith('.'))
    let records = [], warning = ''
    try { records = await listHqStems() } catch (e) { warning = `${e.message} — create the HQ_Stems table and layout in MADMixer before publishing` }
    const mine = new Map(records.filter((r) => String(r.Song_ID) === songId).map((r) => [r.File_Name, r]))
    const stems = []
    for (const w of wavs) {
      const vp = `${path}/${w.name}`
      let seconds = 0, format = ''
      try {
        const wi = await readVisionWavInfo(vp)
        if (wi?.info) { seconds = wi.info.durationSec || 0; format = [wi.info.sampleRateHz && `${wi.info.sampleRateHz / 1000} kHz`, wi.info.sampleSizeBits && `${wi.info.sampleSizeBits}-bit`, wi.info.channels === 1 ? 'mono' : wi.info.channels === 2 ? 'stereo' : ''].filter(Boolean).join(' · ') }
      } catch { /* header unreadable — still listed */ }
      const key = hqKey(songId, vp, w.size, w.modified, w.name)
      const rec = mine.get(w.name)
      let status = 'new'
      if (rec) {
        const h = await headAnyKey(key)
        status = rec.Audio_S3_URL === urlForHqKey(key) && h.exists && h.size === w.size ? 'published' : 'new audio'
      }
      stems.push({ path: vp, file: w.name, label: labelFor(w.name), bytes: w.size, seconds, format, key, status })
    }
    stems.sort((a, b) => ((ORDER.indexOf(a.label) + 1 || 99) - (ORDER.indexOf(b.label) + 1 || 99)) || a.file.localeCompare(b.file))
    res.json({ ok: true, path, stems, warning, others: (listing.entries || []).filter((e) => e.type !== 'dir').length - wavs.length })
  } catch (err) { fail(res, 502, err.message) }
})

// Publishing jobs (one Vision → S3 copy at a time; Vision reads ~5 MB/s, so a song's stems take a minute or more).
const jobs = new Map()
router.post('/publish', adminAuth, async (req, res) => {
  const b = req.body || {}, songId = text(b.songId, 12), songTitle = text(b.songTitle)
  const stems = Array.isArray(b.stems) ? b.stems.slice(0, 64) : []
  if (!SONG_RE.test(songId) || !stems.length) return fail(res, 400, 'A song and at least one stem are needed')
  const items = []
  for (const s of stems) {
    const key = text(s.key, 400), m = HQ_KEY_RE.exec(key)
    if (!m || m[1] !== songId) return fail(res, 400, `Bad key for ${text(s.file)}`)
    if (!goodPath(s.path) || !/\.wav$/i.test(s.path)) return fail(res, 400, `Bad Vision path for ${text(s.file)}`)
    const bytes = Number(s.bytes), seconds = Number(s.seconds), sort = Number(s.sort)
    if (!(bytes > 0) || !(seconds >= 0) || !(sort >= 0)) return fail(res, 400, `Bad numbers for ${text(s.file)}`)
    items.push({ key, path: s.path, file: text(s.file), label: text(s.label, 40) || labelFor(text(s.file)), bytes, seconds, sort })
  }
  try {   // the table must be there before anything is copied
    const layout = await checkHqLayout()
    if (!layout.ok) return fail(res, 409, layout.error + ' — create it in MADMixer first')
  } catch (err) { return fail(res, 502, err.message) }
  const id = randomUUID(), job = { done: false, error: null, steps: items.map((i) => ({ file: i.file, label: i.label, status: 'waiting' })) }
  jobs.set(id, job)
  setTimeout(() => jobs.delete(id), 6 * 60 * 60_000).unref?.()
  ;(async () => {
    for (const [n, it] of items.entries()) {
      const step = job.steps[n]
      try {
        let h = await headAnyKey(it.key)
        if (!(h.exists && h.size === it.bytes)) {
          step.status = 'copying from Vision…'
          const obj = await visionOpen(it.path)
          await uploadStreamKey(obj.Body, it.key, 'audio/wav', (loaded) => { step.status = `copying ${Math.round(loaded / it.bytes * 100)}%` })
          h = await headAnyKey(it.key)
          if (!(h.exists && h.size === it.bytes)) throw new Error(`S3 copy is ${h.size || 0} bytes, Vision's is ${it.bytes}`)
        }
        step.status = 'writing MADMixer…'
        const r = await upsertHqStem({ key: it.key, Song_ID: songId, Song_Title: songTitle, Stem_Label: it.label, File_Name: it.file,
          Vision_Path: it.path, Bytes: it.bytes, Seconds: Math.round(it.seconds * 1000) / 1000, Sort: it.sort })
        step.status = r.action === 'created' ? 'published' : 'updated'
        console.log(`[hq-stems] ${r.action} song ${songId} / ${it.label} (record ${r.recordId})`)
      } catch (err) { step.status = 'failed: ' + err.message }
    }
    job.done = true
  })().catch((err) => { job.error = err.message; job.done = true })
  res.json({ ok: true, jobId: id })
})

router.get('/job/:id', adminAuth, (req, res) => {
  const job = jobs.get(String(req.params.id))
  if (!job) return fail(res, 404, 'No such job (GalloIngest restarted?)')
  res.json({ ok: true, ...job })
})

export default router
