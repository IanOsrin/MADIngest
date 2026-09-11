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

const router = Router()

router.post('/cache-fill/preview', adminAuth, express.json(), async (req, res) => {
  try {
    res.json({ ok: true, plan: await planCacheFill(String(req.body?.catalogue || '')) })
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
    })
    console.log(`[mam-cache-fill] ${out.catalogue}: ${out.fieldsWritten} filled, ` +
                `${out.fieldsOverwritten} overwritten across ` +
                `${out.tracksUpdated} track(s)${out.albumUpdated ? ' + album' : ''}`)
    res.json({ ok: true, ...out })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// Create one song the cache has and MAM does not. By TITLE, one at a time:
// addMissingSong re-plans and refuses if the track is no longer missing, so a
// double click or a stale panel cannot duplicate a track.
router.post('/cache-fill/add-song', adminAuth, express.json(), async (req, res) => {
  try {
    const out = await addMissingSong(String(req.body?.catalogue || ''), String(req.body?.title || ''))
    console.log(`[mam-cache-fill] ${out.catalogue}: created "${out.title}" (${out.recordId})`)
    res.json(out)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
