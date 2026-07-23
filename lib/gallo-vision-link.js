/**
 * lib/gallo-vision-link.js — match a catalogue's tracks to their audio files on
 * Vision, so the Vision path can be written to each Gallo record's audio_Url.
 *
 * Locating: the whole Vision store is flat-listed once into an index (see
 * buildVisionIndex) and cached; catalogue lookups then filter that index. Vision
 * folders are named "<Artist>_<Album>_<Catalogue>[suffix]", so a file belongs to
 * a catalogue when its path contains the catalogue token.
 *
 * Matching: by NORMALISED TRACK NAME, not sequence — Vision lists alphabetically
 * and may be partly digitised (5 of 10 tracks), and titles differ in punctuation
 * ("Ke Eng Hakana?" in FM vs "Ke Eng Hakana.wav" on Vision).
 */
import fs from 'fs'
import path from 'path'
import { visionList, visionAllKeys } from './vision-drive.js'
import { uploadAnyKey, downloadAnyKey, headAnyKey } from './s3-imports.js'

// The flat Vision index is persisted in the mass-music S3 bucket (survives
// Render restarts, unlike the ephemeral local disk) and mirrored to a local
// cache file. Requests LOAD it; they never build inside the request (a full
// build lists 54k+ keys over the slow Vision S3 — minutes — which would exceed
// the hosted request timeout). Rebuild via reindexVisionIndex() out-of-band.
const INDEX_S3_KEY = process.env.VISION_INDEX_S3_KEY || 'metadata/vision-audio-index.json'
let _building = false

const AUDIO_RE = /\.(wav|flac|aiff?|mp3|m4a|aac|ogg)$/i

// Which Vision subtrees to index. gallo-digital-cupboard is mostly raw working
// files (GMVault Captures, Batch 02, CMS Exports, …) — only "Rendered Files/"
// holds finished masters, so scope it. Other buckets are indexed whole. Override
// via buildVisionIndex({ scope }).
export const DEFAULT_SCOPE = { 'gallo-digital-cupboard': ['Rendered Files/'] }

/** Normalise a title/filename for comparison: NFC, strip diacritics, drop the
 *  extension, lowercase, keep only alphanumerics+spaces, collapse whitespace. */
export function normTitle(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(AUDIO_RE, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Normalise a catalogue number for loose containment matching (CYL 1054 →
 *  "cyl1054", so "CYL 1054a" / "CYL1054" folders still match). */
export function normCatalogue(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// In-memory cache so repeated requests in one process don't re-read S3/disk.
let _memIndex = null

/**
 * LOAD the index for a request — fast, never builds. Order: in-memory → local
 * cache file → S3. Returns null if it has never been built (caller should tell
 * the user to Reindex).
 */
export async function loadVisionIndex({ cacheFile } = {}) {
  if (_memIndex) return _memIndex
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (Array.isArray(c.files) && c.files.length) return (_memIndex = c)
    } catch { /* try S3 */ }
  }
  try {
    const head = await headAnyKey(INDEX_S3_KEY)
    if (head.exists) {
      const { buffer } = await downloadAnyKey(INDEX_S3_KEY)
      const c = JSON.parse(buffer.toString('utf8'))
      if (Array.isArray(c.files) && c.files.length) {
        if (cacheFile) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, buffer) } catch {} }
        return (_memIndex = c)
      }
    }
  } catch { /* not built yet */ }
  return null
}

export function indexBuilding() { return _building }

/**
 * BUILD the flat index by listing every Vision bucket (slow — minutes). Persists
 * to S3 (durable) and the local cache. Run OUT of a request (reindex action).
 */
export async function buildVisionIndex({ cacheFile, scope = DEFAULT_SCOPE, onProgress, persist = true } = {}) {
  _building = true
  try {
    const { entries } = await visionList('/')
    const buckets = entries.filter(e => e.type === 'dir').map(e => e.name)
    let files = []
    for (const b of buckets) {
      const prefixes = scope[b] || [''] // whole bucket unless scoped
      for (const prefix of prefixes) {
        const keys = await visionAllKeys(b, { prefix, onProgress: (n) => onProgress && onProgress(b, n) })
        files = files.concat(keys.filter(k => AUDIO_RE.test(k.key)).map(k => ({
          path: k.path, size: k.size, name: k.path.split('/').pop(),
        })))
      }
    }
    const index = { builtFiles: files.length, buckets, files, builtAtEpoch: null }
    const json = JSON.stringify(index)
    _memIndex = index
    if (cacheFile) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, json) } catch {} }
    if (persist) { try { await uploadAnyKey(Buffer.from(json), INDEX_S3_KEY, 'application/json') } catch (e) { onProgress && onProgress('s3-save-failed', e.message) } }
    return index
  } finally {
    _building = false
  }
}

/** Fire-and-forget rebuild guarded against overlap. Returns immediately. */
export function reindexVisionIndex({ cacheFile } = {}) {
  if (_building) return { started: false, reason: 'already-building' }
  buildVisionIndex({ cacheFile }).catch(err => console.error('[vision-index] rebuild failed:', err.message))
  return { started: true }
}

/** All indexed audio files whose path contains the catalogue token. */
export function filesForCatalogue(index, catalogue) {
  const c = normCatalogue(catalogue)
  if (!c) return []
  return index.files.filter(f => normCatalogue(f.path).includes(c))
}

/**
 * Match a catalogue's tracks to its Vision audio files by normalised title.
 * @param tracks [{ sequence_no, title, fm_record_id? }]
 * @returns { matched:[{track, file, audio_Url}], tracksNoAudio, filesNoTrack, folders }
 */
export function matchTracksToFiles(tracks, files) {
  const remaining = new Map(files.map((f, i) => [i, f]))
  const matched = []
  const tracksNoAudio = []

  for (const t of tracks) {
    const nt = normTitle(t.title)
    if (!nt) { tracksNoAudio.push(t); continue }
    // exact normalised match first, then a contains either-way (handles a
    // trailing "(Radio Edit)" or a leading track number on the file).
    let hitIdx = null
    for (const [i, f] of remaining) if (normTitle(f.name) === nt) { hitIdx = i; break }
    if (hitIdx == null) for (const [i, f] of remaining) {
      const nf = normTitle(f.name)
      if (nf.includes(nt) || nt.includes(nf)) { hitIdx = i; break }
    }
    if (hitIdx == null) { tracksNoAudio.push(t); continue }
    const f = remaining.get(hitIdx); remaining.delete(hitIdx)
    matched.push({ track: t, file: f, audio_Url: f.path })
  }

  const filesNoTrack = [...remaining.values()]
  const folders = [...new Set(files.map(f => f.path.replace(/\/[^/]+$/, '')))]
  return { matched, tracksNoAudio, filesNoTrack, folders }
}
