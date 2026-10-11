// routes/fingerprint.js — the Check Audio tab (Ian, 2026-10-11): which Gallo recordings are in this audio?
// The work is in lib/fingerprint-check.js; it runs where the fingerprint index is (Ian's Mac + Bandlab).
//
//   GET  /api/fingerprint/status              → { ok, available, reason?, matcher: { state, tracks? } }
//   POST /api/fingerprint/upload?name=<file>  (body = the audio file itself) → { ok, job }
//   POST /api/fingerprint/link  { url }       → { ok, job } — a direct audio link, or a YouTube/TikTok/… page
//   GET  /api/fingerprint/job/:id             → { ok, job: { status: working|done|error, stage, result, error } }
//   GET  /api/fingerprint/job/:id/audio       → the audio that was checked (to listen to a match)
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { availability, matcherState, newJob, getJob, publicJob, saveUpload, runJob, MAX_BYTES } from '../lib/fingerprint-check.js'

const router = Router()
const fail = (res, status, error) => res.status(status).json({ ok: false, error })

router.get('/status', adminAuth, (_req, res) => {
  const a = availability()
  res.json({ ok: true, available: a.ok, reason: a.reason || null, matcher: matcherState() })
})

router.post('/upload', adminAuth, async (req, res) => {
  const a = availability(); if (!a.ok) return fail(res, 503, a.reason)
  if (Number(req.headers['content-length']) > MAX_BYTES) return fail(res, 413, 'That file is over 300 MB.')
  const name = String(req.query.name || 'audio').slice(0, 200)
  const job = newJob({ kind: 'file', title: name })
  try { await saveUpload(job, req, name) } catch (err) { return fail(res, 400, err.message) }
  runJob(job)
  res.json({ ok: true, job: publicJob(job) })
})

router.post('/link', adminAuth, (req, res) => {
  const a = availability(); if (!a.ok) return fail(res, 503, a.reason)
  const url = String(req.body?.url || '').trim()
  try { new URL(url) } catch { return fail(res, 400, 'That doesn’t look like a link.') }
  const job = newJob({ kind: 'link', url, title: '' })
  runJob(job, url)
  res.json({ ok: true, job: publicJob(job) })
})

router.get('/job/:id', adminAuth, (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return fail(res, 404, 'That check has expired — run it again.')
  res.json({ ok: true, job: publicJob(job) })
})

router.get('/job/:id/audio', adminAuth, (req, res) => {
  const job = getJob(req.params.id)
  if (!job || !job.audio) return fail(res, 404, 'No audio for that check.')
  res.sendFile(job.audio)
})

export default router
