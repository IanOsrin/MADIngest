/**
 * routes/health.js — the Data Health tab's API.
 *
 *   GET /api/ingest/health/summary?refresh=1   catalogue-wide counts
 *   GET /api/ingest/health/records?check=…     the offending records
 *
 *   PATCH /api/ingest/health/record             correct ONE field on one record
 *   GET   /api/ingest/health/catalogue?cat=…    every track of one catalogue
 *
 * The READS are all from the Postgres mirror. The one WRITE goes to MadStreamer
 * FileMaker, because the mirror is a read-only nightly copy — lib/mirror-db.js
 * refuses any statement that is not SELECT/WITH. A correction therefore does
 * not move the health counts until the next sync, and the UI says so.
 */
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import express from 'express'
import { getHealthSummary, getHealthRecords, getCatalogueRecords, CHECKS } from '../lib/catalogue-health.js'
import { isMirrorEnabled } from '../lib/mirror-db.js'
import { updateStreamerRecord } from '../lib/madstreamer.js'

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

/**
 * Every track of one catalogue, for the checks that flag an ALBUM rather than a
 * record — "one catalogue, two album titles" has no single row to correct, so
 * the drill-in expands to the tracks and the same per-field edit applies.
 */
router.get('/catalogue', adminAuth, async (req, res) => {
  try {
    const out = await getCatalogueRecords(String(req.query.cat || ''))
    if (!out.ok) return res.status(400).json(out)
    res.json(out)
  } catch (err) {
    res.status(502).json({ ok: false, reason: err?.message || 'lookup failed' })
  }
})

/**
 * Correct one field on one MadStreamer record.
 *
 * The field must be one the CHECK declares fixable. That is not ceremony: it
 * stops a drill-in becoming a general-purpose editor for any field on any
 * record reachable from a report, which is a much larger thing to have built
 * by accident.
 */
router.patch('/record', adminAuth, express.json(), async (req, res) => {
  const check    = String(req.body?.check || '').trim()
  const recordId = String(req.body?.recordId || '').trim()
  const field    = String(req.body?.field || '').trim()
  const value    = req.body?.value == null ? '' : String(req.body.value)

  if (!recordId || !field) return res.status(400).json({ ok: false, reason: 'recordId and field required' })
  const def = CHECKS.find(c => c.code === check)
  if (!def) return res.status(400).json({ ok: false, reason: `Unknown check "${check}"` })
  if (!Array.isArray(def.fixFields) || !def.fixFields.includes(field)) {
    return res.status(400).json({
      ok: false,
      reason: `"${field}" is not editable from the ${check} check` +
              (def.fixFields?.length ? ` — it offers ${def.fixFields.join(', ')}` : ' — that check is report-only'),
    })
  }
  try {
    await updateStreamerRecord(recordId, { [field]: value })
    console.log(`[health] ${check}: ${recordId} ${field} = ${JSON.stringify(value)}`)
    res.json({
      ok: true, recordId, field, value,
      // Said plainly, because the count on screen will not move and that looks
      // exactly like the write having failed.
      note: 'Saved to MadStreamer. The health counts come from the nightly mirror, so they update after the next sync.',
    })
  } catch (err) {
    res.status(502).json({ ok: false, reason: err?.message || 'write failed' })
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
