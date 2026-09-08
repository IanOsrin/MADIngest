/**
 * routes/health.js — the Data Health tab's API.
 *
 *   GET /api/ingest/health/summary?refresh=1   catalogue-wide counts
 *   GET /api/ingest/health/records?check=…     the offending records
 *
 * Reads the Postgres mirror only. Never FileMaker, never a write.
 */
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { getHealthSummary, getHealthRecords, CHECKS } from '../lib/catalogue-health.js'
import { isMirrorEnabled } from '../lib/mirror-db.js'

const router = Router()

router.get('/summary', adminAuth, async (req, res) => {
  try {
    const s = await getHealthSummary({ refresh: req.query.refresh === '1' })
    // Still sweeping on a cold start: 202 so the page can poll rather than sit
    // on a silent 90-second request, which is indistinguishable from a hang.
    if (s.building) return res.status(202).json(s)
    res.json(s)
  } catch (err) {
    res.status(502).json({ ok: false, reason: err?.message || 'health sweep failed' })
  }
})

router.get('/records', adminAuth, async (req, res) => {
  try {
    const out = await getHealthRecords(String(req.query.check || ''), {
      limit:  req.query.limit,
      offset: req.query.offset,
    })
    if (!out.ok) return res.status(400).json(out)
    res.json(out)
  } catch (err) {
    res.status(502).json({ ok: false, reason: err?.message || 'lookup failed' })
  }
})

/** What checks exist, without running any of them. */
router.get('/checks', adminAuth, (_req, res) => {
  res.json({
    ok: true,
    mirrorConfigured: isMirrorEnabled(),
    checks: CHECKS.map(({ code, label, why, severity, group, unit }) => ({ code, label, why, severity, group, unit: unit || 'records' })),
  })
})

export default router
