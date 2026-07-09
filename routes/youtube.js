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

import express, { Router } from 'express'
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

// Last/current render job, for when the SSE connection drops mid-encode
// (hosted art-tracks can run 10+ minutes): the render keeps going server-side
// and GET /status shows how it's doing.
const lastJob = { running: false, startedAt: null, lines: [], result: null, error: null }

router.get('/status', adminAuth, (req, res) => {
  res.json({ ...lastJob, lines: lastJob.lines.slice(-200) })
})

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
  const track = l => { lastJob.lines.push(l); if (lastJob.lines.length > 500) lastJob.lines.shift() }
  const log  = msg => { const l = `[${ts()}] ${msg}`;   console.log(l);  track(l); emit('log', { msg: l, level: 'info' }) }
  const warn = msg => { const l = `[${ts()}] ⚠ ${msg}`; console.warn(l); track(l); emit('log', { msg: l, level: 'warn' }) }

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
  req.on('close', () => clearInterval(heartbeat))

  const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean)
  const num = (s, fallback) => { const n = parseInt(String(s || ''), 10); return Number.isFinite(n) ? n : fallback }

  renderBusy = true
  Object.assign(lastJob, { running: true, startedAt: new Date().toISOString(), lines: [], result: null, error: null })
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
    .then(result => { lastJob.result = result; emit('done', result) })
    .catch(err => { lastJob.error = err.message || String(err); emit('error', { message: lastJob.error, status: err.status || 500 }) })
    .finally(() => { renderBusy = false; lastJob.running = false; clearInterval(heartbeat); res.end() })
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

// Browser download of a rendered file — essential on the hosted instance,
// whose disk the operator can't reach. <a href> can't set headers, so auth
// rides in ?token= like the SSE endpoints.
router.get('/download', (req, res, next) => {
  try {
    const token = (req.query.token || req.headers.authorization?.replace('Bearer ', '') || '').trim()
    if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const dir  = path.resolve(expandDir(req.query.dir) || DEFAULT_OUT_DIR)
    const file = String(req.query.file || '').trim()
    // only files the outputs listing shows, and never outside the folder
    if (!/^[^/\\]+--(arttrack|short)\.(mp4|txt)$/.test(file)) {
      return res.status(400).json({ error: 'Not a downloadable render output' })
    }
    const full = path.join(dir, file)
    if (!full.startsWith(dir + path.sep)) return res.status(400).json({ error: 'Invalid path' })
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' })
    res.download(full)
  } catch (err) { next(err) }
})

// Delete render outputs + cached source assets from the output folder.
// YouTube keeps the uploaded copy and everything is re-renderable from
// S3 + FM, so rendered files are disposable. Only touches files this tool
// created (render outputs, overlay PNGs, cached .mp3/.jpg/.webp sources) —
// never recurses, never leaves the folder.
router.post('/clear-outputs', adminAuth, express.json(), (req, res, next) => {
  try {
    const dir = path.resolve(expandDir(req.body?.dir) || DEFAULT_OUT_DIR)
    if (!fs.existsSync(dir)) return res.json({ dir, deleted: 0 })
    const ours = /(--(arttrack|short)\.(mp4|txt)|\.overlay\.png|\.art\.(jpg|webp)|\.mp3)$/
    let deleted = 0
    for (const f of fs.readdirSync(dir)) {
      if (!ours.test(f)) continue
      const full = path.join(dir, f)
      if (!full.startsWith(dir + path.sep) || !fs.statSync(full).isFile()) continue
      fs.unlinkSync(full)
      deleted++
    }
    res.json({ dir, deleted })
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
