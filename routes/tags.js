// routes/tags.js — the Tags tab: read the catalogue's sync tags, fix them by hand.
//
// The tags come from MAD-Analyzer's sync_tagger.py (CLAP scores each recording
// against phrases written the way briefs are written). A model gets the mood
// roughly right and the occasional track plainly wrong, so every tag has to be
// correctable by someone with ears — that is what this tab is for.
//
// READS come from the nightly Postgres mirror: filtering 67,000 tracks by genre,
// mood and confidence is instant there and would be punishing over the Data API.
// WRITES go straight to MADStreamer, so a correction is in the live database at
// once; the mirror (and therefore this tab's filters) catches up after the
// ~01:00 sync. The UI keeps edited rows on screen so the work still reads back
// correctly in the meantime.
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { mirrorQuery, isMirrorEnabled } from '../lib/mirror-db.js'
import { updateStreamerRecord } from '../lib/madstreamer.js'

const router = Router()

// The vocabulary the tagger uses. Kept here so the tab offers the same words
// rather than inviting free text that nothing can search on later.
export const TAG_VOCAB = Object.freeze({
  mood: ['Joyful', 'Melancholic', 'Tender', 'Calm', 'Hypnotic', 'Defiant', 'Spiritual', 'Nostalgic',
         'Playful', 'Dramatic', 'Lonely', 'Triumphant', 'Sensual', 'Restless', 'Solemn'],
  theme: ['Film', 'Advertising', 'Documentary', 'Trailer', 'Sport', 'Party', 'Funeral', 'Wedding',
          'Street', 'Rural', 'Opening', 'Closing'],
  vocal: ['Instrumental', 'Vocal', 'Choir', 'Spoken'],
  // South African scenes — the phrases a local brief actually starts from, and
  // the reason someone searches this catalogue rather than a stock library.
  // Must stay in step with SCENES in MAD-Analyzer/sync_tagger.py.
  scene: ['Kwela street', 'Shebeen', 'Marabi piano', 'Sophiatown jazz', 'Cape goema', 'Mbaqanga groove',
          'Maskandi guitar', 'Isicathamiya', 'Mine dance', 'Township jive', 'Bubblegum 80s', 'Kwaito street',
          'Amapiano lounge', 'Church hall', 'Freedom song', 'Ancestral ceremony', 'Ululation', 'Bushveld',
          'Karoo', 'Boeremusiek dance', 'Stadium crowd', 'Mission hymn'],
  texture: ['Acoustic', 'Electric', 'Brass', 'Accordion', 'Percussive', 'Strings', 'Sparse', 'Lo-fi'],
})

const FIELDS = { mood: 'AI_Mood_v2', theme: 'AI_Theme', vocal: 'AI_Vocal',
                 tags: 'AI_Tags', confidence: 'AI_Tag_Confidence' }

/** GET /api/tags/search — filtered page of tracks with their tags. */
router.get('/search', adminAuth, async (req, res) => {
  if (!isMirrorEnabled()) return res.status(503).json({ error: 'The catalogue mirror is not configured on this server' })
  const q = String(req.query.q || '').trim()
  const genre = String(req.query.genre || '').trim()
  const mood = String(req.query.mood || '').trim()
  const vocal = String(req.query.vocal || '').trim()
  const state = String(req.query.state || 'all').trim()     // all | tagged | untagged | unsure
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)

  const where = [`raw->>'Filename' <> ''`]
  const args = []
  const param = (value) => { args.push(value); return `$${args.length}` }
  if (q) {
    const p = param(q)
    where.push(`(track_title ILIKE '%' || ${p} || '%' OR album_artist ILIKE '%' || ${p} || '%' OR catalogue_no ILIKE '%' || ${p} || '%')`)
  }
  if (genre) where.push(`genre = ${param(genre)}`)
  if (mood) where.push(`raw->>'AI_Mood_v2' = ${param(mood)}`)
  if (vocal) where.push(`raw->>'AI_Vocal' = ${param(vocal)}`)
  if (state === 'tagged') where.push(`coalesce(raw->>'AI_Mood_v2','') <> ''`)
  if (state === 'untagged') where.push(`coalesce(raw->>'AI_Mood_v2','') = ''`)
  // "Unsure" is where a human is worth most: the model picked a mood it was
  // barely surer of than the runner-up.
  if (state === 'unsure') where.push(`coalesce(raw->>'AI_Mood_v2','') <> '' AND (raw->>'AI_Tag_Confidence')::numeric < 40`)

  try {
    const sql = `SELECT fm_record_id, track_title, album_artist, album_title, catalogue_no, genre, release_year,
        raw->>'Filename' filename, raw->>'S3_URL' audio,
        raw->>'AI_Mood_v2' mood, raw->>'AI_Theme' theme, raw->>'AI_Vocal' vocal,
        raw->>'AI_Tags' tags, raw->>'AI_Tag_Confidence' confidence,
        raw->>'AI_Mood' old_mood, raw->>'AI_BPM' bpm, raw->>'AI_Key' musical_key,
        raw->>'AI_Energy' energy, raw->>'Duration' duration, raw->>'ISRC' isrc,
        raw->>'Composers' composers, raw->>'Label' label
      FROM tracks WHERE ${where.join(' AND ')}
      ORDER BY album_artist, album_title, track_seq NULLS LAST
      LIMIT ${limit} OFFSET ${offset}`
    const [rows, count] = await Promise.all([
      mirrorQuery(sql, args),
      mirrorQuery(`SELECT count(*)::int n FROM tracks WHERE ${where.join(' AND ')}`, args),
    ])
    res.json({ ok: true, total: count.rows[0].n, offset, limit, tracks: rows.rows, vocab: TAG_VOCAB })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/** GET /api/tags/genres — genre list for the filter, with how many are tagged. */
router.get('/genres', adminAuth, async (_req, res) => {
  if (!isMirrorEnabled()) return res.status(503).json({ error: 'The catalogue mirror is not configured on this server' })
  try {
    const r = await mirrorQuery(`SELECT genre, count(*)::int total,
        count(*) FILTER (WHERE coalesce(raw->>'AI_Mood_v2','') <> '')::int tagged
      FROM tracks WHERE coalesce(genre,'') <> '' GROUP BY genre ORDER BY total DESC`)
    res.json({ ok: true, genres: r.rows })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/**
 * PATCH /api/tags/:recordId — correct one track's tags in MADStreamer.
 * Only the five AI_* tag fields are writable here, and mood/theme/vocal must
 * come from the vocabulary: a free-typed "uplifting" would be invisible to every
 * search built on these tags (the same trap as Genre Fix, 2026-09-15).
 */
router.patch('/:recordId', adminAuth, express.json(), async (req, res) => {
  const body = req.body || {}
  const fieldData = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    if (!(key in body)) continue
    const value = String(body[key] ?? '').trim()
    if (TAG_VOCAB[key] && value && !TAG_VOCAB[key].includes(value)) {
      return res.status(400).json({ error: `"${value}" is not one of the ${key} tags: ${TAG_VOCAB[key].join(', ')}` })
    }
    fieldData[field] = value
  }
  if (!Object.keys(fieldData).length) return res.status(400).json({ error: 'nothing to change' })
  // A human correction is certain by definition.
  if (fieldData[FIELDS.mood] && !('confidence' in body)) fieldData[FIELDS.confidence] = '100'
  try {
    const out = await updateStreamerRecord(req.params.recordId, fieldData)
    if (out.dropped?.length) {
      return res.status(409).json({
        error: `MADStreamer has no field(s) ${out.dropped.join(', ')} on the API layout — add them and place them on API_Album_Songs`,
        dropped: out.dropped,
      })
    }
    console.log(`[tags] ${req.params.recordId}: ${Object.entries(fieldData).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    res.json({ ok: true, recordId: out.recordId, written: fieldData })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

export default router
