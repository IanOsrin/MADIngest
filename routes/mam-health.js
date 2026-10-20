/**
 * routes/mam-health.js — the MAM Health tab's API. Read-only.
 *
 *   GET /api/ingest/mam-health/summary?refresh=1   counts per check (202 while the sweep runs)
 *   GET /api/ingest/mam-health/records?check=…     the records one check flags (paged)
 *   GET /api/ingest/mam-health/catalogue?cat=…     every song of one catalogue
 *   GET /api/ingest/mam-health/checks              what checks exist, without running them
 *
 * Everything comes from one in-memory sweep of Music Arena Master
 * (lib/mam-health.js); nothing here writes to any database.
 */
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { getMamHealthSummary, getMamHealthRecords, getMamCatalogueRecords, CHECKS } from '../lib/mam-health.js'

const router = Router()

router.get('/summary', adminAuth, async (req, res) => {
  try {
    const s = await getMamHealthSummary({ refresh: req.query.refresh === '1' })
    // Still sweeping: 202 so the page polls rather than sitting on a silent
    // two-minute request, which looks exactly like a hang.
    if (s.building) return res.status(202).json(s)
    res.json(s)
  } catch (err) {
    res.status(502).json({ ok: false, reason: err?.message || 'MAM sweep failed' })
  }
})

router.get('/records', adminAuth, (req, res) => {
  const out = getMamHealthRecords(String(req.query.check || ''), { limit: req.query.limit, offset: req.query.offset })
  res.status(out.ok ? 200 : 400).json(out)
})

router.get('/catalogue', adminAuth, (req, res) => {
  const out = getMamCatalogueRecords(String(req.query.cat || ''))
  res.status(out.ok ? 200 : 400).json(out)
})

router.get('/checks', adminAuth, (_req, res) => {
  res.json({ ok: true, checks: CHECKS.map(({ code, label, why, severity, group, unit }) => ({ code, label, why, severity, group, unit })) })
})

export default router
