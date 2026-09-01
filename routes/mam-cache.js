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
import { planCacheFill, applyCacheFill } from '../lib/mam-cache-fill.js'

const router = Router()

router.post('/cache-fill/preview', adminAuth, express.json(), async (req, res) => {
  try {
    res.json({ ok: true, plan: await planCacheFill(String(req.body?.catalogue || '')) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

router.post('/cache-fill/apply', adminAuth, express.json(), async (req, res) => {
  try {
    const out = await applyCacheFill(String(req.body?.catalogue || ''),
      { acceptSuggestions: Array.isArray(req.body?.accept) ? req.body.accept : [] })
    console.log(`[mam-cache-fill] ${out.catalogue}: ${out.fieldsWritten} field(s) across ` +
                `${out.tracksUpdated} track(s)${out.albumUpdated ? ' + album' : ''}`)
    res.json({ ok: true, ...out })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
