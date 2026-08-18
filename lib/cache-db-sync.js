/**
 * lib/cache-db-sync.js — carry Cache Viewer edits through to the FM databases.
 *
 * The metadata cache is the editing surface; Gallo Catalogue, CMS 2024 and
 * MadStreamer each hold their own copy of the same track. This module turns
 * one cache-row edit into a per-database push:
 *
 *   previewDbSync()  — match the edited row(s) against all three DBs and
 *                      return update/create targets with old → new diffs,
 *                      WITHOUT writing anything.
 *   applyDbSync()    — execute the targets the user confirmed.
 *
 * Matching mirrors the DB-sync matrix: ISRC first, then sequence + fuzzy
 * title. Identity values are taken from BEFORE the edit (the `changes` map
 * carries from/to), so fixing a wrong ISRC still finds the record that holds
 * the wrong one.
 */

import {
  findGalloRecordsByCatalogue, updateGalloRecord, createGalloRecord,
  createTapeFileRecord, getGalloLayoutFieldSet, getGalloTrack,
} from './fm-gallo.js'
import {
  findRecordsByCatalogue as findCmsRecordsByCatalogue,
  updateRecord           as updateCmsRecord,
  createRecord           as createCmsRecord,
} from './fm-cms2024.js'
import {
  findRecordsByCatalogue as findStreamerRecordsByCatalogue,
  updateStreamerRecord, upsertMp3Record, upsertTapeFileRecord,
} from './madstreamer.js'
import { lookupAlbumTracks, ALBUM_FIELD_KEYS } from './metadata-cache.js'
import { fuzzyScore } from './fuzzy-match.js'
import { normalizeGenre } from './genre-taxonomy.js'
import { languageNameToCode } from './language-codes.js'

const ALBUM_KEYS = new Set(ALBUM_FIELD_KEYS)

// Same threshold the DB-sync matrix uses for seq + title matching.
const FUZZY_TITLE_THRESHOLD = 0.7

export const DB_LABELS = { gallo: 'Gallo Catalogue', cms2024: 'CMS 2024', streamer: 'MadStreamer' }

// ── Value coercers ────────────────────────────────────────────────────────────

// FM time fields reject bare seconds and ISO-8601 — always full HH:MM:SS.
function toFmTime(v) {
  if (v == null || v === '') return ''
  let sec = null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) sec = Math.round(parseFloat(s))
  else {
    const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
    if (iso) sec = Math.round((+iso[1] || 0) * 3600 + (+iso[2] || 0) * 60 + (+iso[3] || 0))
    else {
      const parts = s.split(':').map(p => parseFloat(p))
      if (parts.length && parts.every(n => !isNaN(n))) {
        if (parts.length === 3)      sec = Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
        else if (parts.length === 2) sec = Math.round(parts[0] * 60 + parts[1])
      }
    }
  }
  if (sec == null) return s   // unparseable — pass through rather than guess
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`
}

// Dates go to FM as ISO YYYY-MM-DD; M/D/YYYY is normalised, anything else
// passes through untouched (a wrong date is worse than an unconverted one).
function toFmDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return s
  const pad = n => String(n).padStart(2, '0')
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}`
}

const str = v => (v == null) ? '' : String(v)

// Split a "A; B; C" credits string into up to 4 CMS slot fields, clearing the
// unused slots so stale extra names can't survive an edit.
function creditSlots(prefix, v) {
  const names = String(v ?? '').split(/[;,|]/).map(s => s.trim()).filter(Boolean)
  const out = {}
  out[prefix]          = names[0] || ''
  out[`${prefix} 2`]   = names[1] || ''
  out[`${prefix} 3`]   = names[2] || ''
  out[`${prefix} 4`]   = names[3] || ''
  return out
}

function languageFields(v) {
  const out = { Language: str(v) }
  if (v) {
    const iso = String(v).length <= 3 ? String(v) : languageNameToCode(String(v))
    if (iso) out['Language Code'] = iso
  }
  return out
}

// ── Per-DB field builders ─────────────────────────────────────────────────────
// Cache field key → FM fieldData fragment. Dual names (Composers/Composer,
// Barcode/UPC, …) are both sent; the layout-introspection filter keeps
// whichever exists — the same trick createGalloRecord uses.

const GALLO_BUILDERS = {
  album_title:           v => ({ 'Album Title': str(v) }),
  album_artist:          v => ({ 'Album Artist': str(v) }),
  release_date:          v => ({ 'Release Date': toFmDate(v) }),
  original_release_date: v => ({ 'Original Release date': toFmDate(v) }),
  catalogue:             v => ({ 'Album Catalogue Number': str(v), 'Reference Catalogue Number': str(v) }),
  barcode:               v => ({ 'Barcode': str(v), 'UPC': str(v) }),
  language:              v => languageFields(v),
  isrc:                  v => ({ 'ISRC': str(v) }),
  label:                 v => ({ 'Label': str(v) }),
  p_line:                v => ({ 'pLine': str(v) }),
  c_line:                v => ({ 'cLine': str(v) }),
  track_name:            v => ({ 'Track Name': str(v) }),
  track_artist:          v => ({ 'Track Artist': str(v) }),
  seq:                   v => ({ 'Sequence Number': str(v), 'Track Number': v == null ? '' : Number(v) }),
  duration:              v => ({ 'Duration': toFmTime(v) }),
  genre:                 v => {
    // Genre feeds DDEX verbatim; Local Genre only via the 45-value taxonomy.
    const out = { 'Genre': str(v) }
    const lg = normalizeGenre(v)
    if (lg || !v) out['Local Genre'] = lg || ''
    return out
  },
  audio_language:        v => ({ 'Audio language': str(v) }),
  composer:              v => ({ 'Composers': str(v), 'Composer': str(v) }),
  publisher:             v => ({ 'Publishers': str(v), 'Publisher': str(v) }),
  producer:              v => ({ 'Producers': str(v), 'Producer': str(v) }),
  parental:              v => ({ 'Lyrical Content rating': str(v), 'Parental': str(v) }),
  rights_territories:    v => ({ 'Rights Territories': str(v) }),
  featured_artist:       v => ({ 'Featured Artist': str(v) }),
}

const CMS_BUILDERS = {
  ...GALLO_BUILDERS,
  track_name: v => ({ 'Song Title': str(v), 'Track Name': str(v) }),
  parental:   v => ({ 'Parental': str(v), 'Lyrical Content Rating': str(v) }),
  composer:   v => ({ 'Composers': str(v), ...creditSlots('Composer', v) }),
  producer:   v => ({ 'Producers': str(v), ...creditSlots('Producer', v) }),
}

const STREAMER_BUILDERS = {
  ...GALLO_BUILDERS,
  seq:      v => ({ 'Sequence Number': str(v) }),
  parental: v => ({ 'Lyrical Content Rating': str(v) }),
  genre:    v => {
    // Streamer's Local Genre is held to the 45-value taxonomy. An
    // unrecognised (or cleared) value is skipped, not written — a blank or
    // rogue value here would undo the normalisation one record at a time.
    const g = normalizeGenre(v)
    return g ? { 'Genre': g, 'Local Genre': g } : {}
  },
}

const BUILDERS = { gallo: GALLO_BUILDERS, cms2024: CMS_BUILDERS, streamer: STREAMER_BUILDERS }

/** Build raw FM fieldData for `keys` of a cache row. */
export function buildFieldData(db, row, keys) {
  const builders = BUILDERS[db]
  const out = {}
  for (const k of keys) {
    const b = builders[k]
    if (b) Object.assign(out, b(row[k]))
  }
  return out
}

// ── Create-payload builders (full row → new record) ───────────────────────────

function galloMetadataFromRow(r) {
  return {
    title:                 r.track_name,
    artist:                r.track_artist || r.album_artist,
    album_artist:          r.album_artist,
    featured_artist:       r.featured_artist,
    album:                 r.album_title,
    catalogue_no:          r.catalogue,
    isrc:                  r.isrc,
    barcode:               r.barcode,
    sequence_no:           r.seq,
    release_date:          toFmDate(r.release_date) || undefined,
    original_release_date: toFmDate(r.original_release_date) || undefined,
    genre:                 r.genre,
    language:              r.language,
    rights_territories:    r.rights_territories,
    duration:              r.duration ? toFmTime(r.duration) : undefined,
    composers:             r.composer,
    producers:             r.producer,
    publishers:            r.publisher,
    label:                 r.label,
    p_line:                r.p_line,
    c_line:                r.c_line,
    parental:              r.parental,
  }
}

function streamerMetadataFromRow(r) {
  return {
    title:                 r.track_name,
    artist:                r.track_artist || r.album_artist,
    album_artist:          r.album_artist,
    album:                 r.album_title,
    catalogue_no:          r.catalogue,
    isrc:                  r.isrc,
    barcode:               r.barcode,
    sequence_no:           r.seq,
    original_release_date: r.original_release_date,
    genre:                 r.genre,
    language:              r.language,
    duration:              r.duration ? toFmTime(r.duration) : undefined,
    composers:             r.composer,
    producers:             r.producer,
    label:                 r.label,
    p_line:                r.p_line,
    c_line:                r.c_line,
    explicit:              r.parental,
  }
}

function cmsFieldDataFromRow(r) {
  const keys = Object.keys(CMS_BUILDERS).filter(k => r[k] != null && r[k] !== '')
  return buildFieldData('cms2024', r, keys)
}

// ── Old-value readers (for the preview diff) ──────────────────────────────────

const joinNames = v => Array.isArray(v) ? v.join('; ') : (v ?? null)
const secToTime = sec => sec == null ? null : toFmTime(sec)

// Gallo + CMS both return the mapped track shape; keys differ slightly.
function oldFromMapped(t, key) {
  switch (key) {
    case 'album_title':           return t.album_title ?? null
    case 'album_artist':          return t.album_artist ?? null
    case 'release_date':          return t.release_date ?? null
    case 'original_release_date': return t.original_release_date ?? null
    case 'catalogue':             return t.catalogue_no ?? null
    case 'barcode':               return t.barcode ?? null
    case 'language':              return t.language ?? null
    case 'isrc':                  return t.isrc ?? null
    case 'label':                 return t.label ?? null
    case 'p_line':                return t.pline_text ?? t.p_line ?? null
    case 'c_line':                return t.cline_text ?? t.c_line ?? null
    case 'track_name':            return t.title ?? null
    case 'track_artist':          return t.artist_name ?? t.artist ?? null
    case 'seq':                   return t.sequence_no ?? null
    case 'duration':              return t.duration_sec != null ? secToTime(t.duration_sec) : (t.duration ?? null)
    case 'genre':                 return t.genre ?? null
    case 'composer':              return joinNames(t.composers)
    case 'publisher':             return joinNames(t.publishers)
    case 'producer':              return joinNames(t.producers)
    case 'parental':              return t.parental ?? (t.explicit === true ? 'Explicit' : t.explicit === false ? 'NotExplicit' : null)
    case 'rights_territories':    return t.rights_territories ?? null
    case 'featured_artist':       return t.featured_artist ?? null
    default:                      return null
  }
}

// Streamer matches come back slim + raw fieldData — read FM names directly.
function oldFromStreamer(t, key) {
  const f = t.fieldData || {}
  const pick = (...names) => { for (const n of names) { const v = f[n]; if (v != null && String(v).trim() !== '') return v } return null }
  switch (key) {
    case 'album_title':           return pick('Album Title')
    case 'album_artist':          return pick('Album Artist')
    case 'original_release_date': return pick('Original Release date', 'Original Release Date')
    case 'release_date':          return pick('Release Date')
    case 'catalogue':             return t.catalogue_no ?? null
    case 'barcode':               return pick('UPC', 'Barcode')
    case 'language':              return pick('Language Code', 'Language')
    case 'isrc':                  return t.isrc ?? null
    case 'label':                 return pick('Label')
    case 'p_line':                return pick('pLine')
    case 'c_line':                return pick('cLine')
    case 'track_name':            return t.title ?? null
    case 'track_artist':          return t.artist ?? null
    case 'seq':                   return t.sequence_no ?? null
    case 'duration':              return pick('Duration')
    case 'genre':                 return pick('Local Genre', 'Genre')
    case 'composer':              return pick('Composers', 'Composer')
    case 'publisher':             return pick('Publishers', 'Publisher')
    case 'producer':              return pick('Producers', 'Producer')
    case 'parental':              return pick('Lyrical Content Rating')
    case 'rights_territories':    return pick('Rights Territories')
    case 'featured_artist':       return pick('Featured Artist')
    default:                      return null
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Match one cache row against a DB's tracks for the same catalogue.
 * identity carries PRE-edit values. Order: ISRC → seq + fuzzy title → seq
 * (only when that seq is unique in the DB's track list).
 */
function matchTrack(identity, tracks, taken) {
  const isrc = identity.isrc ? String(identity.isrc).trim().toUpperCase() : null
  if (isrc) {
    const hit = tracks.find(t => !taken.has(t) && t.isrc && String(t.isrc).trim().toUpperCase() === isrc)
    if (hit) return { track: hit, matchedBy: 'isrc' }
  }
  const seq = identity.seq ?? null
  if (seq != null) {
    const seqHits = tracks.filter(t => !taken.has(t) && t.sequence_no === seq)
    if (identity.title) {
      let best = null, bestScore = 0
      for (const t of seqHits) {
        const score = fuzzyScore(t.title || '', identity.title)
        if (score > bestScore && score >= FUZZY_TITLE_THRESHOLD) { best = t; bestScore = score }
      }
      if (best) return { track: best, matchedBy: 'seq+title' }
    }
    if (seqHits.length === 1 && !identity.title) return { track: seqHits[0], matchedBy: 'seq' }
  }
  return { track: null, matchedBy: null }
}

// ── Preview ───────────────────────────────────────────────────────────────────

/**
 * Build the push plan for a BATCH of Cache Viewer edits.
 *
 * @param edits  [{ row, changes: { key: { from, to } }, albumWide }] — rows
 *               already hold the NEW (saved) values; `changes` carries the
 *               pre-edit values for identity matching.
 * @returns { catalogues, albumTrackCount, targets, dbErrors, warnings }
 */
export async function previewDbSync({ edits = [] }) {
  const warnings = []

  // One work entry per affected cache row: the union of keys to write, plus
  // the identity + catalogue to match it with. Rows can be hit twice (edited
  // directly AND as an album sibling of another edit) — keys union, and the
  // directly-edited identity wins.
  const work  = []
  const byRow = new Map()
  const catalogues = new Set()
  const addWork = (row, keys, { identity = null, fetchCat, edited = false }) => {
    let w = byRow.get(row)
    if (!w) {
      w = { row, keys: new Set(), fetchCat,
            identity: { isrc: row.isrc, seq: row.seq, title: row.track_name }, edited: false }
      byRow.set(row, w)
      work.push(w)
    }
    for (const k of keys) w.keys.add(k)
    if (edited) { w.edited = true; w.fetchCat = fetchCat; if (identity) w.identity = identity }
  }

  for (const e of edits) {
    const changedKeys = Object.keys(e.changes || {})
    if (!changedKeys.length) continue
    const albumKeys = changedKeys.filter(k => ALBUM_KEYS.has(k))
    // Match on the PRE-edit catalogue — the DBs still hold the old value.
    const oldCat = e.changes.catalogue ? e.changes.catalogue.from : e.row.catalogue
    if (!oldCat) {
      warnings.push(`"${e.row.track_name || e.row.album_title || '?'}" has no catalogue number — skipped (databases are matched per catalogue)`)
      continue
    }
    catalogues.add(oldCat)
    addWork(e.row, changedKeys, {
      edited: true,
      fetchCat: oldCat,
      identity: {
        isrc:  e.changes.isrc       ? e.changes.isrc.from                        : e.row.isrc,
        seq:   e.changes.seq        ? (parseInt(e.changes.seq.from, 10) || null) : e.row.seq,
        title: e.changes.track_name ? e.changes.track_name.from                  : e.row.track_name,
      },
    })
    if (e.albumWide !== false && albumKeys.length && e.row.catalogue) {
      for (const sib of lookupAlbumTracks(e.row.catalogue)) {
        if (sib !== e.row) addWork(sib, albumKeys, { fetchCat: oldCat })
      }
    }
  }

  // One fetch of each catalogue's records per DB, shared by every edit in it.
  const dbErrors = {}
  const perCat   = new Map()
  await Promise.all([...catalogues].map(async cat => {
    const [g, c, s] = await Promise.allSettled([
      findGalloRecordsByCatalogue(cat),
      findCmsRecordsByCatalogue(cat),
      findStreamerRecordsByCatalogue(cat, { includeFieldData: true }),
    ])
    perCat.set(cat, {
      gallo:    g.status === 'fulfilled' ? g.value : null,
      cms2024:  c.status === 'fulfilled' ? c.value : null,
      streamer: s.status === 'fulfilled' ? s.value : null,
    })
    for (const [db, r] of [['gallo', g], ['cms2024', c], ['streamer', s]]) {
      if (r.status === 'rejected' && !dbErrors[db]) dbErrors[db] = r.reason?.message || String(r.reason)
    }
  }))

  const targets = []
  const taken   = new Map()   // `${cat}|${db}` → Set of matched track objects
  const takenFor = (cat, db) => {
    const k = `${cat}|${db}`
    if (!taken.has(k)) taken.set(k, new Set())
    return taken.get(k)
  }

  for (const w of work) {
    const dbTracks = perCat.get(w.fetchCat)
    if (!dbTracks) continue
    const keys = [...w.keys]
    for (const db of ['gallo', 'cms2024', 'streamer']) {
      if (!dbTracks[db]) continue   // that DB errored — reported, not guessed at
      const { track, matchedBy } = matchTrack(w.identity, dbTracks[db], takenFor(w.fetchCat, db))
      const oldOf = db === 'streamer' ? oldFromStreamer : oldFromMapped
      if (track) takenFor(w.fetchCat, db).add(track)
      targets.push({
        db,
        action:    track ? 'update' : 'create',
        recordId:  track ? (track.fm_record_id || track.recordId || null) : null,
        matchedBy: track ? matchedBy : null,
        catalogue: w.fetchCat,
        seq:       w.row.seq ?? null,
        title:     w.row.track_name || null,
        artist:    w.row.track_artist || w.row.album_artist || null,
        keys,
        row:       { ...w.row },
        fields:    keys.map(k => ({ key: k, old: track ? oldOf(track, k) : null, new: w.row[k] ?? null })),
      })
    }
  }

  return {
    catalogues: [...catalogues],
    albumTrackCount: work.length,
    targets,
    dbErrors,
    warnings,
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Execute confirmed push targets (the objects previewDbSync returned, minus
 * any the user unticked). Sequential per target — FM tokens are reused and
 * the result list stays in a stable order.
 */
export async function applyDbSync(targets = []) {
  const results = []
  // Track which DBs had zero records before creates — those albums get a
  // Tape/album record too, mirroring pull-catalogue-to-gallo.
  const createdIn = { gallo: false, streamer: false }
  let albumRow = null

  for (const t of targets) {
    const ref = { db: t.db, action: t.action, seq: t.seq, title: t.title, recordId: t.recordId }
    try {
      if (t.action === 'update') {
        const fieldData = buildFieldData(t.db, t.row, t.keys)
        if (t.db === 'gallo') {
          let payload = fieldData
          try {
            const known = await getGalloLayoutFieldSet()
            payload = Object.fromEntries(Object.entries(fieldData).filter(([k]) => known.has(k)))
          } catch { /* introspection down — send as-built */ }
          if (!Object.keys(payload).length) throw new Error('No writable fields on the Gallo layout for this edit')
          await updateGalloRecord(t.recordId, payload)
          results.push({ ...ref, ok: true, fields: Object.keys(payload) })
        } else if (t.db === 'cms2024') {
          const { dropped } = await updateCmsRecord(t.recordId, fieldData)
          results.push({ ...ref, ok: true, fields: Object.keys(fieldData).filter(k => !dropped?.includes(k)) })
        } else {
          const { dropped } = await updateStreamerRecord(t.recordId, fieldData)
          results.push({ ...ref, ok: true, fields: Object.keys(fieldData).filter(k => !dropped?.includes(k)) })
        }
      } else {
        // CREATE — the track is missing from this DB entirely.
        albumRow = albumRow || t.row
        if (t.db === 'gallo') {
          // Same ISRC may live under another catalogue (re-issues) — Gallo's
          // unique-ISRC validation would reject the create with a cryptic 504.
          const elsewhere = t.row.isrc ? await getGalloTrack({ isrc: t.row.isrc }).catch(() => null) : null
          if (elsewhere) {
            results.push({ ...ref, ok: true, action: 'exists-other-catalogue', recordId: elsewhere.fm_record_id, note: `already in Gallo under catalogue "${elsewhere.catalogue_no || '?'}"` })
          } else {
            const created = await createGalloRecord(galloMetadataFromRow(t.row))
            createdIn.gallo = true
            results.push({ ...ref, ok: true, recordId: created.fmRecordId })
          }
        } else if (t.db === 'cms2024') {
          const { recordId } = await createCmsRecord(cmsFieldDataFromRow(t.row))
          results.push({ ...ref, ok: true, recordId })
        } else {
          const { recordId, action } = await upsertMp3Record(streamerMetadataFromRow(t.row))
          results.push({ ...ref, ok: true, recordId, action: action === 'updated' ? 'update' : 'create' })
        }
      }
    } catch (err) {
      results.push({ ...ref, ok: false, error: err.message })
    }
  }

  // Album shells for DBs that were entirely missing this album. Only when a
  // track create actually landed — an album living under another catalogue
  // must not get an empty shell.
  const tape = {}
  if (albumRow) {
    const album = {
      album_artist:          albumRow.album_artist || albumRow.track_artist,
      album:                 albumRow.album_title,
      catalogue_no:          albumRow.catalogue,
      barcode:               albumRow.barcode,
      release_date:          albumRow.release_date,
      original_release_date: albumRow.original_release_date,
      genre:                 albumRow.genre,
      language:              albumRow.language,
      label:                 albumRow.label,
      p_line:                albumRow.p_line,
      c_line:                albumRow.c_line,
      publishers:            albumRow.publisher,
    }
    if (createdIn.gallo && !targets.some(t => t.db === 'gallo' && t.action === 'update')) {
      try { tape.gallo = await createTapeFileRecord(album) }
      catch (err) { tape.gallo = { error: err.message } }
    }
    const streamerCreated = results.some(r => r.db === 'streamer' && r.ok && r.action === 'create')
    if (streamerCreated && !targets.some(t => t.db === 'streamer' && t.action === 'update')) {
      try { tape.streamer = await upsertTapeFileRecord(album) }
      catch (err) { tape.streamer = { error: err.message } }
    }
  }

  const ok = results.filter(r => r.ok).length
  return { ok: true, succeeded: ok, failed: results.length - ok, results, tape }
}
