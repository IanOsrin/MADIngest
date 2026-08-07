// routes/vision.js — the admin Vision tab (browse + download a remote
// FTP/SFTP drive). Read-only: list directories, download files. All paths are
// jailed to VISION_BASE_PATH inside lib/vision-drive.js.
import path from 'path'
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionList, visionDownloadTo } from '../lib/vision-drive.js'
import { loadVisionIndex, reindexVisionIndex, indexBuilding, indexStatus } from '../lib/gallo-vision-link.js'

const router = Router()
const INDEX_CACHE = path.join(process.cwd(), 'tmp', 'vision-index.json')

router.get('/status', adminAuth, (_req, res) => {
  res.json(visionStatus())
})

// Index state. Reports which folder is being worked on and the last error, so a
// refresh that dies is visible instead of leaving a stale index and a button
// that only ever said "started".
router.get('/index-status', adminAuth, async (_req, res) => {
  const index = await loadVisionIndex({ cacheFile: INDEX_CACHE })
  res.json({ built: !!index, building: indexBuilding(), indexedFiles: index?.builtFiles || 0, ...indexStatus() })
})

// Refresh out of band. Cheap by default: new folders are indexed at once and the
// stalest known folders are refreshed within a time budget. ?full=1 forces the
// whole estate, which takes tens of minutes.
router.post('/reindex', adminAuth, (req, res) => {
  if (!visionStatus().configured) return res.status(503).json({ error: 'Vision drive is not configured' })
  const full = req.query.full === '1' || req.body?.full === true
  const r = reindexVisionIndex({ cacheFile: INDEX_CACHE, full })
  res.json({
    ok: true, ...r, full,
    note: !r.started ? 'A refresh is already running.'
      : full ? 'Full rebuild started — this lists every object on both drives and takes tens of minutes.'
             : 'Refreshing: new folders are picked up first, then the stalest ones. Watch the status line.',
  })
})

// Fast filename/path search over the persisted index. Never builds in-request.
router.get('/search', adminAuth, async (req, res) => {
  try {
    if (!visionStatus().configured) return res.status(503).json({ error: 'Vision drive is not configured' })
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' })
    const index = await loadVisionIndex({ cacheFile: INDEX_CACHE })
    if (!index) return res.status(409).json({ error: 'Vision index not built yet', needsReindex: true, building: indexBuilding() })
    // Match ALL words (AND), not the exact phrase — "Makeba Reflections" should
    // find …/Miriam Makeba/…_Reflections_… even with text between the words.
    // Each term must PREFIX a word in the path (not substring-anywhere): a
    // stray "h" in "Sister H" used to match every path containing the letter.
    // If strict matching finds nothing, fall back to substring so inner-word
    // fragments stay findable.
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const wordPrefix = (f) => {
      const pw = f.path.toLowerCase().split(/[^a-z0-9]+/)
      return words.every(w => pw.some(x => x.startsWith(w)))
    }
    let all = index.files.filter(wordPrefix)
    if (!all.length) all = index.files.filter(f => { const p = f.path.toLowerCase(); return words.every(w => p.includes(w)) })
    res.json({ total: all.length, indexedFiles: index.builtFiles, files: all.slice(0, 500) })
  } catch (e) {
    console.error('[vision] search failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/list', adminAuth, async (req, res) => {
  try {
    if (!visionStatus().configured) {
      return res.status(503).json({ error: 'Vision drive is not configured — set VISION_ENDPOINT / VISION_ACCESS_KEY / VISION_SECRET_KEY' })
    }
    const out = await visionList(String(req.query.path || '/'))
    res.json(out)
  } catch (e) {
    console.error('[vision] list failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/download', adminAuth, async (req, res) => {
  try {
    if (!visionStatus().configured) {
      return res.status(503).json({ error: 'Vision drive is not configured' })
    }
    const rel = String(req.query.path || '')
    if (!rel) return res.status(400).json({ error: 'path is required' })
    const name = rel.split('/').filter(Boolean).pop() || 'download'
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[\\"\x00-\x1f]/g, ' ')}"`)
    await visionDownloadTo(rel, res)
    res.end()
  } catch (e) {
    console.error('[vision] download failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else res.destroy()
  }
})

export default router
