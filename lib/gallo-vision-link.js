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

/** Build a flat index of all audio files across every Vision bucket, cached to
 *  disk. Pass { refresh:true } to rebuild. */
export async function buildVisionIndex({ cacheFile, refresh = false, scope = DEFAULT_SCOPE, onProgress } = {}) {
  if (cacheFile && !refresh && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (Array.isArray(cached.files) && cached.files.length) return cached
    } catch { /* fall through and rebuild */ }
  }
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
  const index = { builtFiles: files.length, buckets, files }
  if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(index)) }
  return index
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
