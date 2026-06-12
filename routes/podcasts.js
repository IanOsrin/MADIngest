/**
 * routes/podcasts.js — Podcast ingest endpoints (added 2026-06-11).
 *
 * GET  /api/podcasts/shows   → distinct shows already in MadStreamer (for the
 *                              form's "existing show" autofill)
 * POST /api/podcasts/submit  → multipart: audio (required) + artwork (optional)
 *                              + episode/show fields. Uploads to S3, then
 *                              creates the episode row on API_Podcasts.
 *
 * Both endpoints are admin-gated like the rest of the tool.
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { adminAuth } from '../lib/admin-auth.js'
import { extractAudioMeta } from '../lib/audio-meta.js'
import { uploadPodcastAudio, uploadPodcastArtwork } from '../lib/s3-imports.js'
import { listPodcastEpisodes, createPodcastRecord } from '../lib/madstreamer.js'

const router = Router()
const UPLOAD_TMP = process.env.UPLOAD_TMP_DIR || '/tmp/gallo-ingest'
fs.mkdirSync(UPLOAD_TMP, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP,
    filename: (req, file, cb) =>
      cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9. _-]/g, '_'))
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB — podcast episodes can run long
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (file.fieldname === 'artwork') {
      const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
             || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
      return cb(ok ? null : new Error(`Artwork must be jpg/png/webp, got: ${file.mimetype}`), ok)
    }
    const ok = file.mimetype === 'audio/mpeg' || ext === '.mp3'
    cb(ok ? null : new Error(`Podcast audio must be MP3, got: ${file.mimetype}`), ok)
  }
})

/** Distinct shows with their stored show-level fields. */
router.get('/shows', adminAuth, async (req, res, next) => {
  try {
    const rows = await listPodcastEpisodes()
    const shows = new Map()
    for (const rec of rows) {
      const f = rec.fieldData || {}
      const title = String(f['Show Title'] || '').trim()
      if (!title) continue
      const key = title.toLowerCase()
      if (!shows.has(key)) {
        shows.set(key, {
          showTitle: title,
          host:      String(f['Host'] || '').trim(),
          artwork:   String(f['Artwork_S3_URL'] || '').trim(),
          category:  String(f['Category'] || '').trim(),
          language:  String(f['Language Code'] || '').trim(),
          episodeCount: 0,
          maxEpisodeNumber: 0
        })
      }
      const s = shows.get(key)
      s.episodeCount++
      const n = Number.parseInt(f['Episode Number'], 10) || 0
      if (n > s.maxEpisodeNumber) s.maxEpisodeNumber = n
    }
    res.json({ shows: [...shows.values()] })
  } catch (err) { next(err) }
})

router.post('/submit',
  adminAuth,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'artwork', maxCount: 1 }]),
  async (req, res, next) => {
    const tmpFiles = []
    try {
      const audioFile   = req.files?.audio?.[0]
      const artworkFile = req.files?.artwork?.[0]
      if (audioFile) tmpFiles.push(audioFile.path)
      if (artworkFile) tmpFiles.push(artworkFile.path)

      const b = req.body || {}
      const showTitle    = String(b.showTitle || '').trim()
      const episodeTitle = String(b.episodeTitle || '').trim()
      if (!audioFile)    throw Object.assign(new Error('Audio file is required'), { status: 400 })
      if (!showTitle)    throw Object.assign(new Error('Show title is required'), { status: 400 })
      if (!episodeTitle) throw Object.assign(new Error('Episode title is required'), { status: 400 })

      // Artwork: a new upload, or reuse the URL of an existing show.
      let artworkUrl = String(b.existingArtworkUrl || '').trim()
      if (!artworkFile && !artworkUrl) {
        throw Object.assign(new Error('Artwork is required (upload a cover or pick an existing show)'), { status: 400 })
      }

      // Duration: probe the MP3; fall back to a manually supplied value.
      const audioBuffer = fs.readFileSync(audioFile.path)
      let durationSec = Number.parseFloat(b.durationSec) || 0
      try {
        const probed = await extractAudioMeta(audioBuffer, 'audio/mpeg')
        if (probed?.technical?.duration_sec) durationSec = probed.technical.duration_sec
      } catch (e) {
        console.warn('[podcasts] duration probe failed, using form value:', e.message)
      }

      const episodeNumber = Number.parseInt(b.episodeNumber, 10) || null

      // 1. Audio → S3 (podcasts/audio/<show-slug>/NNN-<episode-slug>.mp3)
      const audio = await uploadPodcastAudio(audioBuffer, showTitle, episodeNumber, episodeTitle)

      // 2. Artwork → S3 (artwork/podcast-<show-slug>.<ext>) when newly uploaded
      if (artworkFile) {
        const art = await uploadPodcastArtwork(
          fs.readFileSync(artworkFile.path),
          showTitle,
          path.extname(artworkFile.originalname) || '.jpg',
          artworkFile.mimetype
        )
        artworkUrl = art.url
      }

      // 3. Episode row → FileMaker. PublishDate in FM's MM/DD/YYYY format.
      const pd = String(b.publishDate || '').trim() // form sends yyyy-mm-dd
      const pdFm = /^\d{4}-\d{2}-\d{2}$/.test(pd)
        ? `${pd.slice(5, 7)}/${pd.slice(8, 10)}/${pd.slice(0, 4)}`
        : ''

      const fieldData = {
        'Show Title':      showTitle,
        'Host':            String(b.host || '').trim(),
        'Artwork_S3_URL':  artworkUrl,
        'Category':        String(b.category || '').trim(),
        'Language Code':   String(b.languageCode || '').trim(),
        'Episode Title':   episodeTitle,
        'Description':     String(b.description || '').trim(),
        'S3_URL':          audio.url,
        'DurationSec':     durationSec || '',
        'Visibility':      b.visibility === 'Hide' ? 'Hide' : 'Show',
        'Featured':        b.featured === 'yes' ? 'yes' : '',
        'Explicit':        b.explicit === 'yes' ? 1 : 0
      }
      if (episodeNumber) fieldData['Episode Number'] = episodeNumber
      if (pdFm)          fieldData['PublishDate']    = pdFm

      const created = await createPodcastRecord(fieldData)

      res.json({
        ok: true,
        recordId:    created.recordId,
        audioUrl:    audio.url,
        artworkUrl,
        durationSec,
        show:        showTitle,
        episode:     episodeTitle
      })
    } catch (err) {
      next(err)
    } finally {
      for (const p of tmpFiles) fs.unlink(p, () => {})
    }
  }
)

export default router
