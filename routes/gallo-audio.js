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

// A self-contained HTML audio player for a record — this is what a FileMaker
// web viewer points at (one URL, consistent player across FM versions). The
// <audio> element streams from /audio/:recordId (Range-aware, so seeking works).
router.get('/player/:recordId', async (req, res) => {
  const id = String(req.params.recordId)
  let title = '', artist = '', note = ''
  try {
    const f = await getGalloFieldData(id)
    if (f) {
      title = f['Track Name'] || ''
      artist = f['Track Artist'] || f['Album Artist'] || ''
      const r = resolveGalloAudio(f)
      if (!r.ok) note = `No resolvable audio (${r.reason})`
      else if (r.kind === 'url') note = 'Legacy streaming source'
    } else { note = 'Record not found' }
  } catch (e) { note = e.message }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,Segoe UI,sans-serif;background:#f4f6fb;color:#1a1a2e}
  .box{display:flex;flex-direction:column;justify-content:center;gap:8px;height:100%;padding:14px 18px;box-sizing:border-box}
  .t{font-weight:600;font-size:15px;line-height:1.2}
  .a{color:#666;font-size:13px}
  audio{width:100%;margin-top:4px}
  .note{color:#b45309;font-size:12px}
</style></head><body>
<div class="box">
  <div class="t">${esc(title) || 'Track ' + esc(id)}</div>
  ${artist ? `<div class="a">${esc(artist)}</div>` : ''}
  ${note ? `<div class="note">${esc(note)}</div>` : `<audio controls preload="metadata" src="/api/gallo/audio/${encodeURIComponent(id)}"></audio>`}
</div></body></html>`)
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
