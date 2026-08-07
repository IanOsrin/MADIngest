// routes/hero-banner.js — the admin Hero Banner tab.
//
// Puts a designed banner on the home carousel of musicafricadirect.com:
// upload the image to S3, then create the record on MadStreamer's
// API_Hero_Featured layout that the site reads (routes/featured-editorial.js
// in madmusicv2.1, SWR-cached 60s — a new banner appears within a minute).
//
// ORDER MATTERS: the image is uploaded and confirmed BEFORE the URL is written
// to FileMaker. The other way round, the site would ask the CDN for an object
// that does not exist yet, the CDN would cache that 403, and the banner would
// stay broken even once the image landed — with no query string able to clear
// it. Keys are timestamped for the same reason, so a corrected re-upload always
// gets a URL with no cache history.
import { Router } from 'express'
import multer from 'multer'
import { adminAuth } from '../lib/admin-auth.js'
import { inspectHeroImage, uploadHeroBanner } from '../lib/s3-imports.js'
import {
  listHeroBanners, createHeroBanner, updateHeroBanner, deleteHeroBanner,
  findStreamerTracks, HERO_TARGET_TYPES, HERO_TARGET_TYPES_LIVE,
} from '../lib/madstreamer.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })

router.get('/list', adminAuth, async (_req, res) => {
  try {
    res.json({ ok: true, banners: await listHeroBanners(), targetTypes: HERO_TARGET_TYPES, liveTypes: HERO_TARGET_TYPES_LIVE })
  } catch (e) {
    console.error('[hero] list failed:', e.message)
    res.status(502).json({ error: e.message })
  }
})

/** Check an image without uploading it, so the operator sees the shape verdict first. */
router.post('/inspect', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no image received' })
    res.json({ ok: true, ...(await inspectHeroImage(req.file.buffer)) })
  } catch (e) {
    res.status(400).json({ error: `Could not read that image: ${e.message}` })
  }
})

router.post('/create', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no image received' })
    const b = req.body || {}

    // Shape first — a wrong-ratio banner is a cropped headline on the live
    // site, and that is far harder to notice than a refusal here.
    const shape = await inspectHeroImage(req.file.buffer)
    if (!shape.ok && String(b.force) !== 'true') {
      return res.status(422).json({ error: shape.reason, shape, canForce: true })
    }

    const up = await uploadHeroBanner(req.file.buffer, req.file.originalname, req.file.mimetype)

    let created
    try {
      created = await createHeroBanner({
        title: b.title, eyebrow: b.eyebrow, imageUrl: up.url,
        targetType: b.targetType, targetId: b.targetId, ctaLabel: b.ctaLabel,
        sortOrder: b.sortOrder, startDate: b.startDate, endDate: b.endDate,
        active: String(b.active) !== 'false',
      })
    } catch (e) {
      // The image is uploaded but unreferenced — harmless, and the next attempt
      // gets a fresh key. Say so rather than leaving it looking like nothing ran.
      return res.status(502).json({ error: `Image uploaded to ${up.key}, but the FileMaker record failed: ${e.message}` })
    }

    console.log(`[hero] created ${created.recordId} "${b.title}" → ${up.key}`)
    res.json({ ok: true, recordId: created.recordId, imageUrl: up.url, key: up.key, shape })
  } catch (e) {
    console.error('[hero] create failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/**
 * Find a track's recordId for Target_ID.
 *
 * This exists because the number FileMaker SHOWS on a layout is the record's
 * position in the found set, NOT the Data API recordId the site plays by — a
 * Tape Files record displayed as 8590 was recordId 30864. Typing the visible
 * number would give a banner that plays the wrong song or silently nothing,
 * because an unknown id just falls through playSong with no error.
 */
router.get('/track-search', adminAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.status(400).json({ error: 'type at least 2 characters' })
    // One box, both fields: try it as an artist and as a title, then merge.
    const [byArtist, byTitle] = await Promise.all([
      findStreamerTracks({ artist: q }, { limit: 40 }).catch(() => []),
      findStreamerTracks({ track: q },  { limit: 40 }).catch(() => []),
    ])
    const seen = new Set()
    const tracks = [...byArtist, ...byTitle]
      .filter(t => t.recordId && !seen.has(t.recordId) && seen.add(t.recordId))
      .slice(0, 40)
      .map(t => ({ recordId: t.recordId, title: t.title, artist: t.artist, album: t.album, year: t.year }))
    res.json({ ok: true, tracks })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.patch('/:recordId', adminAuth, async (req, res) => {
  try {
    await updateHeroBanner(req.params.recordId, req.body || {})
    res.json({ ok: true })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.delete('/:recordId', adminAuth, async (req, res) => {
  try {
    await deleteHeroBanner(req.params.recordId)
    res.json({ ok: true })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

export default router
