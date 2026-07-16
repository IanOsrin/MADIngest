/**
 * lib/metadata-cache.js
 * Loads Gallo_Metadata_Extract.xlsx into memory as a searchable lookup.
 * Indexed by ISRC and Catalogue Number for fast exact lookups.
 * Call reload() when the file is replaced on disk.
 */

import * as XLSX from 'xlsx'
import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const META_FILE = process.env.METADATA_FILE
  || path.join(__dirname, '..', 'Gallo_Metadata_Extract.xlsx')

// When META_FILE points at a .json file (pre-converted by
// scripts/convert-metadata.js at Docker build time) we skip the SheetJS
// parse entirely — parsing the 60MB+ xlsx needs ~500MB RSS, while loading
// the equivalent JSON stays under ~150MB, letting the app run on small hosts.
const META_IS_JSON = META_FILE.toLowerCase().endsWith('.json')

// ── Durable store (S3) ────────────────────────────────────────────────────────
// Unless METADATA_S3=off, the cache's source of truth is a JSON object on S3 —
// it survives Render's ephemeral disk, and local + hosted GalloIngest share
// ONE catalogue instead of drifting copies. Boot order: S3 key → bundled file
// (which also SEEDS the key on first run). Any S3 failure falls back to the
// bundled file so dev/offline keeps working. JSON (not xlsx) deliberately:
// parsing the full xlsx needs ~500MB RSS, far over the small hosts' budget —
// xlsx generation for humans happens client-side in the Cache Viewer.
import { headAnyKey, downloadAnyKey, uploadAnyKey } from './s3-imports.js'
const META_S3_KEY = (process.env.METADATA_S3 || '').toLowerCase() === 'off'
  ? null
  : (process.env.METADATA_S3_KEY || 'metadata/Gallo_Metadata_Extract.json')

// ── Internal state ─────────────────────────────────────────────────────────────
let _rows      = []          // all parsed rows
let _byIsrc       = new Map()   // ISRC → row
let _byCat        = new Map()   // cat# (lower) → first row for that album
let _byCatAll     = new Map()   // cat# (lower) → all rows for that album (full track list)
let _byBarcodeSeq = new Map()   // `${barcode}_${seq}` → row
let _loaded    = false
let _loadedAt  = null
let _loadedFrom = null       // 's3' | 'file' | 'file+seeded-s3'

// ── Parser ────────────────────────────────────────────────────────────────────

function _parse(buffer) {
  const wb  = XLSX.read(buffer, { type: 'buffer', raw: false })
  // Pick first non-empty sheet
  let sheetName = wb.SheetNames[0]
  for (const name of wb.SheetNames) {
    if (XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }).length > 0) {
      sheetName = name; break
    }
  }
  const ws   = wb.Sheets[sheetName]
  const raw  = XLSX.utils.sheet_to_json(ws, { defval: null })

  const str = v => (v == null || v === '') ? null : String(v).trim()

  // Helper: join multiple columns into one semicolon-separated string.
  // Used for DDEX files that split Composer/Producer across numbered columns.
  const merge = (r, ...keys) => {
    const parts = keys.map(k => str(r[k])).filter(Boolean)
    return parts.length ? parts.join('; ') : null
  }

  return raw.map(r => ({
    album_title:  str(r['Album Title']  ?? r['album title']  ?? r['Album title']),
    album_artist: str(r['Album Artist'] ?? r['album artist'] ?? r['Album artist']),
    release_date:          str(r['Release Date']          ?? r['release date']),
    original_release_date: str(r['Original Release Date'] ?? r['Original Release date'] ?? r['original release date']),
    catalogue:    str(r['Cat. #']       ?? r['Cat #']        ?? r['Catalogue']  ?? r['catalogue']
                  ?? r['Reference Catalogue Number'] ?? r['reference catalogue number']),
    barcode:      str(r['Barcode']      ?? r['barcode']),
    language:     str(r['Language']     ?? r['language']     ?? r['Language Code'] ?? r['language code']),
    isrc:         str(r['ISRC']         ?? r['isrc']),
    // Album-level rights / labels
    label:        str(r['Label']        ?? r['label']),
    p_line:       str(r['Album ℗ line'] ?? r['Album P line'] ?? r['album ℗ line'] ?? r['℗ line'] ?? r['P line']),
    c_line:       str(r['Album © line'] ?? r['Album C line'] ?? r['album © line'] ?? r['© line'] ?? r['C line']),
    // Per-track fields
    track_name:     str(r['Track name']   ?? r['Track Name']   ?? r['track name']  ?? r['Track title'] ?? r['title']),
    track_artist:   str(r['Track artist'] ?? r['Track Artist'] ?? r['track artist']),
    seq:            r['#'] != null && r['#'] !== '' ? (parseInt(r['#'], 10) || null)
                  : (r['Seq'] != null && r['Seq'] !== '' ? (parseInt(r['Seq'], 10) || null) : null),
    duration:       str(r['Duration']     ?? r['duration']),
    genre:          str(r['Track genre']  ?? r['track genre'] ?? r['Genre']        ?? r['genre']),
    audio_language: str(r['Audio language'] ?? r['audio language']),
    // Composers / Producers: accept a single merged column OR up to 3 numbered DDEX columns
    composer:       str(r['Writers / Composers'] ?? r['Writers/Composers'] ?? r['writers / composers'] ?? r['Composers'])
                  || merge(r, 'Composer', 'Composer 2', 'Composer 3'),
    publisher:      str(r['Publishers']   ?? r['Publisher']   ?? r['publishers']),
    producer:       str(r['Producers']    ?? r['Producer']    ?? r['producers'])
                  || merge(r, 'Producer', 'Producer 2', 'Producer 3'),
    parental:           str(r['Parental']           ?? r['parental']           ?? r['Explicit']            ?? r['explicit']),
    rights_territories: str(r['Rights Territories']  ?? r['rights territories'] ?? r['Rights_Territories']),
    featured_artist:    str(r['Featured Artist']     ?? r['featured artist']    ?? r['Featured artist']),
  })).filter(r => r.isrc || r.catalogue || r.album_title)
}

// Exposed for scripts/convert-metadata.js (build-time xlsx → JSON conversion)
export { _parse as parseXlsxBuffer }

// ── Load / reload ─────────────────────────────────────────────────────────────

async function _loadLocalRows() {
  return META_IS_JSON
    ? JSON.parse(await readFile(META_FILE, 'utf8'))
    : _parse(await readFile(META_FILE))
}

function _rebuildIndexes() {
  _byIsrc.clear()
  _byCat.clear()
  _byCatAll.clear()
  _byBarcodeSeq.clear()

  for (const row of _rows) {
    if (row.isrc) {
      _byIsrc.set(row.isrc.trim().toUpperCase(), row)
    }
    if (row.catalogue) {
      const key = row.catalogue.trim().toLowerCase()
      if (!_byCat.has(key)) _byCat.set(key, row)
      if (!_byCatAll.has(key)) _byCatAll.set(key, [])
      _byCatAll.get(key).push(row)
    }
    if (row.barcode && row.seq != null) {
      _byBarcodeSeq.set(`${row.barcode.trim()}_${row.seq}`, row)
    }
  }
}

export async function loadMetadata() {
  try {
    let rows = null
    _loadedFrom = 'file'

    if (META_S3_KEY) {
      try {
        const head = await headAnyKey(META_S3_KEY)
        if (head.exists) {
          rows = JSON.parse((await downloadAnyKey(META_S3_KEY)).buffer.toString('utf8'))
          _loadedFrom = 's3'
        } else {
          rows = await _loadLocalRows()
          await uploadAnyKey(Buffer.from(JSON.stringify(rows)), META_S3_KEY, 'application/json')
          _loadedFrom = 'file+seeded-s3'
          console.log(`[Metadata] Seeded s3://${META_S3_KEY} from ${path.basename(META_FILE)} (${rows.length} rows)`)
        }
      } catch (e) {
        console.warn(`[Metadata] S3 store unavailable (${e.message}) — falling back to ${path.basename(META_FILE)}`)
        rows = null
        _loadedFrom = 'file'
      }
    }
    if (!rows) rows = await _loadLocalRows()

    _rows     = rows
    _rebuildIndexes()
    _loaded   = true
    _loadedAt = new Date()
    console.log(`[Metadata] Loaded ${rows.length} rows from ${_loadedFrom === 'file' ? path.basename(META_FILE) : _loadedFrom} at ${_loadedAt.toISOString()}`)
    return { ok: true, count: rows.length, source: _loadedFrom }
  } catch (err) {
    console.warn(`[Metadata] Failed to load ${META_FILE}:`, err.message)
    return { ok: false, error: err.message }
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Exact lookup by ISRC. Returns the matching row or null.
 */
export function lookupByIsrc(isrc) {
  if (!isrc) return null
  return _byIsrc.get(isrc.trim().toUpperCase()) || null
}

/**
 * Exact lookup by catalogue number. Returns the first matching row or null.
 */
export function lookupByCatalogue(cat) {
  if (!cat) return null
  return _byCat.get(cat.trim().toLowerCase()) || null
}

// Catalogue-number normaliser used by both the cache index and lookups:
// lowercase + strip any whitespace, hyphens, or underscores. Means
// "IAL 3106", "IAL3106", "ial-3106" and "ial_3106" all resolve identically.
function _normCat(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s\-_]+/g, '')
}

/**
 * Returns all track rows for a catalogue number, sorted by seq.
 * Tries exact-after-trim/lowercase first; falls back to a whitespace +
 * hyphen-stripped match so common typo variations still resolve.
 */
export function lookupAlbumTracks(cat) {
  if (!cat) return []
  let rows = _byCatAll.get(cat.trim().toLowerCase()) || []
  if (!rows.length) {
    // Fuzzy fallback: scan the cache for any key whose normalised form matches.
    // Cheap because there are at most a few thousand distinct catalogues.
    const target = _normCat(cat)
    for (const [k, v] of _byCatAll) {
      if (_normCat(k) === target) { rows = v; break }
    }
  }
  return [...rows].sort((a, b) => (a.seq ?? 999) - (b.seq ?? 999))
}

/**
 * Lookup by audio filename of the form {barcode}_{seq}_{seq}.wav
 * e.g. "198704266508_011_011.wav" → barcode=198704266508, seq=11
 * Returns the matching metadata row or null.
 */
export function lookupByFilename(filename) {
  if (!filename) return null
  // Strip path components — FM may store full path or just the basename
  const basename = String(filename).trim().replace(/\\/g, '/').split('/').pop()
  const base  = basename.replace(/\.wav$/i, '')
  const parts = base.split('_')
  if (parts.length < 2) return null
  const seq     = parseInt(parts[parts.length - 1], 10)
  const barcode = parts.slice(0, parts.length - 2).join('_')
  if (!barcode || isNaN(seq)) return null
  return _byBarcodeSeq.get(`${barcode}_${seq}`) || null
}

/**
 * Look up a row by barcode + track sequence number.
 * Equivalent to lookupByFilename but without needing the filename.
 */
export function lookupByBarcodeAndSeq(barcode, seq) {
  if (!barcode || seq == null) return null
  return _byBarcodeSeq.get(`${String(barcode).trim()}_${parseInt(seq, 10)}`) || null
}

/**
 * Return all unique catalogue numbers found in the cache for a given barcode.
 */
export function lookupCataloguesByBarcode(barcode) {
  if (!barcode) return []
  const bc = String(barcode).trim()
  const cats = new Set()
  for (const row of _rows) {
    if (row.barcode && row.barcode.trim() === bc && row.catalogue) {
      cats.add(row.catalogue)
    }
  }
  return [...cats]
}

/**
 * Fuzzy search — matches ISRC prefix, catalogue prefix, or album/artist substring.
 * Returns up to `limit` results.
 */
export function searchMetadata(term, limit = 20) {
  if (!term || term.trim().length < 2) return []
  const t   = term.trim().toLowerCase()
  const tUp = t.toUpperCase()
  const out = []

  for (const row of _rows) {
    if (out.length >= limit) break
    const isrc  = (row.isrc         || '').toUpperCase()
    const cat   = (row.catalogue    || '').toLowerCase()
    const album = (row.album_title  || '').toLowerCase()
    const art   = (row.album_artist || '').toLowerCase()
    const trk   = (row.track_name   || '').toLowerCase()
    const tArt  = (row.track_artist || '').toLowerCase()
    if (
      isrc.startsWith(tUp)   ||
      isrc.includes(tUp)     ||
      cat.includes(t)        ||
      album.includes(t)      ||
      art.includes(t)        ||
      trk.includes(t)        ||
      tArt.includes(t)
    ) {
      out.push(row)
    }
  }
  return out
}

export function getStatus() {
  return { loaded: _loaded, count: _rows.length, loadedAt: _loadedAt, source: _loadedFrom, s3Key: META_S3_KEY }
}

/** Every cached row (the admin cache viewer reads these). */
export function getAllRows() {
  return _rows
}

// ── Shared write helpers ──────────────────────────────────────────────────────

// Internal field key → canonical xlsx column header
const _FIELD_TO_COL = {
  album_title:           'Album Title',
  album_artist:          'Album Artist',
  release_date:          'Release Date',
  original_release_date: 'Original Release Date',
  catalogue:      'Cat. #',
  barcode:        'Barcode',
  language:       'Language',
  isrc:           'ISRC',
  label:          'Label',
  p_line:         'Album ℗ line',
  c_line:         'Album © line',
  track_name:     'Track name',
  track_artist:   'Track artist',
  seq:            '#',
  duration:       'Duration',
  genre:          'Track genre',
  audio_language: 'Audio language',
  composer:           'Writers / Composers',
  publisher:          'Publishers',
  producer:           'Producers',
  parental:           'Parental',
  rights_territories: 'Rights Territories',
  featured_artist:    'Featured Artist',
}

const CACHE_FIELD_KEYS = Object.keys(_FIELD_TO_COL)
const XLSX_HEADERS     = Object.values(_FIELD_TO_COL)

/** Internal-key → canonical xlsx column header map (Cache Viewer download). */
export const CACHE_COLUMNS = _FIELD_TO_COL

function _toXlsxRow(r) {
  const out = {}
  for (const [k, col] of Object.entries(_FIELD_TO_COL)) out[col] = r[k] ?? null
  return out
}

// Writes are serialised: every mutation rewrites the WHOLE store (S3 object or
// local file), so two interleaved edits would clobber each other without this.
let _writeBusy = false
const _writeQueue = []
function _enqueueWrite(fn) {
  return new Promise((resolve, reject) => {
    _writeQueue.push({ fn, resolve, reject })
    _drainWriteQueue()
  })
}
async function _drainWriteQueue() {
  if (_writeBusy || !_writeQueue.length) return
  _writeBusy = true
  const { fn, resolve, reject } = _writeQueue.shift()
  try   { resolve(await fn()) }
  catch (e) { reject(e) }
  finally   { _writeBusy = false; _drainWriteQueue() }
}

// Persist the in-memory rows to the durable store. S3 when configured (the
// bundled file then stays a boot-seed only); otherwise the local file — JSON
// directly, or xlsx re-serialised via _toXlsxRow() so rows stay normalised to
// the canonical XLSX_HEADERS (raw sheet_to_json output once caused a
// 34-column drift).
async function _persistAll() {
  if (META_S3_KEY) {
    try {
      await uploadAnyKey(Buffer.from(JSON.stringify(_rows)), META_S3_KEY, 'application/json')
      return 's3'
    } catch (e) {
      console.warn(`[Metadata] S3 persist failed (${e.message}) — writing local file instead`)
    }
  }
  if (META_IS_JSON) {
    await writeFile(META_FILE, JSON.stringify(_rows))
  } else {
    const newWb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      newWb,
      XLSX.utils.json_to_sheet(_rows.map(_toXlsxRow), { header: XLSX_HEADERS }),
      'Metadata'
    )
    await writeFile(META_FILE, XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }))
  }
  return 'file'
}

async function _writeRowsToFile(rows) {
  return _enqueueWrite(async () => {
    if (!_loaded) await loadMetadata()
    _rows = [..._rows, ...rows]
    await _persistAll()
    _rebuildIndexes()
    _loadedAt = new Date()
    return { ok: true, count: _rows.length }
  })
}

function _expectMatches(row, expect = {}) {
  return Object.entries(expect || {}).every(([k, v]) => String(row?.[k] ?? '') === String(v ?? ''))
}

/**
 * Edit one row in place (internal field keys). `expect` carries a few fields
 * as the grid saw them — a mismatch means the store changed underneath the
 * editor, and we refuse rather than silently overwrite.
 */
export async function updateRow(index, patch, expect = {}) {
  return _enqueueWrite(async () => {
    const row = _rows[index]
    if (!row) throw new Error(`No cache row at index ${index}`)
    if (!_expectMatches(row, expect)) {
      throw new Error('Row changed since the viewer loaded — reload the cache viewer and retry')
    }
    for (const [k, v] of Object.entries(patch || {})) {
      if (!CACHE_FIELD_KEYS.includes(k)) continue
      if (k === 'seq') row[k] = (v === '' || v == null) ? null : (parseInt(v, 10) || null)
      else             row[k] = (v === '' || v == null) ? null : String(v)
    }
    await _persistAll()
    _rebuildIndexes()
    _loadedAt = new Date()
    return { ok: true, row }
  })
}

/**
 * Replace the ENTIRE cache with the rows parsed from an uploaded spreadsheet
 * buffer (bulk-corrections workflow: Download xlsx → edit in Excel → Replace).
 * Before applying, the current store is copied to a timestamped backup key on
 * S3 — belt and braces on top of bucket versioning. Returns { before, count }.
 */
export async function replaceFromBuffer(buffer) {
  const incoming = _parse(buffer)
  if (!incoming.length) throw new Error('No valid rows found in the uploaded file — cache left untouched')
  return _enqueueWrite(async () => {
    if (!_loaded) await loadMetadata()
    if (META_S3_KEY) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await uploadAnyKey(
          Buffer.from(JSON.stringify(_rows)),
          `metadata/backups/Gallo_Metadata_Extract-${stamp}.json`,
          'application/json'
        )
      } catch (e) {
        console.warn('[Metadata] Pre-replace backup failed (continuing — bucket versioning still applies):', e.message)
      }
    }
    const before = _rows.length
    _rows = incoming
    await _persistAll()
    _rebuildIndexes()
    _loadedAt = new Date()
    console.log(`[Metadata] Cache REPLACED: ${before} → ${_rows.length} rows`)
    return { ok: true, before, count: _rows.length }
  })
}

/** Delete one row. Same expect-guard as updateRow. */
export async function deleteRow(index, expect = {}) {
  return _enqueueWrite(async () => {
    const row = _rows[index]
    if (!row) throw new Error(`No cache row at index ${index}`)
    if (!_expectMatches(row, expect)) {
      throw new Error('Row changed since the viewer loaded — reload the cache viewer and retry')
    }
    _rows.splice(index, 1)
    await _persistAll()
    _rebuildIndexes()
    _loadedAt = new Date()
    return { ok: true, count: _rows.length }
  })
}

// ── Public write API ──────────────────────────────────────────────────────────

/** Append one row (internal field names) and reload. */
export async function appendRow(data) {
  const result = await _writeRowsToFile([data])
  return result
}

/**
 * Parse a buffer using the auto-detect column mapper and append all valid rows.
 * Returns { ok, added, total }.
 */
export async function mergeFromBuffer(buffer) {
  const incoming = _parse(buffer)
  if (!incoming.length) return { ok: false, error: 'No valid rows found in file', added: 0 }
  const result = await _writeRowsToFile(incoming)
  return { ok: true, added: incoming.length, total: result.count }
}

/**
 * Return the column headers from the first non-empty sheet of a buffer,
 * plus a suggested auto-mapping to cache field keys.
 * Used by the admin mapping UI before the user commits an import.
 */
export function extractHeaders(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  let sheetName = wb.SheetNames[0]
  for (const name of wb.SheetNames) {
    if (XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }).length > 0) {
      sheetName = name; break
    }
  }
  const raw  = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
  const headers = raw.length > 0
    ? Object.keys(raw[0]).filter(h => h && !String(h).startsWith('__'))
    : []
  return { headers, sheetName, rowCount: raw.length }
}

/**
 * Apply an explicit column mapping and append all valid rows.
 * mapping: [{ source: 'Album Title', target: 'album_title' }, ...]
 * Multiple source columns mapped to the same target are joined with '; '.
 * Returns { ok, added, total }.
 */
export async function mergeWithMapping(buffer, mapping) {
  // Use raw:false so SheetJS returns the cell's formatted text when available.
  // For cells whose format SheetJS doesn't recognise (date serials, time
  // fractions) it falls back to the raw number — we convert those ourselves,
  // avoiding Date objects entirely so timezone offsets can't corrupt times.
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  let sheetName = wb.SheetNames[0]
  for (const name of wb.SheetNames) {
    if (XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }).length > 0) {
      sheetName = name; break
    }
  }
  const raw   = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
  const valid = new Set(CACHE_FIELD_KEYS)

  // Fields that store a time value (HH:MM:SS) rather than a calendar date.
  const TIME_FIELDS = new Set(['duration'])

  // Convert an Excel time fraction (e.g. 0.00143) → "HH:MM:SS".
  // Pure arithmetic — no Date objects, no timezone risk.
  const fracToTime = v => {
    const totalSec = Math.round(v * 86400)
    return String(Math.floor(totalSec / 3600)).padStart(2, '0') + ':' +
           String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0') + ':' +
           String(totalSec % 60).padStart(2, '0')
  }

  // Convert an Excel date serial (e.g. 46169) → "YYYY-MM-DD".
  // Anchored to the Excel epoch (1899-12-30 UTC), so local timezone is irrelevant.
  const serialToDate = v => {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000)
    return d.getUTCFullYear() + '-' +
           String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
           String(d.getUTCDate()).padStart(2, '0')
  }

  const fmtVal = (v, target) => {
    if (v == null || v === '') return null
    if (typeof v === 'number') {
      if (TIME_FIELDS.has(target) && v >= 0 && v < 1) return fracToTime(v)
      if (v > 40000 && v < 70000)                     return serialToDate(v)
    }
    // Defensive: handle JS Date objects in case cellDates leaks in elsewhere
    if (v instanceof Date && !isNaN(v)) {
      if (TIME_FIELDS.has(target)) return fracToTime(
        (v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds()) / 86400
      )
      return v.getFullYear() + '-' +
             String(v.getMonth() + 1).padStart(2, '0') + '-' +
             String(v.getDate()).padStart(2, '0')
    }
    return String(v).trim() || null
  }

  const rows = raw.map(r => {
    const out = {}
    for (const { source, target } of mapping) {
      if (!target || target === '_ignore' || !valid.has(target)) continue
      const val = fmtVal(r[source], target)
      if (!val) continue
      if (target === 'seq') {
        out.seq = out.seq ?? (parseInt(val, 10) || null)
      } else {
        out[target] = out[target] ? out[target] + '; ' + val : val
      }
    }
    // Track artist fallback: if the CCA "Track Artist" column was blank or
    // identical to album artist, use album artist — always populated, never doubled.
    if (!out.track_artist) {
      out.track_artist = out.album_artist || null
    } else if (out.album_artist &&
               out.track_artist.trim().toLowerCase() === out.album_artist.trim().toLowerCase()) {
      out.track_artist = out.album_artist   // same value — keep one copy, discard the join
    }
    return out
  }).filter(r => r.isrc || r.catalogue || r.album_title)

  if (!rows.length) return { ok: false, error: 'No valid rows after applying mapping — check ISRC or Cat. # columns', added: 0 }
  const result = await _writeRowsToFile(rows)
  return { ok: true, added: rows.length, total: result.count }
}
