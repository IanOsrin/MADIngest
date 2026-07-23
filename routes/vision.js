// routes/vision.js — the admin Vision tab (browse + download a remote
// FTP/SFTP drive). Read-only: list directories, download files. All paths are
// jailed to VISION_BASE_PATH inside lib/vision-drive.js.
import path from 'path'
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionList, visionDownloadTo } from '../lib/vision-drive.js'
import { buildVisionIndex } from '../lib/gallo-vision-link.js'

const router = Router()
const INDEX_CACHE = path.join(process.cwd(), 'tmp', 'vision-index.json')

router.get('/status', adminAuth, (_req, res) => {
  res.json(visionStatus())
})

// Fast filename/path search over a flat index of every audio file on Vision
// (built once, cached to tmp/vision-index.json). ?refresh=1 rebuilds it.
router.get('/search', adminAuth, async (req, res) => {
  try {
    if (!visionStatus().configured) return res.status(503).json({ error: 'Vision drive is not configured' })
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' })
    const index = await buildVisionIndex({ cacheFile: INDEX_CACHE, refresh: req.query.refresh === '1' })
    const nq = q.toLowerCase()
    const all = index.files.filter(f => f.path.toLowerCase().includes(nq))
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
