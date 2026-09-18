/**
 * lib/sheet-update.js — update the metadata cache from ANY spreadsheet.
 *
 * The client keeps his own database and corrects fields there. He can export
 * a sheet, but its columns are his, not ours, and it usually carries only the
 * handful of fields he has been working on. So, unlike the Ingrooves importer
 * (lib/ingrooves-sync.js, one fixed export format) this one:
 *
 *   readSheet(buffer)      — headers, a sample, and a suggested mapping of his
 *                            column names to cache fields plus a suggested
 *                            matching key, all of which the operator corrects.
 *   diffSheet(buffer, …)   — match each sheet row to a cache row on the chosen
 *                            key and report ONLY the cells that differ, in the
 *                            same { key: { from, to } } shape the Cache Viewer's
 *                            push queue and the Ingrooves preview already use.
 *
 * Rules (Ian, 2026-09-18):
 *   - A BLANK cell means "not supplied" and never clears a cache value. An
 *     import is a correction of some fields, not a replacement of the record.
 *   - Rows matching nothing are listed as unmatched, changing nothing; adding
 *     them to the cache is a separate, deliberate click.
 *
 * Applying is metadata-cache.updateRow per row (album-level fields fan out
 * album-wide there) — the same path the Ingrooves sync uses.
 */
import * as XLSX from 'xlsx'
import { getAllRows, CACHE_COLUMNS } from './metadata-cache.js'

/** Cache fields an import may write. Everything in the cache except nothing. */
export const UPDATABLE_FIELDS = Object.entries(CACHE_COLUMNS).map(([key, label]) => ({ key, label }))

/**
 * How rows are matched. ISRC is the only truly global identifier; the others
 * are for sheets that don't carry one.
 */
export const MATCH_KEYS = [
  { key: 'isrc',          label: 'ISRC',                          needs: ['isrc'] },
  { key: 'catalogue_seq', label: 'Catalogue number + track #',    needs: ['catalogue', 'seq'] },
  { key: 'barcode_seq',   label: 'Barcode (UPC) + track #',       needs: ['barcode', 'seq'] },
  { key: 'catalogue_title', label: 'Catalogue number + track title', needs: ['catalogue', 'track_name'] },
  { key: 'catalogue',     label: 'Catalogue number (album-wide)', needs: ['catalogue'] },
]

const norm = s => String(s ?? '').trim()
const lower = s => norm(s).toLowerCase()
const normCat = s => lower(s).replace(/[\s\-_]+/g, '')
const normTitle = s => lower(s).replace(/[^a-z0-9]+/g, ' ').trim()
const normIsrc = s => norm(s).toUpperCase().replace(/[\s-]/g, '')
const seqOf = v => {
  const n = parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : null
}

// Header spellings seen in the wild, on top of our own column names.
const HEADER_ALIASES = {
  isrc: ['isrc', 'isrc code', 'track isrc'],
  catalogue: ['catalogue', 'catalog', 'cat', 'cat #', 'cat no', 'catalogue number', 'catalog #', 'catalogue no', 'product code', 'selection number'],
  barcode: ['barcode', 'upc', 'ean', 'upc/ean', 'product barcode'],
  seq: ['seq', 'track #', 'track number', 'track no', 'tracknum', '#', 'sequence'],
  track_name: ['track name', 'track title', 'title', 'song', 'song title', 'recording title'],
  track_artist: ['track artist', 'artist', 'display artist', 'performer', 'track display artist'],
  album_title: ['album title', 'album', 'product title', 'release title'],
  album_artist: ['album artist', 'product display artist', 'release artist'],
  composer: ['composer', 'composers', 'writer', 'writers', 'songwriter', 'songwriters', 'writers / composers'],
  publisher: ['publisher', 'publishers', 'publishing', 'publishers/collection societies'],
  producer: ['producer', 'producers'],
  genre: ['genre', 'track genre', 'main genre'],
  language: ['language', 'metadata language', 'primary metadata language'],
  audio_language: ['audio language', 'lyrics language'],
  label: ['label', 'record label', 'imprint'],
  release_date: ['release date', 'released', 'digital release date'],
  original_release_date: ['original release date', 'orig release date', 'first release date'],
  p_line: ['p line', '℗ line', 'p-line', 'product p line', 'phonographic copyright'],
  c_line: ['c line', '© line', 'c-line', 'product c line', 'copyright'],
  duration: ['duration', 'length', 'running time'],
  parental: ['parental', 'explicit', 'explicit lyrics', 'parental advisory'],
  featured_artist: ['featured artist', 'featuring', 'feat'],
  rights_territories: ['rights territories', 'territories', 'territory'],
}

const headerKey = h => lower(h).replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').replace(/[.:#]+$/, '').trim()

/** Guess which cache field a column header means. Null when nothing fits. */
export function guessField(header) {
  const h = headerKey(header)
  if (!h) return null
  for (const [key, label] of Object.entries(CACHE_COLUMNS)) {
    if (h === headerKey(label) || h === headerKey(key)) return key
  }
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some(a => headerKey(a) === h)) return key
  }
  return null
}

function firstSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  let name = wb.SheetNames[0]
  for (const n of wb.SheetNames) {
    if (XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null }).length > 0) { name = n; break }
  }
  return { name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }) }
}

/**
 * What's in the file: its columns, what each one looks like it means, a few
 * example values, and the best matching key its columns can support.
 */
export function readSheet(buffer) {
  const { name, rows } = firstSheet(buffer)
  const headers = rows.length ? Object.keys(rows[0]).filter(h => h && !String(h).startsWith('__')) : []
  const columns = headers.map(h => ({
    header: h,
    field: guessField(h),
    samples: rows.slice(0, 200).map(r => r[h]).filter(v => v != null && v !== '').slice(0, 3).map(v => String(v).slice(0, 60)),
  }))
  const mapped = new Set(columns.map(c => c.field).filter(Boolean))
  const suggestedKey = (MATCH_KEYS.find(k => k.needs.every(n => mapped.has(n))) || {}).key || null
  return { sheetName: name, rowCount: rows.length, columns, suggestedKey }
}

// Excel hands dates and times back as numbers when it has no format for them.
const serialToDate = n => {
  const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const fracToTime = n => {
  const s = Math.round(n * 86400)
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(x => String(x).padStart(2, '0')).join(':')
}
const DATE_FIELDS = new Set(['release_date', 'original_release_date'])

function cellValue(raw, field) {
  if (raw == null) return null
  if (typeof raw === 'number') {
    if (DATE_FIELDS.has(field) && raw > 700 && raw < 80000) return serialToDate(raw)
    if (field === 'duration' && raw > 0 && raw < 1) return fracToTime(raw)
    return String(raw)
  }
  const s = norm(raw)
  return s === '' ? null : s
}

// Values that mean the same thing written differently shouldn't read as edits.
function sameValue(field, a, b) {
  if (a == null && b == null) return true
  const x = norm(a), y = norm(b)
  if (x === y) return true
  if (lower(x) === lower(y)) return true
  if (field === 'seq') return seqOf(x) === seqOf(y) && seqOf(x) != null
  if (field === 'isrc') return normIsrc(x) === normIsrc(y)
  if (field === 'catalogue') return normCat(x) === normCat(y)
  if (DATE_FIELDS.has(field)) return x.slice(0, 10) === y.slice(0, 10)
  if (field === 'duration') return x.replace(/^00:/, '') === y.replace(/^00:/, '')
  return false
}

function cacheIndex(cache, matchKey) {
  const index = new Map()
  const add = (k, i) => {
    if (!k) return
    if (!index.has(k)) index.set(k, [])
    index.get(k).push(i)
  }
  cache.forEach((r, i) => {
    switch (matchKey) {
      case 'isrc':            add(normIsrc(r.isrc), i); break
      case 'catalogue_seq':   if (r.seq != null) add(`${normCat(r.catalogue)}|${seqOf(r.seq)}`, i); break
      case 'barcode_seq':     if (r.seq != null) add(`${norm(r.barcode)}|${seqOf(r.seq)}`, i); break
      case 'catalogue_title': add(`${normCat(r.catalogue)}|${normTitle(r.track_name)}`, i); break
      case 'catalogue':       add(normCat(r.catalogue), i); break
    }
  })
  return index
}

function rowKey(vals, matchKey) {
  switch (matchKey) {
    case 'isrc':            return normIsrc(vals.isrc)
    case 'catalogue_seq':   return vals.seq == null ? '' : `${normCat(vals.catalogue)}|${seqOf(vals.seq)}`
    case 'barcode_seq':     return vals.seq == null ? '' : `${norm(vals.barcode)}|${seqOf(vals.seq)}`
    case 'catalogue_title': return `${normCat(vals.catalogue)}|${normTitle(vals.track_name)}`
    case 'catalogue':       return normCat(vals.catalogue)
    default:                return ''
  }
}

/**
 * Compare a client sheet against the cache.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {Record<string,string>} opts.mapping  sheet header → cache field key
 * @param {string} opts.matchKey                one of MATCH_KEYS
 * @param {string[]} [opts.updateFields]        fields allowed to change; default
 *                                              every mapped field that isn't
 *                                              part of the matching key
 * @returns {{ edits, unchanged, unmatched, ambiguous, rowsRead, updateFields }}
 */
export function diffSheet(buffer, { mapping = {}, matchKey = 'isrc', updateFields = null } = {}) {
  const spec = MATCH_KEYS.find(k => k.key === matchKey)
  if (!spec) throw Object.assign(new Error(`Unknown match key "${matchKey}"`), { status: 400 })

  const byField = {}                       // cache field → sheet header
  for (const [header, field] of Object.entries(mapping)) if (field) byField[field] = header
  const missing = spec.needs.filter(n => !byField[n])
  if (missing.length) {
    throw Object.assign(new Error(`Matching on ${spec.label} needs a column mapped to: ${missing.join(', ')}`), { status: 400 })
  }

  // Never rewrite the very fields a row was found by: that would re-home the
  // record rather than correct it.
  const fields = (updateFields && updateFields.length ? updateFields : Object.keys(byField))
    .filter(f => byField[f] && !spec.needs.includes(f))
  if (!fields.length) {
    throw Object.assign(new Error('Nothing to update: every mapped column is part of the matching key'), { status: 400 })
  }

  const { rows } = firstSheet(buffer)
  const cache = getAllRows()
  const index = cacheIndex(cache, matchKey)

  const edits = []
  const unmatched = []
  const ambiguous = []
  let unchanged = 0

  rows.forEach((raw, i) => {
    const vals = {}
    for (const [field, header] of Object.entries(byField)) vals[field] = cellValue(raw[header], field)
    const key = rowKey(vals, matchKey)
    if (!key || key.endsWith('|') || key.startsWith('|')) return    // an empty row in the sheet

    const hits = index.get(key) || []
    if (!hits.length) {
      unmatched.push({ sheetRow: i + 2, key, ...vals })             // +2: header row, 1-based
      return
    }
    // "Catalogue number (album-wide)" is meant to hit every track of an album;
    // the others matching more than one row means the key isn't unique, which
    // the operator needs to see rather than have guessed at.
    if (hits.length > 1 && matchKey !== 'catalogue') {
      ambiguous.push({ sheetRow: i + 2, key, matches: hits.length, ...vals })
      return
    }

    for (const idx of hits) {
      const cacheRow = cache[idx]
      const changes = {}
      for (const field of fields) {
        const to = vals[field]
        if (to == null || to === '') continue                        // blank = not supplied
        if (sameValue(field, cacheRow[field], to)) continue
        changes[field] = { from: cacheRow[field] ?? null, to }
      }
      if (!Object.keys(changes).length) { unchanged++; continue }
      edits.push({
        index: idx,
        sheetRow: i + 2,
        matchedBy: spec.label,
        // Snapshot for updateRow's expect-guard: protects against the cache
        // shifting between preview and apply.
        expect: { isrc: cacheRow.isrc ?? null, track_name: cacheRow.track_name ?? null },
        isrc: cacheRow.isrc || null,
        catalogue: cacheRow.catalogue || null,
        seq: cacheRow.seq ?? null,
        title: cacheRow.track_name || null,
        artist: cacheRow.track_artist || cacheRow.album_artist || null,
        changes,
      })
    }
  })

  return { edits, unchanged, unmatched, ambiguous, rowsRead: rows.length, updateFields: fields, matchKey }
}

/** Sheet rows the match found nothing for, shaped as cache rows to append. */
export function rowsToAppend(buffer, { mapping = {}, sheetRows = [] } = {}) {
  const wanted = new Set(sheetRows)
  const { rows } = firstSheet(buffer)
  const out = []
  rows.forEach((raw, i) => {
    if (!wanted.has(i + 2)) return
    const row = {}
    for (const [header, field] of Object.entries(mapping)) {
      if (!field) continue
      const v = cellValue(raw[header], field)
      if (v != null) row[field] = field === 'seq' ? seqOf(v) : v
    }
    if (Object.keys(row).length) out.push(row)
  })
  return out
}
