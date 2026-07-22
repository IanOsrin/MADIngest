// routes/vision.js — the admin Vision tab (browse + download a remote
// FTP/SFTP drive). Read-only: list directories, download files. All paths are
// jailed to VISION_BASE_PATH inside lib/vision-drive.js.
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionList, visionDownloadTo } from '../lib/vision-drive.js'

const router = Router()

router.get('/status', adminAuth, (_req, res) => {
  res.json(visionStatus())
})

router.get('/list', adminAuth, async (req, res) => {
  try {
    if (!visionStatus().configured) {
      return res.status(503).json({ error: 'Vision drive is not configured — set VISION_HOST/USER/PASS (and VISION_PROTOCOL if not sftp)' })
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
