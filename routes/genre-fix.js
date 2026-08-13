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
import { findSongsByLocalGenre, findSongsByArtist, setLocalGenre, setBadAudio, findBadAudioSongs } from '../lib/madstreamer.js'

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
      if (!a.sample && s.s3url) a.sample = { recordId: s.recordId, title: s.title, album: s.album, year: s.year, url: s.s3url, badAudio: s.badAudio || '' }
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


/**
 * GET /artist-tracks?artist=NAME
 * Every track by an artist, whatever genre it currently carries, grouped by
 * genre. Backs the "apply to ALL tracks by this artist" option: the operator
 * sees exactly what else would be swept up BEFORE confirming, because artists
 * cross genres legitimately — Ladysmith Black Mambazo have 106 gospel tracks
 * that should stay gospel even when retagging the rest to Isicathamiya.
 */
router.get('/artist-tracks', adminAuth, async (req, res) => {
  try {
    const artist = String(req.query.artist || '').trim()
    if (artist.length < 2) return res.status(400).json({ error: 'artist required (2+ chars)' })
    const songs = await findSongsByArtist(artist)
    const byGenre = new Map()
    for (const s of songs) {
      const g = s.localGenre || '(no genre)'
      if (!byGenre.has(g)) byGenre.set(g, [])
      byGenre.get(g).push(s.recordId)
    }
    res.json({
      artist,
      total: songs.length,
      genres: [...byGenre.entries()]
        .map(([genre, recordIds]) => ({ genre, count: recordIds.length, recordIds }))
        .sort((a, b) => b.count - a.count),
    })
  } catch (e) {
    console.error('[genre-fix] artist-tracks failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/apply', adminAuth, async (req, res) => {
  try {
    const { recordIds, toGenre, subGenre } = req.body || {}
    const target = String(toGenre || '').trim()
    // Sub genre rides along with a re-tag: only written when the operator
    // typed one (undefined = leave the records' existing Sub Genre alone).
    const sub = typeof subGenre === 'string' && subGenre.trim() ? subGenre.trim() : undefined
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds required' })
    if (!target) return res.status(400).json({ error: 'toGenre required' })
    if (recordIds.length > 2000) return res.status(400).json({ error: 'too many records in one apply (max 2000)' })
    let updated = 0
    const failed = []
    for (const id of recordIds) {
      try { await setLocalGenre(String(id), target, sub); updated++ }
      catch (e) { failed.push({ id, error: e.message }) }
    }
    console.log(`[genre-fix] re-tagged ${updated}/${recordIds.length} records → "${target}"${sub ? ` (sub: "${sub}")` : ''}${failed.length ? ` (${failed.length} failed)` : ''}`)
    res.json({ updated, failed })
  } catch (e) {
    console.error('[genre-fix] apply failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /bad-audio { recordId, flag } — mark (or clear) the auditioned track's
 * audio as bad. Writes today's date into Bad_Audio on the MadStreamer record
 * so the repair list shows when each problem was caught.
 */
router.post('/bad-audio', adminAuth, async (req, res) => {
  try {
    const recordId = String(req.body?.recordId || '').trim()
    const flag = Boolean(req.body?.flag)
    if (!recordId) return res.status(400).json({ error: 'recordId required' })
    const value = await setBadAudio(recordId, flag)
    console.log(`[genre-fix] bad-audio ${flag ? 'flagged' : 'cleared'}: record ${recordId}`)
    res.json({ ok: true, value })
  } catch (e) {
    console.error('[genre-fix] bad-audio failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/** GET /bad-audio — every track flagged for audio repair. */
router.get('/bad-audio', adminAuth, async (_req, res) => {
  try {
    const tracks = await findBadAudioSongs()
    tracks.sort((a, b) => (a.flagged < b.flagged ? 1 : a.flagged > b.flagged ? -1 : 0))
    res.json({ total: tracks.length, tracks })
  } catch (e) {
    console.error('[genre-fix] bad-audio list failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
