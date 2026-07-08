/**
 * routes/youtube.js — YouTube asset creation endpoints (admin YouTube tab).
 *
 * GET /api/youtube/support        → can this machine render? (macOS + ffmpeg)
 * GET /api/youtube/search?q=      → pick tracks from MadStreamer (API_Album_Songs)
 * GET /api/youtube/render-stream  → SSE: render art-tracks/Shorts + .txt sidecars
 * GET /api/youtube/outputs?dir=   → list produced files in the output folder
 * GET /api/youtube/sidecar?dir=&file= → sidecar text (copy-paste into Studio)
 *
 * Rendering runs the engine in lib/youtube-video.js (desktop-only: AppKit
 * overlays + ffmpeg). One render at a time — encodes are CPU-bound and the
 * tool is single-operator.
 */

import { Router } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adminAuth } from '../lib/admin-auth.js'
import { searchSongsForVideo } from '../lib/madstreamer.js'
import { generateVideos, checkRenderSupport, DEFAULT_OUT_DIR } from '../lib/youtube-video.js'

const router = Router()

// The UI placeholder shows "~/Downloads/…" — accept ~ paths from the form
const expandDir = s => {
  const v = String(s || '').trim()
  if (!v) return ''
  return v === '~' || v.startsWith('~/') ? path.join(os.homedir(), v.slice(1)) : v
}

router.get('/support', adminAuth, async (req, res, next) => {
  try {
    const support = await checkRenderSupport()
    res.json({ ...support, defaultOutDir: DEFAULT_OUT_DIR })
  } catch (err) { next(err) }
})

router.get('/search', adminAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.json({ tracks: [] })
    const rows = await searchSongsForVideo(q, { limit: 150 })
    // The UI needs eligibility, not the raw S3 URLs
    res.json({
      tracks: rows.map(t => ({
        recordId: t.recordId,
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genre: t.genre,
        hasAudio: !!t.audioUrl,
        hasArt: !!t.artUrl,
      }))
    })
  } catch (err) { next(err) }
})

// ── render (SSE) ─────────────────────────────────────────────────────────────
// EventSource can't set headers, so auth rides in ?token= like the other
// SSE endpoints (ddex/build-stream et al).
let renderBusy = false

router.get('/render-stream', (req, res) => {
  const token = (req.query.token || req.headers.authorization?.replace('Bearer ', '') || '').trim()
  if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
    return res.status(401).end('Unauthorized')
  }
  if (renderBusy) return res.status(409).end('A render is already running')

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  function emit(event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }
  const ts   = () => new Date().toISOString().slice(11, 19)
  const log  = msg => { const l = `[${ts()}] ${msg}`;   console.log(l);  emit('log', { msg: l, level: 'info' }) }
  const warn = msg => { const l = `[${ts()}] ⚠ ${msg}`; console.warn(l); emit('log', { msg: l, level: 'warn' }) }

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
  req.on('close', () => clearInterval(heartbeat))

  const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean)
  const num = (s, fallback) => { const n = parseInt(String(s || ''), 10); return Number.isFinite(n) ? n : fallback }

  renderBusy = true
  generateVideos({
    trackIds:    ids(req.query.tracks),
    shortIds:    ids(req.query.shorts),
    outDir:      expandDir(req.query.out) || DEFAULT_OUT_DIR,
    excerpt:     Math.max(0, num(req.query.excerpt, 0)),
    shortLen:    Math.min(60, Math.max(15, num(req.query.short_len, 30))),
    shortOffset: Math.max(0, num(req.query.short_offset, 30)),
    metaOnly:    req.query.meta_only === '1',
    log, warn,
  })
    .then(result => emit('done', result))
    .catch(err => emit('error', { message: err.message || String(err), status: err.status || 500 }))
    .finally(() => { renderBusy = false; clearInterval(heartbeat); res.end() })
})

// ── output folder browsing ───────────────────────────────────────────────────
router.get('/outputs', adminAuth, (req, res, next) => {
  try {
    const dir = path.resolve(expandDir(req.query.dir) || DEFAULT_OUT_DIR)
    if (!fs.existsSync(dir)) return res.json({ dir, files: [] })
    const files = fs.readdirSync(dir)
      .filter(f => /--(arttrack|short)\.(mp4|txt)$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(dir, f))
        return { name: f, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    res.json({ dir, files })
  } catch (err) { next(err) }
})

router.get('/sidecar', adminAuth, (req, res, next) => {
  try {
    const dir  = path.resolve(expandDir(req.query.dir) || DEFAULT_OUT_DIR)
    const file = String(req.query.file || '').trim()
    // sidecars only, and never outside the requested folder
    if (!/^[^/\\]+\.txt$/.test(file)) {
      return res.status(400).json({ error: 'file must be a .txt sidecar name' })
    }
    const full = path.join(dir, file)
    if (!full.startsWith(dir + path.sep)) return res.status(400).json({ error: 'Invalid path' })
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Sidecar not found' })
    res.json({ file, text: fs.readFileSync(full, 'utf8') })
  } catch (err) { next(err) }
})

export default router
