// routes/reports.js — the Reports tab: what was listened to in a period.
//
// GET /api/reports/streams?from=&to=&group=song|album|artist&previews=1&limit=
//   → { from, to, totals, rows, previews, … } (see lib/stream-report.js)
// GET /api/reports/streams.csv?…   → the same rows as a spreadsheet
//
// The numbers come from MadStreamer's stream-event records (one per listen) and
// are labelled from the nightly Postgres mirror. Both are reads; nothing here
// writes. A report is cached briefly so flipping between the song, album and
// artist views doesn't re-query FileMaker each time.
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { buildStreamReport } from '../lib/stream-report.js'
import { buildStreamDashboard } from '../lib/stream-dashboard.js'
import { subscriberCount } from '../lib/subscriber-count.js'

const router = Router()

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()   // key → { at, value }

async function report(params) {
  const key = JSON.stringify(params)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = await buildStreamReport(params)
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 50) cache.delete(cache.keys().next().value)
  return value
}

function params(req) {
  const q = req.query || {}
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10)  // SA date
  const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 200))
  return {
    from: String(q.from || today).slice(0, 10),
    to: String(q.to || today).slice(0, 10),
    group: ['song', 'album', 'artist'].includes(q.group) ? q.group : 'song',
    includePreviews: q.previews === '1' || q.previews === 'true',
    limit,
  }
}

router.get('/streams', adminAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await report(params(req))) })
  } catch (err) { next(err) }
})

// The Listening tab (lib/stream-dashboard.js). Cached for a minute: "right now" should be fresh, but
// flipping between periods or several people looking at once shouldn't each hit FileMaker.
const dashCache = new Map()
router.get('/dashboard', adminAuth, async (req, res, next) => {
  try {
    const p = params(req)
    const key = `${p.from}|${p.to}`
    const hit = dashCache.get(key)
    if (hit && Date.now() - hit.at < 60 * 1000 && req.query.fresh !== '1') return res.json({ ok: true, ...hit.value })
    const value = await buildStreamDashboard({ from: p.from, to: p.to })
    // Subscribers don't depend on the period; a failure here must not sink the listening numbers.
    try { value.subscribers = await subscriberCount({ fresh: req.query.fresh === '1' }) }
    catch (e) { value.subscribers = { error: e.message } }
    dashCache.set(key, { at: Date.now(), value })
    if (dashCache.size > 30) dashCache.delete(dashCache.keys().next().value)
    res.json({ ok: true, ...value })
  } catch (err) { next(err) }
})

// <a href> can't set headers, so the download authenticates by ?token= like the
// other file endpoints (youtube/download, the SSE routes).
router.get('/streams.csv', async (req, res, next) => {
  try {
    const token = (req.query.token || req.headers.authorization?.replace('Bearer ', '') || '').trim()
    if (!token || token !== process.env.INGEST_ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' })
    const p = { ...params(req), limit: 5000 }
    const data = await report(p)
    const cell = v => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const head = p.group === 'song'
      ? ['Rank', 'Track', 'Artist', 'Catalogue', 'ISRC', 'Listens', 'Plays 30s+', 'Seconds played', 'Time played', '% of total']
      : p.group === 'album'
        ? ['Rank', 'Album', 'Artist', 'Catalogue', 'Tracks', 'Listens', 'Plays 30s+', 'Seconds played', 'Time played', '% of total']
        : ['Rank', 'Artist', 'Tracks', 'Listens', 'Plays 30s+', 'Seconds played', 'Time played', '% of total']
    const lines = [
      [`MAD listening report ${p.from} to ${p.to} (South African dates), by ${p.group}`],
      [`Total time played`, data.totals.duration, `${data.totals.seconds} seconds`],
      [`Listens`, data.totals.listens, `of which 30s+`, data.totals.plays30],
      [`Songs`, data.totals.songs, `Listeners`, data.totals.listeners],
      [data.previews.counted
        ? `Guest previews INCLUDED in the figures above`
        : `Guest previews excluded: ${data.previews.listens} previews, ${data.previews.duration}`],
      [],
      head,
      ...data.rows.map((r, i) => (p.group === 'song'
        ? [i + 1, r.title, r.subtitle, r.catalogue, r.isrc, r.listens, r.plays30, r.seconds, r.duration, r.share]
        : p.group === 'album'
          ? [i + 1, r.title, r.subtitle, r.catalogue, r.tracks, r.listens, r.plays30, r.seconds, r.duration, r.share]
          : [i + 1, r.title, r.tracks, r.listens, r.plays30, r.seconds, r.duration, r.share])),
    ]
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="mad-listening-${p.group}-${p.from}-to-${p.to}.csv"`)
    res.send('﻿' + lines.map(l => l.map(cell).join(',')).join('\n'))
  } catch (err) { next(err) }
})

export default router
