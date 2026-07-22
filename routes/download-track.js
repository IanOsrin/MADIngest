// routes/download-track.js — the admin Download Track tab.
//
// Workflow: operator searches by artist and/or track name → GET /search
// returns matching streamer records (with an auditionable S3 URL) → the
// Download button hits GET /file/:recordId, which re-resolves the record in
// FileMaker and streams its S3 master back with a proper attachment filename.
// The proxy takes a recordId, never a URL — the server decides what it fetches.
import { Router } from 'express'
import { Readable } from 'node:stream'
import { adminAuth } from '../lib/admin-auth.js'
import { findStreamerTracks, getStreamerTrackById } from '../lib/madstreamer.js'

const router = Router()

router.get('/search', adminAuth, async (req, res) => {
  try {
    const artist = String(req.query.artist || '').trim()
    const track = String(req.query.track || '').trim()
    if (artist.length < 2 && track.length < 2) {
      return res.status(400).json({ error: 'Type at least 2 characters of an artist or track name' })
    }
    const tracks = await findStreamerTracks({ artist, track })
    res.json({ tracks, total: tracks.length })
  } catch (e) {
    console.error('[download-track] search failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Windows-illegal filename chars + control chars → space; collapse runs.
const safeFilename = (s) =>
  String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)

router.get('/file/:recordId', adminAuth, async (req, res) => {
  try {
    const track = await getStreamerTrackById(String(req.params.recordId || ''))
    if (!track) return res.status(404).json({ error: 'Record not found' })
    if (!track.s3url) return res.status(404).json({ error: 'Record has no audio file (S3_URL empty)' })

    const upstream = await fetch(track.s3url)
    if (!upstream.ok || !upstream.body) {
      console.error(`[download-track] S3 fetch ${upstream.status} for record ${track.recordId}`)
      return res.status(502).json({ error: `Audio fetch failed (HTTP ${upstream.status})` })
    }

    const ext = (new URL(track.s3url).pathname.match(/\.(mp3|wav|flac|m4a|aac|ogg)$/i)?.[1] || 'mp3').toLowerCase()
    const name = safeFilename(`${track.artist || 'Unknown Artist'} - ${track.title || 'Untitled'}.${ext}`)
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg')
    const len = upstream.headers.get('content-length')
    if (len) res.setHeader('Content-Length', len)
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`)

    Readable.fromWeb(upstream.body).pipe(res)
  } catch (e) {
    console.error('[download-track] file failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else res.destroy()
  }
})

export default router
