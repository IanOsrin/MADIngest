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
import { getGalloFieldData, getGalloLayoutFieldSet, updateGalloRecord } from '../lib/fm-gallo.js'
import { resolveGalloAudio, resolveGalloAudioLive } from '../lib/gallo-vision.js'
import { visionOpen, visionStat } from '../lib/vision-drive.js'
import { parseWavHeader, buildSoundInfoBlock, hmsMillis, readVisionWavInfo } from '../lib/wav-info.js'

const router = Router()

// Optional shared-key gate. On the public Render service the endpoint streams
// master WAVs and record IDs are sequential, so set GALLO_AUDIO_KEY there and
// the FileMaker web viewer appends ?k=<key>. When the env var is unset (local
// dev) the gate is open. A wrong/missing key when required → 403.
const AUDIO_KEY = process.env.GALLO_AUDIO_KEY || ''
function keyOk(req) {
  if (!AUDIO_KEY) return true
  return String(req.query.k || '') === AUDIO_KEY
}

const CONTENT_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg' }
const typeFor = (name) => CONTENT_TYPES[(String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream'

// Inspect where a record's audio lives — handy for the UI / debugging. Public
// read of a resolution, no bytes.
router.get('/audio/:recordId/resolve', async (req, res) => {
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return res.status(404).json({ error: 'Record not found' })
    const r = await resolveGalloAudioLive(f)
    if (r.ok && r.kind === 'vision') {
      return res.json({ ...r, existsOnVision: r.exists === true })
    }
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Technical audio info (the Media_GetSoundInfo replacement) ───────────────
// FileMaker used to read duration/channels/sample size/sample rate off the
// mounted file via a plugin. Same numbers, no mount, no plugin: this reads the
// WAV header from the first 64KB of the Vision object (one Range request) and
// FileMaker fetches it with Insert from URL.
//   GET /audio/:recordId/info               → JSON
//   GET /audio/:recordId/info?format=text   → Media_GetSoundInfo-style block
//   GET /audio/:recordId/info?write=1       → ALSO store the block in the
//                                              record's "Audio details" field
router.get('/audio/:recordId/info', async (req, res) => {
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return res.status(404).json({ error: 'Record not found' })
    const r = await resolveGalloAudioLive(f)
    if (!r.ok) return res.status(404).json({ error: `No resolvable audio (${r.reason})` })

    // First 64KB + total size, from Vision or the legacy http(s) home.
    let wav = null, fileSize = null, modified = null
    if (r.kind === 'url') {
      const resp = await fetch(r.url, { headers: { Range: 'bytes=0-65535' } })
      if (!resp.ok) return res.status(502).json({ error: `Legacy URL fetch failed: HTTP ${resp.status}` })
      const buf = Buffer.from(await resp.arrayBuffer())
      const cr = resp.headers.get('content-range')
      fileSize = cr ? parseInt(cr.split('/')[1], 10) || null : (parseInt(resp.headers.get('content-length') || '', 10) || null)
      modified = resp.headers.get('last-modified') ? new Date(resp.headers.get('last-modified')).toISOString() : null
      wav = parseWavHeader(buf, fileSize)
    } else {
      if (r.exists === false) return res.status(404).json({ error: 'Audio file not found on Vision' })
      const read = await readVisionWavInfo(r.path)
      if (read) ({ info: wav, fileSize, modified } = read)
    }
    if (!wav) return res.status(415).json({ error: 'Not a parseable WAV header', filename: r.filename || null, fileSizeBytes: fileSize })

    const block = buildSoundInfoBlock(wav, { modified })

    // ?write=1 — store the block in the record's "Audio details" field, the
    // same home the Media_GetSoundInfo plugin filled. Field name varies by
    // capitalisation; write whichever variant the layout actually has.
    let wrote = null
    if (String(req.query.write || '') === '1') {
      const known = await getGalloLayoutFieldSet()
      const fieldName = ['Audio details', 'Audio Details', 'Audio_Details'].find(n => known.has(n))
      if (!fieldName) return res.status(422).json({ error: 'No "Audio details" field on the layout — add it in FileMaker first (same as Audio_URL)' })
      await updateGalloRecord(req.params.recordId, { [fieldName]: block })
      wrote = fieldName
    }

    const info = {
      ok: true,
      recordId:      req.params.recordId,
      filename:      r.filename || null,
      source:        r.kind === 'url' ? r.url : r.path,
      fileSizeBytes: fileSize,
      modified,
      ...wav,
      duration:      hmsMillis(wav.durationSec),
      ...(wrote ? { wroteField: wrote } : {}),
    }

    if (String(req.query.format || '').toLowerCase() === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      return res.send(block + '\n')
    }
    res.json(info)
  } catch (e) {
    console.error('[gallo-audio info] failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// A self-contained HTML audio player for a record — this is what a FileMaker
// web viewer points at (one URL, consistent player across FM versions). The
// <audio> element streams from /audio/:recordId (Range-aware, so seeking works).
router.get('/player/:recordId', async (req, res) => {
  if (!keyOk(req)) return res.status(403).send('Forbidden')
  const id = String(req.params.recordId)
  const kq = AUDIO_KEY ? `?k=${encodeURIComponent(req.query.k)}` : '' // propagate to the audio src
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
  ${note ? `<div class="note">${esc(note)}</div>` : `<audio controls preload="metadata" src="/api/gallo/audio/${encodeURIComponent(id)}${kq}"></audio>`}
</div></body></html>`)
})

router.get('/audio/:recordId', async (req, res) => {
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return res.status(404).json({ error: 'Record not found' })
    const r = await resolveGalloAudioLive(f)
    if (!r.ok) return res.status(404).json({ error: `No resolvable audio (${r.reason})` })

    // Legacy http(s) home (digitalcupboard streaming) — redirect the client
    // straight there; those hosts serve their own valid certs.
    if (r.kind === 'url') return res.redirect(302, r.url)
    if (r.exists === false) return res.status(404).json({ error: 'Audio file not found on Vision (name mismatch — no folder match)' })

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
