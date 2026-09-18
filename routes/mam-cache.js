// routes/mam-cache.js — fill a MAM album's blanks from the metadata cache.
//
// MAM was merged from the three FileMaker databases; the metadata cache was
// never one of its sources, so albums that arrived as Sources=cat can be
// missing ISRC, barcode, publisher and more while the cache holds all of it.
//
// Preview writes nothing. Apply fills EMPTY fields only, and applies a
// near-miss title match only when its recordId is explicitly accepted.
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { planCacheFill, applyCacheFill, addMissingSong } from '../lib/mam-cache-fill.js'
import { syncMamEdit, planAlbumSync, applyAlbumSync } from '../lib/mam-streamer-sync.js'
import { planMamFill, applyMamFill, DEFAULT_PRECEDENCE } from '../lib/mam-db-fill.js'

const router = Router()

router.post('/cache-fill/preview', adminAuth, express.json(), async (req, res) => {
  try {
    res.json({ ok: true, plan: await planCacheFill(String(req.body?.catalogue || ''),
      { cacheCatalogue: String(req.body?.cacheCatalogue || '') }) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

router.post('/cache-fill/apply', adminAuth, express.json(), async (req, res) => {
  try {
    // acceptConflicts is the ONLY way an existing MAM value gets replaced:
    // { "<recordId>|album": ["Field", ...] }. Absent = that value is left alone,
    // which keeps "fill a blank" and "overwrite a value" separate decisions.
    const out = await applyCacheFill(String(req.body?.catalogue || ''), {
      acceptSuggestions: Array.isArray(req.body?.accept) ? req.body.accept : [],
      acceptConflicts:   (req.body?.acceptConflicts && typeof req.body.acceptConflicts === 'object')
                           ? req.body.acceptConflicts : {},
      skipFills:         req.body?.skipFills === true,
      cacheCatalogue:    String(req.body?.cacheCatalogue || ''),
    })
    console.log(`[mam-cache-fill] ${out.catalogue}: ${out.fieldsWritten} filled, ` +
                `${out.fieldsOverwritten} overwritten across ` +
                `${out.tracksUpdated} track(s)${out.albumUpdated ? ' + album' : ''}`)
    // Push what was just filled on to MADStreamer. Album fields reach every
    // track; otherwise only the songs that changed.
    const songIds = Object.keys(out.written.songs)
    const mamFields = [...new Set([...out.written.album, ...Object.values(out.written.songs).flat()])]
    const streamer = mamFields.length
      ? await syncMamEdit({ catalogue: out.plan?.album?.catalogue || out.catalogue, mamFields,
                            songRecordIds: out.written.album.length ? null : songIds })
      : { ok: true, skipped: 'nothing was written to MAM' }
    res.json({ ok: true, ...out, streamer })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// Compare a whole MAM album with MADStreamer. Writes nothing.
router.post('/streamer-sync/preview', adminAuth, express.json(), async (req, res) => {
  try {
    const plan = await planAlbumSync(String(req.body?.catalogue || '').trim())
    if (!plan.ok) return res.status(404).json({ error: plan.reason })
    res.json({ ok: true, plan })
  } catch (e) { res.status(e.status || 502).json({ error: e.message }) }
})

// Push the differences shown in the preview, minus any fields unticked there.
// Blank MAM values are never pushed from here — "not filled in" is not "delete".
router.post('/streamer-sync/apply', adminAuth, express.json(), async (req, res) => {
  try {
    const out = await applyAlbumSync(String(req.body?.catalogue || '').trim(), {
      skipFields: Array.isArray(req.body?.skipFields) ? req.body.skipFields.map(String) : [],
    })
    if (!out.ok) return res.status(404).json({ error: out.reason })
    console.log(`[mam-streamer-sync] ${out.catalogue}: ${out.written} record(s) written, ${out.failed} failed`)
    res.json(out)
  } catch (e) { res.status(e.status || 502).json({ error: e.message }) }
})

// Create one song the cache has and MAM does not. By TITLE, one at a time:
// addMissingSong re-plans and refuses if the track is no longer missing, so a
// double click or a stale panel cannot duplicate a track.
router.post('/cache-fill/add-song', adminAuth, express.json(), async (req, res) => {
  try {
    const out = await addMissingSong(String(req.body?.catalogue || ''), String(req.body?.title || ''),
      { cacheCatalogue: String(req.body?.cacheCatalogue || '') })
    console.log(`[mam-cache-fill] ${out.catalogue}: created "${out.title}" (${out.recordId})`)
    res.json(out)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// ── Update MAM from the other three databases (DB Sync tab) ─────────────────
// MAM drifts: credits typed into Gallo, a language set in CMS, audio linked to
// a Vision master — none of it reaches MAM. Preview writes nothing; apply fills
// blanks, replaces only ticked conflicts, adds only ticked missing tracks, and
// copies the cover through lib/album-cover.js.
router.post('/db-fill/preview', adminAuth, express.json(), async (req, res) => {
  try {
    const precedence = Array.isArray(req.body?.precedence) && req.body.precedence.length
      ? req.body.precedence.map(String) : DEFAULT_PRECEDENCE
    const plan = await planMamFill(String(req.body?.catalogue || ''), { precedence })
    console.log(`[mam-db-fill] preview ${plan.catalogue}: ${plan.counts.fills} fill(s), ` +
                `${plan.counts.conflicts} conflict(s), ${plan.counts.missing} missing track(s)`)
    res.json({ ok: true, plan })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

router.post('/db-fill/apply', adminAuth, express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const out = await applyMamFill(String(req.body?.catalogue || ''), {
      tracks:      (req.body?.tracks && typeof req.body.tracks === 'object') ? req.body.tracks : {},
      album:       (req.body?.album && typeof req.body.album === 'object') ? req.body.album : {},
      artworkFrom: req.body?.artworkFrom ? String(req.body.artworkFrom) : null,
      addTracks:   Array.isArray(req.body?.addTracks) ? req.body.addTracks : [],
    })
    console.log(`[mam-db-fill] apply ${req.body?.catalogue}: ${out.fieldsWritten} field(s) on ` +
                `${out.tracksUpdated} track(s), ${out.albumFields} album field(s), ${out.added} added, ` +
                `artwork ${out.artwork ? 'copied' : 'untouched'}, ${out.failed.length} failed`)
    res.json({ ok: true, ...out })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
