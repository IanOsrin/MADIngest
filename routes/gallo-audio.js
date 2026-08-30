// routes/gallo-audio.js — serve a Gallo Catalogue record's audio, sourced from
// Vision (or its legacy URL), with NO Mountain Duck mount involved.
//
//   GET /api/gallo/audio/:recordId          → streams the WAV (Range-aware)
//   GET /api/gallo/audio/:recordId/resolve  → JSON: where the audio resolves to
//
// This is what a FileMaker web viewer points at instead of the native audio
// container, so the mount can be retired. Streams THROUGH Ingest because Vision
// uses a self-signed cert a browser/web-viewer would reject on a direct hit.
import express, { Router } from 'express'
import sharp from 'sharp'
import { Readable } from 'node:stream'
import { getGalloFieldData, getGalloLayoutFieldSet, updateGalloRecord, reloadGalloLayoutFields } from '../lib/fm-gallo.js'
import { resolveGalloAudio, resolveGalloAudioLive } from '../lib/gallo-vision.js'
import { visionOpen, visionStat, visionUploadFile } from '../lib/vision-drive.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseWavHeader, buildSoundInfoBlock, hmsMillis, readVisionWavInfo } from '../lib/wav-info.js'
import { wavBufferToMp3 } from '../lib/audio-convert.js'
import { uploadMp3ByGcat, uploadArtworkByGmvi, artworkKeyForGmvi, headAnyKey,
         urlForKey, keyFromS3Url, downloadByUrl, listKeysWithPrefix,
         uploadAnyKey, writeArtworkDerivatives } from '../lib/s3-imports.js'

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
      reloadGalloLayoutFields() // pick up fields added in FM since boot
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

// ── WAV → MP3 → S3 (replaces the localhost:8765 convert helper) ─────────────
// The old FM batch script sent a moviemac: mount path to a local helper app.
// Same contract, no mount: FileMaker sends just the record ID; we resolve the
// WAV like playback does (Audio_URL → Vision), convert with ffmpeg, upload to
// s3 mp3/<Filename>.mp3 and return { ok:1, s3_url } for the script to store
// in the File URL field (NOT Audio_URL — that's the Vision master reference).
// Errors come back as { ok:0, step, error }, the shape the script logs.
//   GET /audio/:recordId/convert-mp3
const CONVERT_MAX_MB = Number(process.env.MP3_CONVERT_MAX_MB || 700)

router.get('/audio/:recordId/convert-mp3', async (req, res) => {
  let step = 'auth'
  const t0 = Date.now()
  const fail = (status, error) => res.status(status).json({ ok: 0, step, error })
  try {
    if (!keyOk(req)) return fail(403, 'Forbidden')

    step = 'record'
    const f = await getGalloFieldData(req.params.recordId)
    if (!f) return fail(404, 'Record not found')

    step = 'filename'
    const base = String(f['Filename'] || '').trim().replace(/\.wav$/i, '')
    if (!base) return fail(422, 'Filename field is empty — enter it before converting (it names the S3 key mp3/<Filename>.mp3)')

    step = 'resolve'
    const r = await resolveGalloAudioLive(f)
    if (!r.ok) return fail(404, `No resolvable audio (${r.reason})`)
    if (r.kind === 'vision' && r.exists === false) return fail(404, 'Audio file not found on Vision')

    step = 'download'
    let wavBuf
    if (r.kind === 'url') {
      const resp = await fetch(r.url)
      if (!resp.ok) return fail(502, `Source URL fetch failed: HTTP ${resp.status}`)
      wavBuf = Buffer.from(await resp.arrayBuffer())
    } else {
      const stat = await visionStat(r.path)
      if (stat?.size && stat.size > CONVERT_MAX_MB * 1e6) return fail(413, `Source is ${Math.round(stat.size / 1e6)}MB — over the ${CONVERT_MAX_MB}MB conversion cap`)
      const obj = await visionOpen(r.path)
      wavBuf = Buffer.from(await obj.Body.transformToByteArray())
    }

    step = 'convert'
    const mp3Buf = await wavBufferToMp3(wavBuf)

    step = 'upload'
    const { key, url } = await uploadMp3ByGcat(mp3Buf, base)

    console.log(`[gallo-audio convert] ${req.params.recordId} ${base}: ${Math.round(wavBuf.length / 1e6)}MB WAV → ${Math.round(mp3Buf.length / 1e6)}MB MP3 → ${key} in ${Math.round((Date.now() - t0) / 1000)}s`)
    res.json({ ok: 1, s3_key: key, s3_url: url, base, source: r.kind === 'url' ? r.url : r.path,
               wav_bytes: wavBuf.length, mp3_bytes: mp3Buf.length, seconds: Math.round((Date.now() - t0) / 1000) })
  } catch (e) {
    console.error(`[gallo-audio convert] ${req.params.recordId} failed at ${step}:`, e.message)
    fail(500, e.message)
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

// ── Serve any Vision object by PATH (the master-database web viewers) ───────
// The :recordId routes above resolve through a Gallo Catalogue record, so they
// can only serve tracks that HAVE one. The consolidated master database stores
// the Vision path itself and covers 5,800+ CMS-recovered files no Catalogue
// record points at — plus album artwork, which was never a Catalogue field.
// These take the path directly. Same shared-key gate, same reason for
// streaming through Ingest (Vision's self-signed cert), reads jailed to the
// media buckets, and no write path exists here.
const VISION_READ_BUCKETS = ['gallo-music-files-wavs', 'gallo-digital-cupboard']
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }
const mediaTypeFor = (name) => {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  return CONTENT_TYPES[ext] || IMAGE_TYPES[ext] || 'application/octet-stream'
}
function visionPathOk(rel) {
  let clean = String(rel || '').trim()
  if (!clean) return null
  // A FileMaker web viewer re-encodes a URL that GetAsURLEncoded already
  // encoded, so the value arrives as "%2Fgallo-music-files-wavs%2F…" — one
  // decode short. A real path always ends up starting with "/", so keep
  // decoding until it does (bounded, and never touching a path that already
  // looks decoded, so a literal % in a filename survives).
  for (let i = 0; i < 3 && !clean.startsWith('/') && /%[0-9A-Fa-f]{2}/.test(clean); i++) {
    try {
      const dec = decodeURIComponent(clean)
      if (dec === clean) break
      clean = dec.trim()
    } catch { break }
  }
  if (!clean.startsWith('/')) clean = '/' + clean
  if (clean.includes('..')) return null
  const bucket = clean.split('/').filter(Boolean)[0]
  return VISION_READ_BUCKETS.includes(bucket) ? clean : null
}

// GET /api/gallo/vision-media?path=/bucket/folder/file.wav[&k=KEY]
// Streams audio OR artwork inline, Range-aware so <audio> can seek.
router.get('/vision-media', async (req, res) => {
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const rel = visionPathOk(req.query.path)
    if (!rel) return res.status(400).json({ error: 'A path inside a Vision media bucket is required' })
    const filename = rel.split('/').filter(Boolean).pop() || 'file'

    const range = req.headers.range
    const obj = await visionOpen(rel, range)
    res.setHeader('Content-Type', mediaTypeFor(filename))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[\\"\x00-\x1f]/g, ' ')}"`)
    if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength))
    if (range && obj.ContentRange) { res.status(206); res.setHeader('Content-Range', obj.ContentRange) }

    Readable.fromWeb(obj.Body.transformToWebStream ? obj.Body.transformToWebStream() : obj.Body).pipe(res)
  } catch (e) {
    console.error('[vision-media] failed:', e.message)
    if (!res.headersSent) res.status(/not found|NoSuchKey/i.test(e.message) ? 404 : 500).json({ error: e.message })
    else res.destroy()
  }
})

// GET /api/gallo/vision-player?path=…[&title=…&artist=…&k=KEY]
// A whole web-viewer page: audio gets transport controls, images render to fit.
router.get('/vision-player', async (req, res) => {
  if (!keyOk(req)) return res.status(403).send('Forbidden')
  const rel = visionPathOk(req.query.path)
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (!rel) {
    // Say WHY rather than just "no media" — a web viewer is a black box, and
    // "the path never arrived" and "the path was rejected" look identical
    // from the outside.
    const raw = req.query.path
    const why = raw === undefined ? 'no path parameter arrived'
      : Array.isArray(raw) ? 'the path parameter arrived more than once'
      : !String(raw).trim() ? 'the path parameter was empty'
      : String(raw).includes('..') ? 'the path contains ".."'
      : `bucket "${String(raw).split('/').filter(Boolean)[0] || '?'}" is not a Vision media bucket`
    console.warn('[vision-player] rejected:', why, '| raw:', JSON.stringify(raw)?.slice(0, 300))
    return res.send(`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:12px;font:12px -apple-system,Segoe UI,sans-serif;color:#777">
<div style="color:#b45309;font-weight:600;margin-bottom:6px">No media for this record</div>
<div>${esc(why)}</div>
<div style="margin-top:8px;color:#999;word-break:break-all">received: ${esc(raw === undefined ? '(nothing)' : String(raw).slice(0, 300))}</div>
</body>`)
  }
  const filename = rel.split('/').filter(Boolean).pop() || ''
  const isImage = /\.(jpe?g|png|gif|webp|tiff?)$/i.test(filename)
  const src = `/api/gallo/vision-media?path=${encodeURIComponent(rel)}${AUDIO_KEY ? `&k=${encodeURIComponent(String(req.query.k || ''))}` : ''}`
  const title = esc(req.query.title) || esc(decodeURIComponent(filename.replace(/\.\w+$/, '')))
  const artist = esc(req.query.artist)
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,Segoe UI,sans-serif;background:#f4f6fb;color:#1a1a2e}
  .box{display:flex;flex-direction:column;justify-content:center;gap:8px;height:100%;padding:14px 18px;box-sizing:border-box}
  .t{font-weight:600;font-size:15px;line-height:1.2}
  .a{color:#666;font-size:13px}
  audio{width:100%;margin-top:4px}
  .img{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#111}
  .img img{max-width:100%;max-height:100%;object-fit:contain}
</style></head><body>
${isImage
  ? `<div class="img"><img src="${src}" alt="${title}"></div>`
  : `<div class="box"><div class="t">${title}</div>${artist ? `<div class="a">${artist}</div>` : ''}<audio controls preload="metadata" src="${src}"></audio></div>`}
</body></html>`)
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

// ── artwork copy: Vision ⇄ S3 ───────────────────────────────────────────────
// Ian's Album layout shows a Vision viewer and an S3 viewer side by side; about
// half the albums have a cover on only one side. These endpoints copy it across
// so a FileMaker button can fill the empty panel. FileMaker cannot sign S3
// requests itself (SigV4 by hand, and the secret would have to live in a field),
// so the copy happens here where the credentials already are.
//
// BOTH directions are ADD-ONLY. Vision has no versioning or trash, and on the
// S3 side the CDN caches a 403 from a missing object — so an accidental
// overwrite is unrecoverable in one direction and self-inflicted cache poison
// in the other. An existing destination is a 409, never a silent replace.

// New artwork codes are the GMVin series (seeded at 100000), kept separate from
// the legacy GMVi / GMVic / GMViv keys so a mis-set counter can never target an
// existing cover. FileMaker allocates the number — the master file is local, so
// this server cannot read a counter out of it.
const GMVIN_RE = /^GMVin\d{6,}$/
const VISION_ART_ROOT = process.env.VISION_ART_COPY_ROOT
  || '/gallo-music-files-wavs/Digital Sleeves/Copied from S3'

/** Filename-safe, and close to the existing "Artist_Album_CAT" sleeve naming. */
function sleeveName(artist, album, cat) {
  const part = (s) => String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
  const bits = [part(artist), part(album), part(cat)].filter(Boolean)
  if (!bits.length) return null
  return bits.join('_').slice(0, 150)
}

// GET /api/gallo/artwork-next-code — highest GMVin in the bucket, +1.
// Re-syncs the FileMaker counter from the bucket after a restore or a crash.
router.get('/artwork-next-code', async (req, res) => {
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const keys = await listKeysWithPrefix('artwork/GMVin')
    let max = 99999
    for (const k of keys) {
      const m = k.match(/artwork\/GMVin(\d+)\./)
      if (m) max = Math.max(max, Number(m[1]))
    }
    res.json({ ok: true, count: keys.length, highest: max, nextCode: `GMVin${max + 1}` })
  } catch (e) {
    console.error('[artwork-next-code] failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/gallo/artwork-copy
//   { direction: "vision-to-s3", src: "/gallo-music-files-wavs/…jpg", code: "GMVin100000" }
//   { direction: "s3-to-vision", src: "https://…/artwork/GMVi123.jpg", artist, album, cat }
// Returns { ok, url } — the URL to write back into the album record.
router.post('/artwork-copy', async (req, res) => {
  const t0 = Date.now()
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const b = { ...req.query, ...(req.body || {}) }
    const direction = String(b.direction || '').trim()

    if (direction === 'vision-to-s3') {
      const rel = visionPathOk(b.src)
      if (!rel) return res.status(400).json({ error: 'src must be a path inside a Vision media bucket', got: String(b.src || '').slice(0, 120) })
      const code = String(b.code || '').trim()
      if (!GMVIN_RE.test(code)) {
        return res.status(400).json({ error: 'code must be the GMVin series, e.g. GMVin100000', got: code.slice(0, 40) })
      }
      const ext = (rel.match(/\.([a-z0-9]+)$/i)?.[1] || 'jpg').toLowerCase()
      const key = artworkKeyForGmvi(code, '.' + ext)

      // headAnyKey resolves to { exists: false } for a missing key — an object,
      // and therefore truthy. Test the flag, not the result.
      if ((await headAnyKey(key)).exists) {
        return res.status(409).json({ error: `${key} already exists — refusing to overwrite`, key, url: urlForKey(key) })
      }
      const obj = await visionOpen(rel)
      const chunks = []
      for await (const c of (obj.Body.transformToWebStream ? Readable.fromWeb(obj.Body.transformToWebStream()) : obj.Body)) chunks.push(c)
      const buf = Buffer.concat(chunks)
      if (!buf.length) return res.status(422).json({ error: 'source image is zero bytes', src: rel })

      // uploadArtworkByGmvi also writes the _300/_800 webp derivatives — the MAD
      // app serves those, never the master, so skipping them leaves the cover
      // broken in the app AND caches a 403 at the CDN.
      const up = await uploadArtworkByGmvi(buf, code, '.' + ext, mediaTypeFor(rel))
      console.log(`[artwork-copy] vision→s3 ${rel} → ${up.key} (${buf.length}B, ${Date.now() - t0}ms)`)
      return res.json({ ok: true, direction, url: up.url, key: up.key, bytes: buf.length, derivatives: up.derivatives })
    }

    if (direction === 's3-to-vision') {
      const src = String(b.src || '').trim()
      const srcKey = keyFromS3Url(src)
      if (!srcKey) return res.status(400).json({ error: 'src must be a URL in the artwork bucket', got: src.slice(0, 120) })
      const name = sleeveName(b.artist, b.album, b.cat)
      if (!name) return res.status(400).json({ error: 'artist, album or cat is required to name the Vision file' })

      const ext = (srcKey.match(/\.([a-z0-9]+)$/i)?.[1] || 'jpg').toLowerCase()
      // A letter layer keeps any one Vision directory under ~1000 entries — the
      // grouped listing breaks past that and the folder view hangs (2026-08-29).
      const letter = (name.match(/[A-Za-z]/)?.[0] || '#').toUpperCase()
      const rel = `${VISION_ART_ROOT}/${letter}/${name}.${ext}`

      if (await visionStat(rel)) {
        return res.status(409).json({ error: `${rel} already exists — refusing to overwrite`, path: rel })
      }
      // downloadByUrl resolves to { buffer, contentType } — not a bare Buffer.
      const { buffer: buf } = await downloadByUrl(src)
      if (!buf?.length) return res.status(422).json({ error: 'source image is zero bytes or unreadable', src })

      const tmpDir = await mkdtemp(path.join(tmpdir(), 'artcopy-'))
      const tmpFile = path.join(tmpDir, `img.${ext}`)
      try {
        await writeFile(tmpFile, buf)
        await visionUploadFile(rel, tmpFile, mediaTypeFor(rel))
        const stat = await visionStat(rel)          // verify-after-put
        if (!stat) throw new Error('upload reported success but the object is not there')
        console.log(`[artwork-copy] s3→vision ${srcKey} → ${rel} (${buf.length}B, ${Date.now() - t0}ms)`)
        return res.json({ ok: true, direction, path: rel, bytes: stat.size })
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    return res.status(400).json({ error: 'direction must be "vision-to-s3" or "s3-to-vision"', got: direction.slice(0, 40) })
  } catch (e) {
    console.error('[artwork-copy] failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
  }
})

// ── artwork upload: a cover dragged into a FileMaker container ──────────────
// 9,163 albums have no cover on either side, so there is nothing to copy across
// — the image has to come from outside. FileMaker takes the drop into a
// container field, Base64Encodes it and posts it here.
//
// Replacing an existing cover OVERWRITES its key in place. Minting a new code
// would leave MADStreamer pointing at the old file, turning one drop into two
// database updates (Ian, 2026-08-30) — the shared URL is the whole point. The
// artwork cache-control is max-age=3600, so a replacement propagates within the
// hour rather than being stuck behind a long-lived cache.
//
// S3 overwrites, Vision does not: Vision is the archive of record and has no
// versioning or trash, so a replacement is written there under a new name and
// the superseded file is left alone. Nothing outside the master database
// references the Vision path, so nothing is orphaned by that.
const ART_MIN_PX = Number(process.env.ART_MIN_PX || 600)
const VISION_ART_DROP_ROOT = process.env.VISION_ART_DROP_ROOT
  || '/gallo-music-files-wavs/Digital Sleeves/Added from FileMaker'

// POST /api/gallo/artwork-upload
//   replace an existing cover: { replaceUrl:"https://…/artwork/GMVi6153.jpg", image, … }
//   add a first cover:        { code:"GMVin100002", image, artist, album, cat }
router.post('/artwork-upload', express.json({ limit: '30mb' }), async (req, res) => {
  const t0 = Date.now()
  try {
    if (!keyOk(req)) return res.status(403).json({ error: 'Forbidden' })
    const b = req.body || {}
    const replaceUrl = String(b.replaceUrl || '').trim()
    const code = String(b.code || '').trim()
    let key, replacing = false

    if (replaceUrl) {
      const k = keyFromS3Url(replaceUrl)
      // Only ever overwrite an artwork master. Without this an arbitrary key —
      // an mp3, a hero banner — could be replaced by posting its URL.
      if (!k || !k.startsWith('artwork/') || k.startsWith('artwork/resized/')) {
        return res.status(400).json({ error: 'replaceUrl must point at an artwork master in the bucket', got: replaceUrl.slice(0, 120) })
      }
      key = k
      replacing = true
    } else {
      if (!GMVIN_RE.test(code)) {
        return res.status(400).json({ error: 'send replaceUrl to replace a cover, or code (GMVin…) to add one', got: code.slice(0, 40) })
      }
      key = artworkKeyForGmvi(code, '.jpg')
    }
    // FileMaker's Base64Encode wraps at 76 chars and may prepend a data: prefix.
    const raw = String(b.image || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    if (!raw) return res.status(400).json({ error: 'image (base64) is required — is the container field empty?' })
    let buf
    try { buf = Buffer.from(raw, 'base64') } catch { return res.status(400).json({ error: 'image is not valid base64' }) }
    if (buf.length < 1024) return res.status(422).json({ error: `decoded image is only ${buf.length} bytes` })

    let meta
    try { meta = await sharp(buf).metadata() }
    catch { return res.status(415).json({ error: 'unreadable image — JPEG, PNG, WebP or TIFF please (HEIC is not supported)' }) }
    if (!meta.width || !meta.height) return res.status(415).json({ error: 'could not read the image dimensions' })
    if (Math.min(meta.width, meta.height) < ART_MIN_PX) {
      return res.status(422).json({
        error: `too small: ${meta.width}×${meta.height}. Sleeves need at least ${ART_MIN_PX}px on the short side.`,
      })
    }

    // Normalise to JPEG so every master in the bucket is one format; the
    // derivatives are webp regardless.
    const jpeg = meta.format === 'jpeg' ? buf
      : await sharp(buf).jpeg({ quality: 92 }).toBuffer()

    // Adding is add-only; replacing is the one path allowed to overwrite.
    if (!replacing && (await headAnyKey(key)).exists) {
      return res.status(409).json({ error: `${key} already exists — allocate a fresh code`, key })
    }
    if (replacing && !(await headAnyKey(key)).exists) {
      return res.status(404).json({ error: `${key} is not in the bucket — nothing to replace`, key })
    }
    await uploadAnyKey(jpeg, key, 'image/jpeg')
    // The app serves artwork/resized/*, never the master, so a replacement that
    // skipped these would leave the OLD cover showing everywhere that matters.
    const derivatives = await writeArtworkDerivatives(key, jpeg)
    const up = { key, url: urlForKey(key), derivatives }

    // Vision is the archive copy. The code is in the filename so a replacement
    // never collides with the cover it supersedes.
    let visionPath = null, visionError = null
    if (b.alsoVision !== false && b.alsoVision !== 'false') {
      try {
        const name = sleeveName(b.artist, b.album, b.cat)
        if (!name) throw new Error('artist, album or cat is needed to name the Vision file')
        const letter = (name.match(/[A-Za-z]/)?.[0] || '#').toUpperCase()
        const stem = code || key.replace(/^artwork\//, '').replace(/\.[^.]+$/, '')
        let rel = `${VISION_ART_DROP_ROOT}/${letter}/${name}_${stem}.jpg`
        // Vision never overwrites — a replacement lands beside the file it
        // supersedes, so the archive keeps every version.
        for (let n = 2; await visionStat(rel); n++) {
          if (n > 50) throw new Error('could not find a free Vision filename')
          rel = `${VISION_ART_DROP_ROOT}/${letter}/${name}_${stem}_v${n}.jpg`
        }
        const tmpDir = await mkdtemp(path.join(tmpdir(), 'artdrop-'))
        try {
          const tmpFile = path.join(tmpDir, 'img.jpg')
          await writeFile(tmpFile, jpeg)
          await visionUploadFile(rel, tmpFile, 'image/jpeg')
          if (!await visionStat(rel)) throw new Error('upload reported success but the object is not there')
          visionPath = rel
        } finally { await rm(tmpDir, { recursive: true, force: true }).catch(() => {}) }
      } catch (e) {
        // A failed archive copy must not lose the S3 upload that already worked.
        visionError = e.message
        console.error('[artwork-upload] vision copy failed:', e.message)
      }
    }

    console.log(`[artwork-upload] ${code} ${meta.width}×${meta.height} ${meta.format} → ${up.key}${visionPath ? ' + vision' : ''} (${Date.now() - t0}ms)`)
    res.json({
      ok: true, url: up.url, key: up.key, derivatives: up.derivatives,
      width: meta.width, height: meta.height, bytes: jpeg.length,
      visionPath, visionError,
    })
  } catch (e) {
    console.error('[artwork-upload] failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
  }
})

export default router
