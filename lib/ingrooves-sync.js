/**
 * lib/ingrooves-sync.js — sync client edits made in the Ingrooves/Virgin
 * portal back into the metadata cache.
 *
 * There is no Ingrooves API: the bridge is the portal's catalogue export
 * (xlsx, one row per TRACK with the product/album columns repeated, capped
 * at 10,000 rows per export). This module:
 *
 *   parseIngroovesBuffers(buffers)  — parse one or more export files into
 *       cache-shaped rows (multi-file input is how a >10k catalogue arrives;
 *       duplicate ISRCs across chunks collapse, last file wins).
 *   diffAgainstCache(rows)          — match each export row to a cache row
 *       (ISRC first, then UPC + track number) and report only the cells
 *       that actually differ, as { key: { from, to } } patches — the same
 *       shape the Cache Viewer's push queue eats.
 *
 * Apply is just metadata-cache.updateRow per changed row (album-level keys
 * fan out album-wide there), after which the admin UI queues the changes on
 * the existing push-to-databases button.
 */

import * as XLSX from 'xlsx'
import { getAllRows } from './metadata-cache.js'

// Ingrooves export column → cache field. Product-level columns repeat on
// every track row; that's fine — each row carries its own copy of the diff
// and updateRow's albumWide option keeps whole albums consistent anyway.
// 'Catalog #' maps too, but beware: Ingrooves splits vinyl into A/B-side
// products, so a suffix-only difference may be structural, not an edit —
// the preview shows it and the user decides.
const COLUMN_MAP = {
  'Product Title':          'album_title',
  'Product Display Artist': 'album_artist',
  'Label':                  'label',
  'Original Release Date':  'original_release_date',
  'Release Date':           'release_date',
  'UPC':                    'barcode',
  'Catalog #':              'catalogue',
  'Product P Line':         'p_line',
  'Product C Line':         'c_line',
  'Primary Metadata Language': 'language',
  'Track Number':           'seq',
  'Track Name':             'track_name',
  'Track Display Artist':   'track_artist',
  'Isrc':                   'isrc',
  'Track Genre':            'genre',
  'Audio Language':         'audio_language',
  'Writers':                'composer',
  'Publishers/Collection Societies': 'publisher',
  'Producers':              'producer',
  'Duration':               'duration',
  'Explicit Lyrics':        'parental',
}

// Headers that must be present for a sheet to be recognised as an Ingrooves
// export — guards against feeding some other spreadsheet into this importer.
const REQUIRED_HEADERS = ['Product Title', 'Track Name', 'Isrc', 'UPC', 'Track Number']

// Fields where a differing value should be reported (everything mapped).
const DIFF_KEYS = [...new Set(Object.values(COLUMN_MAP))]

// ── Value normalisers ─────────────────────────────────────────────────────────

// Excel serial → ISO date. The catalogue reaches back to the 1950s, so accept
// any plausible serial (1930-01-01 ≈ 10959 … 2100 ≈ 73050); the export sends
// dates as raw serials (e.g. 26385 = 1972-03-28).
function serialToIso(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 700 || n > 80000) return null
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
  return d.getUTCFullYear() + '-' +
         String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(d.getUTCDate()).padStart(2, '0')
}

// Any date-ish input (serial, ISO, M/D/YYYY) → ISO string, or the trimmed
// original when unrecognised (a wrong date is worse than an unconverted one).
function toIsoDate(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  if (/^\d+(\.\d+)?$/.test(s)) return serialToIso(s) || s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  return s
}

// "Robert John Lange <Composer>, Tata Sibeko <Lyricist>, Tata Sibeko <Composer>"
// → "Robert John Lange; Tata Sibeko" (names deduped, role tags dropped).
// Also handles the Publishers variant: "April Music <SAMRO>" → "April Music".
function stripRoleTags(v) {
  if (v == null || v === '') return null
  const seen = new Set()
  const names = []
  for (const part of String(v).split(/[,;]/)) {
    const name = part.replace(/<[^>]*>/g, '').trim()
    if (!name) continue
    const k = name.toLowerCase()
    if (!seen.has(k)) { seen.add(k); names.push(name) }
  }
  return names.length ? names.join('; ') : null
}

// Durations to H:MM:SS-comparable seconds; null when unparseable.
function durationSec(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s)
    return n < 1 ? Math.round(n * 86400) : Math.round(n)   // Excel fraction vs seconds
  }
  const parts = s.split(':').map(p => parseFloat(p))
  if (!parts.length || !parts.every(n => !isNaN(n))) return null
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  return null
}

const str = v => {
  if (v == null) return null
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s === '' ? null : s
}

// ── Parse ─────────────────────────────────────────────────────────────────────

/**
 * Parse one or more Ingrooves export buffers into cache-shaped rows.
 * Returns { rows, files, skippedDuplicates }. Rows deduplicate by ISRC
 * (falling back to UPC+track#) across files — later files win, so chunked
 * exports can overlap harmlessly.
 */
export function parseIngroovesBuffers(buffers) {
  const byKey = new Map()
  const files = []
  let skippedDuplicates = 0
  let skippedDeleted = 0

  for (const { buffer, name } of buffers) {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
    let sheetName = wb.SheetNames[0]
    for (const n of wb.SheetNames) {
      if (XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null }).length > 0) { sheetName = n; break }
    }
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    if (!raw.length) throw new Error(`${name}: no data rows found`)
    const headers = Object.keys(raw[0])
    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h))
    if (missing.length) {
      throw new Error(`${name}: not an Ingrooves export — missing column(s): ${missing.join(', ')}`)
    }

    let fileRows = 0
    for (const r of raw) {
      // The portal export includes every GENERATION of a product — dead
      // "Deleted" versions alongside the live "Released" one (EMM 215 has
      // three). A deleted product's metadata must never drive updates.
      const status = str(r['Submission Status'])
      if (status && status.toLowerCase() === 'deleted') { skippedDeleted++; continue }
      const row = {
        album_title:           str(r['Product Title']),
        album_artist:          str(r['Product Display Artist']),
        label:                 str(r['Label']),
        original_release_date: toIsoDate(r['Original Release Date']),
        release_date:          toIsoDate(r['Release Date']),
        barcode:               str(r['UPC']),
        catalogue:             str(r['Catalog #']),
        p_line:                str(r['Product P Line']),
        c_line:                str(r['Product C Line']),
        language:              str(r['Primary Metadata Language']),
        seq:                   (() => { const n = parseInt(r['Track Number'], 10); return isNaN(n) ? null : n })(),
        track_name:            str(r['Track Name']),
        track_artist:          str(r['Track Display Artist']),
        isrc:                  str(r['Isrc']),
        genre:                 str(r['Track Genre'] ?? r['Product Genre']),
        audio_language:        str(r['Audio Language']),
        composer:              stripRoleTags(r['Writers']),
        publisher:             stripRoleTags(r['Publishers/Collection Societies']),
        producer:              stripRoleTags(r['Producers']),
        duration:              str(r['Duration']),
        parental:              str(r['Explicit Lyrics'] ?? r['ExplicitLyrics']),
        _last_modified:        toIsoDate(r['Last Modified']),
        _product_id:           str(r['Product Id']),
        _file:                 name,
      }
      if (!row.isrc && !(row.barcode && row.seq != null)) continue   // nothing to match on
      const key = row.isrc ? `i:${row.isrc.toUpperCase()}` : `b:${row.barcode}_${row.seq}`
      const prev = byKey.get(key)
      if (prev) {
        skippedDuplicates++
        // Same track in several live products (or overlapping export chunks):
        // the most recently modified row wins, not file order.
        if (String(prev._last_modified || '') > String(row._last_modified || '')) { fileRows++; continue }
      }
      byKey.set(key, row)
      fileRows++
    }
    files.push({ name, rows: fileRows })
  }

  return { rows: [...byKey.values()], files, skippedDuplicates, skippedDeleted }
}

// ── Diff ──────────────────────────────────────────────────────────────────────

// Per-field comparison semantics. Returns true when the two values are
// EQUIVALENT (no diff to report).
function sameValue(key, cacheVal, exportVal) {
  const a = cacheVal == null ? '' : String(cacheVal).replace(/\s+/g, ' ').trim()
  const b = exportVal == null ? '' : String(exportVal).replace(/\s+/g, ' ').trim()
  if (a === b) return true
  if (!a || !b) return false   // one side empty, the other not → real diff

  switch (key) {
    case 'release_date':
    case 'original_release_date':
      return toIsoDate(a) === toIsoDate(b)
    case 'duration': {
      const sa = durationSec(a), sb = durationSec(b)
      return sa != null && sb != null && sa === sb
    }
    case 'seq':
      return parseInt(a, 10) === parseInt(b, 10)
    case 'isrc':
    case 'barcode':
      return a.toUpperCase() === b.toUpperCase()
    case 'parental':
    case 'language':
    case 'audio_language':
    case 'genre':
      return a.toLowerCase() === b.toLowerCase()
    case 'composer':
    case 'publisher':
    case 'producer': {
      // Compare as name SETS with role/society tags stripped from BOTH sides —
      // the cache holds Ingrooves-style "Name <Lyricist>, Name <Composer>"
      // strings, and a formatting difference is not a client edit.
      const setOf = v => new Set((stripRoleTags(v) || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean))
      const sa = setOf(a), sb = setOf(b)
      return sa.size === sb.size && [...sa].every(x => sb.has(x))
    }
    default:
      return false   // titles/artists/lines: exact (case-sensitive) — case fixes are real edits
  }
}

/**
 * Diff parsed export rows against the loaded metadata cache.
 * Returns:
 *   edits:     [{ index, isrc, catalogue, seq, title, artist, lastModified,
 *                 matchedBy, changes: { key: { from, to } } }]
 *   unchanged: number of matched rows with no differing cells
 *   unmatched: [{ isrc, barcode, seq, title, artist, catalogue }]
 */
export function diffAgainstCache(exportRows) {
  const cache = getAllRows()
  const byIsrc = new Map()          // ISRC → ALL cache indexes holding it
  const byBarcodeSeq = new Map()
  cache.forEach((r, i) => {
    if (r.isrc) {
      const k = r.isrc.trim().toUpperCase()
      if (!byIsrc.has(k)) byIsrc.set(k, [])
      byIsrc.get(k).push(i)
    }
    if (r.barcode && r.seq != null) {
      const k = `${r.barcode.trim()}_${r.seq}`
      if (!byBarcodeSeq.has(k)) byBarcodeSeq.set(k, i)
    }
  })

  const normCat = s => String(s || '').trim().toLowerCase().replace(/[\s\-_]+/g, '')

  const edits = []
  const unmatched = []
  let unchanged = 0

  for (const er of exportRows) {
    let index = null, matchedBy = null
    const isrcHits = er.isrc ? (byIsrc.get(er.isrc.toUpperCase()) || []) : []
    if (isrcHits.length) {
      // The same ISRC often lives in SEVERAL products (vault A/B-side single
      // AND a compilation). Prefer the cache row from the same product —
      // barcode agreement first, then catalogue — before falling back to the
      // first holder of the ISRC.
      index = isrcHits.find(i => er.barcode && cache[i].barcode && cache[i].barcode.trim() === er.barcode)
        ?? isrcHits.find(i => er.catalogue && normCat(cache[i].catalogue) === normCat(er.catalogue))
        ?? isrcHits[0]
      matchedBy = 'isrc'
    } else if (er.barcode && er.seq != null && byBarcodeSeq.has(`${er.barcode}_${er.seq}`)) {
      index = byBarcodeSeq.get(`${er.barcode}_${er.seq}`); matchedBy = 'barcode+seq'
    }
    if (index == null) {
      unmatched.push({ isrc: er.isrc, barcode: er.barcode, seq: er.seq,
                       title: er.track_name, artist: er.track_artist, catalogue: er.catalogue })
      continue
    }

    const cacheRow = cache[index]
    const changes = {}
    for (const key of DIFF_KEYS) {
      const exportVal = er[key]
      if (exportVal == null || exportVal === '') continue   // never blank a cache value from an empty export cell
      if (sameValue(key, cacheRow[key], exportVal)) continue
      changes[key] = { from: cacheRow[key] ?? null, to: key === 'seq' ? String(exportVal) : exportVal }
    }

    if (!Object.keys(changes).length) { unchanged++; continue }
    // Both identity anchors differing means the ISRC matched a DIFFERENT
    // product (compilation vs single re-issue) — applying would re-home the
    // cache row, not correct it. Flagged so the UI can default these off.
    const rehome = !!(changes.catalogue && changes.barcode)
    edits.push({
      index,
      rehome,
      // Pre-apply snapshot for updateRow's expect-guard — protects against
      // cache index drift between preview and apply. Deliberately NO
      // catalogue here: an album-wide catalogue change from a sibling edit
      // in the same batch would otherwise trip the guard on rows 2..N.
      expect:       { isrc: cacheRow.isrc ?? null, track_name: cacheRow.track_name ?? null },
      isrc:         cacheRow.isrc || er.isrc || null,
      catalogue:    cacheRow.catalogue || er.catalogue || null,
      seq:          cacheRow.seq ?? er.seq ?? null,
      title:        cacheRow.track_name || er.track_name || null,
      artist:       cacheRow.track_artist || cacheRow.album_artist || er.track_artist || null,
      lastModified: er._last_modified || null,
      matchedBy,
      changes,
    })
  }

  // Most recently modified first — the rows the client just touched float up.
  edits.sort((a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || '')))
  return { edits, unchanged, unmatched }
}
