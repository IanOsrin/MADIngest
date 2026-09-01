/**
 * lib/mam-cache-fill.js — fill a MAM album's blanks from the metadata cache.
 *
 * MAM was merged from the three FileMaker databases (Catalogue, CMS,
 * MadStreamer). The metadata cache — the Ingrooves extract plus the Alex ISRC
 * register — was never one of its sources, so albums that came in as
 * `Sources=cat` routinely have no ISRC, no barcode, no publisher, even though
 * the cache holds all of it. SMCD 185 (Henry Ate) is the case that surfaced it.
 *
 * Two rules, the same ones the audio linker follows:
 *
 *  1. Fill EMPTY fields only. Never overwrite a value already in MAM — the
 *     cache is a good source, not an authority, and re-pointing existing data
 *     is a different decision from filling a gap.
 *  2. Match on normalised TITLE, never on position. Cache rows and MAM tracks
 *     do not agree on numbering (SMCD 185's cache is missing "Hey Mister"
 *     entirely, so every row after it is off by one).
 *
 * Near-miss titles are reported as SUGGESTIONS with their score and never
 * applied automatically: "Eudiamonia"/"Eudaimonia" and "Station Beach"/"Station
 * Bench" are real spelling drift, but so is a genuinely different song.
 */
import { lookupAlbumTracks } from './metadata-cache.js'
import { mamSession, findMamAlbum } from './fm-mam-write.js'
import { languageParts } from './language-codes.js'

const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const has = v => String(v ?? '').trim() !== ''

/** Dice coefficient on bigrams — cheap, and forgiving of one-letter drift. */
function similarity(a, b) {
  a = tn(a); b = tn(b)
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1) } return g }
  const ga = grams(a), gb = grams(b)
  let hit = 0
  for (const [k, n] of ga) hit += Math.min(n, gb.get(k) || 0)
  const total = [...ga.values()].reduce((x, y) => x + y, 0) + [...gb.values()].reduce((x, y) => x + y, 0)
  return total ? (2 * hit) / total : 0
}

/** Excel-ish "7/15/1996" and ISO both appear in the cache. */
function isoDate(v) {
  const s = String(v || '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

/** Cache credits carry role tags — "Henry Ate <Lyricist>, Henry Ate <Composer>". */
const stripTags = v => {
  const names = String(v || '').split(/\s*,\s*/)
    .map(x => x.replace(/<[^>]*>/g, '').trim()).filter(Boolean)
  return [...new Set(names)].join('; ') || null
}

const nn = v => {
  const s = String(v ?? '').trim()
  return (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') ? null : s
}

/** Fields a cache row can contribute to a MAM song. */
function songFillsFrom(c) {
  const lang = languageParts(nn(c.language) || nn(c.audio_language))
  return {
    'ISRC': nn(c.isrc),
    'Genre': nn(c.genre),
    'Duration': nn(c.duration),
    'Composers': stripTags(c.composer),
    'Composer': stripTags(c.composer),
    'Producers': stripTags(c.producer),
    'Producer': stripTags(c.producer),
    'Publishers': stripTags(c.publisher),
    'Language': lang.name,
    'Language Code': lang.code,
    'pLine': nn(c.p_line),
    'cLine': nn(c.c_line),
    'Rights Territories': nn(c.rights_territories),
    'Original Release Date': isoDate(c.original_release_date) || isoDate(c.release_date),
    'Featured Artist': nn(c.featured_artist),
    'Lyrical Content Rating': /^y/i.test(String(c.parental || '')) ? 'Explicit' : null,
  }
}

function albumFillsFrom(c) {
  return {
    'UPC': nn(c.barcode),
    'Label': nn(c.label),
    'Genre': nn(c.genre),
    'Release Date': isoDate(c.release_date),
    'Year of Release': (isoDate(c.original_release_date) || isoDate(c.release_date) || '').slice(0, 4) || null,
    'Album Title': nn(c.album_title),
    'Album Artist': nn(c.album_artist),
  }
}

/** Keep only the fields that are actually blank on the record right now. */
const gapsOnly = (fills, fieldData) => Object.fromEntries(
  Object.entries(fills).filter(([k, v]) => v !== null && v !== undefined && !has(fieldData[k])))

/**
 * Plan the fill. Writes nothing.
 *
 * @param {string} catalogue
 * @param {object} [opts]
 * @param {number} [opts.suggestAbove]  score at which a near-miss is offered (default 0.60)
 *
 * The bar is deliberately low. A suggestion is never applied without an
 * explicit accept, so hiding a real match costs more than showing a doubtful
 * one: at 0.72, "Eudiamonia"/"Eudaimonia" (0.67) was silently dropped even
 * though it is plainly the same song.
 */
export async function planCacheFill(catalogue, { suggestAbove = 0.60 } = {}) {
  const cat = String(catalogue || '').trim()
  if (!cat) throw Object.assign(new Error('catalogue is required'), { status: 400 })

  const cacheRows = lookupAlbumTracks(cat) || []
  const db = await mamSession()
  try {
    const album = await findMamAlbum(db, cat)
    if (!album) throw Object.assign(new Error(`No album ${cat} in Music Arena Master`), { status: 404 })
    const songs = await db.find('Songs', [{ 'Album Catalogue': '==' + cat }], 500)

    const byTitle = new Map()
    for (const r of cacheRows) {
      const k = tn(r.track_name)
      if (k && !byTitle.has(k)) byTitle.set(k, r)
    }

    const used = new Set()
    const tracks = [], suggestions = []
    for (const s of songs) {
      const g = s.fieldData
      const exact = byTitle.get(tn(g['Track Name']))
      if (exact) {
        used.add(tn(exact.track_name))
        const fills = gapsOnly(songFillsFrom(exact), g)
        tracks.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                      matched: exact.track_name, score: 1, fills, fillCount: Object.keys(fills).length })
        continue
      }
      // No exact title — offer the best near miss for a human to rule on.
      let best = null, bestScore = 0
      for (const r of cacheRows) {
        if (used.has(tn(r.track_name))) continue
        const sc = similarity(g['Track Name'], r.track_name)
        if (sc > bestScore) { bestScore = sc; best = r }
      }
      if (best && bestScore >= suggestAbove) {
        const fills = gapsOnly(songFillsFrom(best), g)
        suggestions.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                           matched: best.track_name, score: Math.round(bestScore * 100) / 100,
                           fills, fillCount: Object.keys(fills).length })
      } else {
        tracks.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                      matched: null, score: 0, fills: {}, fillCount: 0 })
      }
    }

    const albumFills = cacheRows.length
      ? gapsOnly(albumFillsFrom(cacheRows[0]), album.fieldData) : {}

    return {
      catalogue: cat,
      album: { recordId: album.recordId, albumID: album.fieldData.AlbumID,
               title: album.fieldData['Album Title'], artist: album.fieldData['Album Artist'],
               fills: albumFills, fillCount: Object.keys(albumFills).length },
      cacheRows: cacheRows.length,
      songs: songs.length,
      tracks,
      suggestions,
      unusedCacheRows: cacheRows.filter(r => !used.has(tn(r.track_name)))
        .map(r => r.track_name).filter(t => !suggestions.some(s => s.matched === t)),
      totalFills: Object.keys(albumFills).length + tracks.reduce((n, t) => n + t.fillCount, 0),
    }
  } finally { await db.logout() }
}

/**
 * Apply a plan. `acceptSuggestions` is a list of recordIds the caller has
 * explicitly approved — suggestions are never applied without one.
 */
export async function applyCacheFill(catalogue, { acceptSuggestions = [] } = {}) {
  const plan = await planCacheFill(catalogue)
  const accept = new Set(acceptSuggestions.map(String))
  const db = await mamSession()
  try {
    const result = { catalogue, albumUpdated: false, tracksUpdated: 0, fieldsWritten: 0, failures: [] }

    if (plan.album.fillCount) {
      try {
        await db.patch('Albums', plan.album.recordId, plan.album.fills)
        result.albumUpdated = true
        result.fieldsWritten += plan.album.fillCount
      } catch (e) { result.failures.push({ what: 'album', error: e.message }) }
    }

    const todo = [...plan.tracks.filter(t => t.fillCount),
                  ...plan.suggestions.filter(t => t.fillCount && accept.has(String(t.recordId)))]
    for (const t of todo) {
      try {
        await db.patch('Songs', t.recordId, t.fills)
        result.tracksUpdated++
        result.fieldsWritten += t.fillCount
      } catch (e) { result.failures.push({ what: t.title, error: e.message }) }
    }
    return { ...result, plan }
  } finally { await db.logout() }
}
