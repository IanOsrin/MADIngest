/**
 * routes/covers.js — the Make Cover tab: find a MAM album, preview a generated cover, save it through the cover
 * pipeline (lib/cover-maker.js → lib/album-cover.js setAlbumCover).
 */
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { COVER_STYLES, coverFonts, searchAlbums, getAlbum, previewCover, saveCover } from '../lib/cover-maker.js'

const router = express.Router()
const fail = (res, err) => res.status(err.status || 500).json({ ok: false, error: err.message })

router.get('/status', adminAuth, (_req, res) => res.json({ ok: true, styles: COVER_STYLES, fonts: coverFonts() }))

router.get('/search', adminAuth, async (req, res) => {
  try { res.json({ ok: true, albums: await searchAlbums(req.query.q) }) }
  catch (err) { console.error('[covers] search', err.message); fail(res, err) }
})

router.get('/album/:recordId', adminAuth, async (req, res) => {
  try { res.json({ ok: true, album: await getAlbum(req.params.recordId) }) }
  catch (err) { fail(res, err) }
})

router.get('/preview/:recordId', adminAuth, async (req, res) => {
  try {
    const jpg = await previewCover(req.params.recordId, String(req.query.style || ''))
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(jpg)
  } catch (err) { console.error('[covers] preview', err.message); fail(res, err) }
})

router.post('/save', adminAuth, async (req, res) => {
  const { recordId, style, replace } = req.body || {}
  try {
    const result = await saveCover(String(recordId || ''), String(style || ''), { replace: replace === true })
    console.log('[covers] saved', JSON.stringify(result))
    res.json({ ok: true, result })
  } catch (err) { console.error('[covers] save', recordId, err.message); fail(res, err) }
})

export default router
