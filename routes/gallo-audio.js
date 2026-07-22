// routes/gallo-audio.js — serve a Gallo Catalogue record's audio, sourced from
// Vision (or its legacy URL), with NO Mountain Duck mount involved.
//
//   GET /api/gallo/audio/:recordId          → streams the WAV (Range-aware)
//   GET /api/gallo/audio/:recordId/resolve  → JSON: where the audio resolves to
//
// This is what a FileMaker web viewer points at instead of the native audio
// container, so the mount can be retired. Streams THROUGH Ingest because Vision
// uses a self-signed cert a browser/web-viewer would reject on a direct hit.
import { Router } from 'express'
import { Readable } from 'node:stream'
import { getGalloFieldData } from '../lib/fm-gallo.js'
import { resolveGalloAudio } from '../lib/gallo-vision.js'
import { visionOpen, visionStat } from '../lib/vision-drive.js'

const router = Router()

const CONTENT_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg' }
const typeFor = (name) => CONTENT_TYPES[(String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream'

// Inspect where a record's audio lives — handy for the UI / debugging. Public
// read of a resolution, no bytes.
router.get('/audio/:recordId/resolve', async (req, res) => {
  try {
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return res.status(404).json({ error: 'Record not found' })
    const r = resolveGalloAudio(f)
    if (r.ok && r.kind === 'vision') {
      const stat = await visionStat(r.path).catch(() => null)
      return res.json({ ...r, existsOnVision: !!stat, size: stat?.size ?? null })
    }
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/audio/:recordId', async (req, res) => {
  try {
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return res.status(404).json({ error: 'Record not found' })
    const r = resolveGalloAudio(f)
    if (!r.ok) return res.status(404).json({ error: `No resolvable audio (${r.reason})` })

    // Legacy http(s) home (digitalcupboard streaming) — redirect the client
    // straight there; those hosts serve their own valid certs.
    if (r.kind === 'url') return res.redirect(302, r.url)

    const range = req.headers.range
    const obj = await visionOpen(r.path, range)
    res.setHeader('Content-Type', typeFor(r.filename))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Disposition', `inline; filename="${(r.filename || 'audio').replace(/[\\"\x00-\x1f]/g, ' ')}"`)
    if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength))
    if (range && obj.ContentRange) { res.status(206); res.setHeader('Content-Range', obj.ContentRange) }

    Readable.fromWeb(obj.Body.transformToWebStream ? obj.Body.transformToWebStream() : obj.Body).pipe(res)
  } catch (e) {
    console.error('[gallo-audio] failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else res.destroy()
  }
})

export default router
