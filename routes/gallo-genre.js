// routes/gallo-genre.js — the admin "Gallo Genre" tab.
//
// The job: 12,657 Gallo tracks have no `Local Genre`. They are NOT scattered
// odd tracks — they belong to ~1,238 albums that carry no genre at all, so
// nothing can be inferred from a sibling track. The top 263 albums hold half of
// them. So this is an album-at-a-time human job, not a per-track one: listen,
// pick, apply to the whole album.
//
// TWO GENRE FIELDS — only one is ours:
//   Genre       → DDEX/Ingrooves controlled vocabulary. NEVER written here.
//   Local Genre → MadStreamer-facing. Ours, held to lib/genre-taxonomy.js.
// Every write below goes through normalizeGenre, so the tab physically cannot
// introduce a 47th spelling.
//
// Progress needs no state of its own: an album disappears from the worklist as
// soon as its tracks have a genre, because the worklist IS "records where Local
// Genre is empty".
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { adminAuth } from '../lib/admin-auth.js'
import { galloFindEmptyLocalGenre, updateGalloRecord } from '../lib/fm-gallo.js'
import { CANONICAL_GENRES, normalizeGenre } from '../lib/genre-taxonomy.js'

const router = Router()
const FIELD = 'Local Genre'

// The worklist costs ~13 FM pages to build, so cache it. Invalidated on apply
// so an album vanishes from the list the moment it's done.
let _cache = null
let _cacheAt = 0
const CACHE_MS = 5 * 60 * 1000

function invalidate() { _cache = null; _cacheAt = 0 }

async function buildWorklist() {
  const rows = await galloFindEmptyLocalGenre()
  const albums = new Map()
  for (const r of rows) {
    const f = r.fieldData || {}
    const cat    = String(f['Album Catalogue Number'] ?? '').trim()
    const album  = String(f['Album Title'] ?? '').trim()
    const artist = String(f['Album Artist'] ?? '').trim() || String(f['Track Artist'] ?? '').trim()
    // Group on catalogue number when present. Some records carry no album title
    // or artist at all — only a catalogue — so album name alone is not a safe key.
    const key = cat ? `cat:${cat.toLowerCase()}` : `alb:${album.toLowerCase()}|${artist.toLowerCase()}`
    if (!albums.has(key)) albums.set(key, { key, cat, album, artist, tracks: [] })
    const a = albums.get(key)
    if (!a.album  && album)  a.album  = album
    if (!a.artist && artist) a.artist = artist
    a.tracks.push({
      recordId: String(r.recordId),
      title:    String(f['Track Name'] ?? '').trim(),
      seq:      parseInt(f['Sequence Number'], 10) || null,
    })
  }
  return [...albums.values()]
    .map(a => ({ ...a, count: a.tracks.length, tracks: a.tracks.sort((x, y) => (x.seq ?? 999) - (y.seq ?? 999)) }))
    .sort((a, b) => b.count - a.count)   // biggest first — clears the backlog fastest
}

/** GET /albums — the worklist, biggest album first. */
router.get('/albums', adminAuth, async (req, res) => {
  try {
    if (!_cache || Date.now() - _cacheAt > CACHE_MS) {
      _cache = await buildWorklist()
      _cacheAt = Date.now()
    }
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500)
    const offset = parseInt(req.query.offset, 10) || 0
    const q      = String(req.query.q || '').trim().toLowerCase()
    const filtered = q
      ? _cache.filter(a => `${a.cat} ${a.album} ${a.artist}`.toLowerCase().includes(q))
      : _cache
    res.json({
      genres: CANONICAL_GENRES,
      totalAlbums: filtered.length,
      totalTracks: filtered.reduce((s, a) => s + a.count, 0),
      albums: filtered.slice(offset, offset + limit),
      cachedAt: new Date(_cacheAt).toISOString(),
    })
  } catch (e) {
    console.error('[gallo-genre] albums failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /apply — set Local Genre on the given records.
 * Body: { recordIds: string[], genre: string }
 * Accepts explicit recordIds (captured when the list was drawn) rather than an
 * album key, so a later edit elsewhere can't silently widen what gets written —
 * and so the "split this album" case can send a subset.
 */
router.post('/apply', adminAuth, async (req, res) => {
  try {
    const { recordIds, genre } = req.body || {}
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds required' })
    if (recordIds.length > 500) return res.status(400).json({ error: 'too many records in one apply (max 500)' })

    const target = normalizeGenre(genre)
    if (!target) {
      return res.status(400).json({
        error: `"${genre}" is not in the agreed vocabulary. Pick one of the ${CANONICAL_GENRES.length}, or add it to lib/genre-taxonomy.js deliberately.`
      })
    }

    // Rollback journal, written BEFORE the first write and flushed as we go —
    // same discipline as the bulk cleanup scripts.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = path.join('data', `gallo-genre-tab-${stamp}.json`)
    const journal = []

    let updated = 0
    const failed = []
    for (const id of recordIds) {
      journal.push({ recordId: String(id), field: FIELD, to: target })
      try { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(logPath, JSON.stringify(journal, null, 2)) } catch {}
      try {
        await updateGalloRecord(String(id), { [FIELD]: target })
        updated++
      } catch (e) {
        failed.push({ id, error: e.message })
      }
    }

    invalidate()
    console.log(`[gallo-genre] set ${FIELD}="${target}" on ${updated}/${recordIds.length}${failed.length ? ` (${failed.length} failed)` : ''}`)
    res.json({ updated, failed, genre: target, rollbackFile: logPath })
  } catch (e) {
    console.error('[gallo-genre] apply failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/** POST /refresh — drop the cached worklist (after edits made elsewhere). */
router.post('/refresh', adminAuth, (req, res) => { invalidate(); res.json({ ok: true }) })

export default router
