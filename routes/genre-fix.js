// routes/genre-fix.js — the admin Genre Fix tab.
//
// Workflow: operator picks a Local Genre to review (e.g. "Afro Folk") →
// GET /list returns every track carrying it, grouped by artist with one
// auditionable sample each → operator listens, picks the real genre from the
// FM value list, and POST /apply re-tags that artist's tracks (ONLY the ones
// in the reviewed genre — their other-genre tracks are untouched, which is
// why apply works on explicit recordIds captured at list time).
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { findSongsByLocalGenre, setLocalGenre } from '../lib/madstreamer.js'

const router = Router()

router.get('/list', adminAuth, async (req, res) => {
  try {
    const genre = String(req.query.genre || '').trim()
    if (!genre) return res.status(400).json({ error: 'genre is required' })
    const songs = await findSongsByLocalGenre(genre)
    const byArtist = new Map()
    for (const s of songs) {
      let a = byArtist.get(s.artist)
      if (!a) byArtist.set(s.artist, (a = { artist: s.artist, recordIds: [], sample: null, albums: new Set() }))
      a.recordIds.push(s.recordId)
      if (s.album) a.albums.add(s.album)
      if (!a.sample && s.s3url) a.sample = { title: s.title, album: s.album, year: s.year, url: s.s3url }
    }
    const artists = [...byArtist.values()]
      .map(a => ({ artist: a.artist, count: a.recordIds.length, albumCount: a.albums.size, sample: a.sample, recordIds: a.recordIds }))
      .sort((x, y) => y.count - x.count)
    res.json({ genre, totalTracks: songs.length, artists })
  } catch (e) {
    console.error('[genre-fix] list failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/apply', adminAuth, async (req, res) => {
  try {
    const { recordIds, toGenre } = req.body || {}
    const target = String(toGenre || '').trim()
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds required' })
    if (!target) return res.status(400).json({ error: 'toGenre required' })
    if (recordIds.length > 2000) return res.status(400).json({ error: 'too many records in one apply (max 2000)' })
    let updated = 0
    const failed = []
    for (const id of recordIds) {
      try { await setLocalGenre(String(id), target); updated++ }
      catch (e) { failed.push({ id, error: e.message }) }
    }
    console.log(`[genre-fix] re-tagged ${updated}/${recordIds.length} records → "${target}"${failed.length ? ` (${failed.length} failed)` : ''}`)
    res.json({ updated, failed })
  } catch (e) {
    console.error('[genre-fix] apply failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
