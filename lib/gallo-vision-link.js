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

const AUDIO_RE = /\.(wav|flac|aiff?|mp3|m4a|aac|ogg)$/i

// Everything is indexed. This used to be scoped to two prefixes of
// gallo-digital-cupboard ("Rendered Files/", "Gallo Imports Master/") on the
// grounds that the rest was raw working files — but that silently excluded 18
// folders and roughly half the audio on the drive, so a new folder like
// "CCA - Test Assets" could never be found however often you pressed Reindex
// (Ian, 2026-08-07). Folders are indexed individually, so breadth costs time
// spread over passes rather than one unfinishable scan.

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

export function indexBuilding() { return _state.running }

// ── Index state, so the UI can say more than "started" ───────────────────────
// The old reindex was fire-and-forget: it returned {started:true} and any
// failure went to the server log. A build that died left a stale index and no
// visible error — which is exactly how an index dated three days ago went
// unnoticed while someone pressed Reindex and waited (Ian, 2026-08-07).
const _state = {
  running: false, startedAt: null, phase: null, folder: null,
  lastRunAt: null, lastError: null, lastAdded: 0, lastRefreshed: 0, lastRemoved: 0,
}
export function indexStatus() {
  const idx = _memIndex
  return {
    ..._state,
    builtFiles: idx?.builtFiles || 0,
    folders: idx?.folders ? Object.keys(idx.folders).length : 0,
    oldestFolderAt: idx?.folders
      ? Math.min(...Object.values(idx.folders).map(f => f.indexedAtEpoch || 0), Infinity)
      : null,
  }
}

/** Top-level folders of a bucket — one delimiter listing, so it is nearly free. */
async function topFolders(bucket) {
  const { entries } = await visionList('/' + bucket)
  return (entries || [])
    .filter(e => (e.type === 'dir' || e.isDir) && !e.name.startsWith('.'))
    .map(e => e.name)
}

/** List one folder's audio files. This is the unit of work — see refreshVisionIndex. */
async function indexOneFolder(bucket, folder, onProgress) {
  const keys = await visionAllKeys(bucket, {
    prefix: folder + '/',
    onProgress: n => onProgress && onProgress(`${bucket}/${folder}`, n),
  })
  const files = keys.filter(k => AUDIO_RE.test(k.key)).map(k => ({
    path: k.path, size: k.size, name: k.path.split('/').pop(),
  }))
  // objects, not files: what a listing costs is everything it walks past.
  // "Artists and PR folders" is 17,167 objects for 505 audio files — cheap by
  // file count, nearly two minutes to list.
  return { files, objects: keys.length }
}

const _flatten = (folders) => {
  const files = []
  for (const f of Object.values(folders)) if (f.files) files.push(...f.files)
  return files
}

async function _persist(index, cacheFile, persist, onProgress) {
  const json = JSON.stringify(index)
  _memIndex = index
  if (cacheFile) {
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, json) } catch {}
  }
  if (persist) {
    try { await uploadAnyKey(Buffer.from(json), INDEX_S3_KEY, 'application/json') }
    catch (e) { onProgress && onProgress('s3-save-failed', e.message) }
  }
}

/**
 * REFRESH the index one folder at a time.
 *
 * Listing every object in both Vision drives takes tens of minutes — one folder
 * alone ("Artists and PR folders") is 17,000 objects and nearly two minutes —
 * so a full rebuild was too slow to finish and new work stayed invisible.
 * But the folders people actually add are tiny: "CCA - Test Assets" is 14
 * objects and lists in under a second.
 *
 * So the unit of work is a folder, not a drive:
 *   1. discover the current top-level folders (one cheap listing per bucket)
 *   2. drop folders that have gone
 *   3. index folders we have never seen — a NEW folder is picked up at once
 *   4. spend whatever time is left refreshing the stalest known folders
 *
 * Every pass persists, so progress survives being interrupted, and a new folder
 * shows up in search within seconds instead of waiting on a whole-estate scan.
 */
export async function refreshVisionIndex({
  cacheFile, onProgress, persist = true,
  budgetMs = Number(process.env.VISION_INDEX_BUDGET_MS || 120000),
  full = false,
} = {}) {
  if (_state.running) return { started: false, reason: 'already-building' }
  _state.running = true
  _state.startedAt = Date.now()
  _state.phase = 'discovering'
  _state.lastError = null
  const t0 = Date.now()
  const spent = () => Date.now() - t0

  try {
    const existing = (!full && await loadVisionIndex({ cacheFile })) || null
    let folders = (existing && existing.folders) ? { ...existing.folders } : {}

    // Migrate a v1 index (flat file list, no folder breakdown) by grouping what
    // it already holds. Stamped as maximally stale so every folder is due a
    // refresh, but KNOWN — otherwise the first run after this ships would treat
    // all 20 folders as new and do the very whole-estate scan this replaces.
    if (!Object.keys(folders).length && existing && Array.isArray(existing.files) && existing.files.length) {
      for (const f of existing.files) {
        const parts = f.path.split('/')            // /bucket/folder/...
        const key = `${parts[1]}/${parts[2]}`
        if (!folders[key]) folders[key] = { files: [], indexedAtEpoch: 0 }
        folders[key].files.push(f)
      }
      for (const k of Object.keys(folders)) folders[k].count = folders[k].files.length
      console.log(`[vision-index] migrated ${existing.files.length} files into ${Object.keys(folders).length} folders`)
    }

    const { entries } = await visionList('/')
    const buckets = (entries || []).filter(e => e.type === 'dir' || e.isDir).map(e => e.name)

    const live = []
    for (const b of buckets) for (const f of await topFolders(b)) live.push(`${b}/${f}`)

    // Gone from the drive → gone from the index.
    let removed = 0
    for (const key of Object.keys(folders)) {
      if (!live.includes(key)) { delete folders[key]; removed++ }
    }

    // New folders first: they are why someone is looking, and they are cheap.
    // Order refreshes by cost as well as age. The budget can only be checked
    // BETWEEN folders — an S3 listing cannot be cut off part-way — so a pass
    // that starts on "Gallo Record Company Music - WAVs" (44,464 objects) runs
    // for minutes whatever the budget says. Sorting purely by staleness put a
    // giant first almost every time.
    //
    // So the big folders are held back: they are only eligible once genuinely
    // old, and at most one is taken per pass. They are also the ones that change
    // least — bulk archives, not working folders — while the folders people
    // actually add to are small and now come round quickly.
    const BIG_OBJECTS = Number(process.env.VISION_INDEX_BIG_OBJECTS || 10000)
    const BIG_MAX_AGE = Number(process.env.VISION_INDEX_BIG_AGE_MS || 24 * 60 * 60 * 1000)
    const now = Date.now()
    // Falls back to the file count for folders indexed before `objects` was
    // recorded, so a migrated index still throttles sensibly on the first pass.
    const isBig = k => (folders[k]?.objects ?? folders[k]?.count ?? 0) >= BIG_OBJECTS
    const age   = k => now - (folders[k]?.indexedAtEpoch || 0)

    const unseen = live.filter(k => !folders[k])
    const known  = live.filter(k => folders[k])
                       .sort((a, b) => (folders[a].indexedAtEpoch || 0) - (folders[b].indexedAtEpoch || 0))
    const small  = known.filter(k => !isBig(k))
    const bigDue = known.filter(k => isBig(k) && age(k) > BIG_MAX_AGE).slice(0, 1)
    const queue  = [...unseen, ...small, ...bigDue]

    let added = 0, refreshed = 0
    for (const key of queue) {
      const isNew = !folders[key]
      // New folders are always done, however long it takes. Refreshes stop when
      // the budget is out — the rest are picked up on the next pass, oldest
      // first, so the whole estate comes round in time.
      if (!isNew && spent() > budgetMs) break
      const [bucket, ...rest] = key.split('/')
      const folder = rest.join('/')
      _state.phase = isNew ? 'indexing new folder' : 'refreshing'
      _state.folder = key
      try {
        const { files, objects } = await indexOneFolder(bucket, folder, onProgress)
        folders[key] = { files, indexedAtEpoch: Date.now(), count: files.length, objects }
        isNew ? added++ : refreshed++
        if (isNew) await _persist(
          { builtFiles: _flatten(folders).length, buckets, folders, files: _flatten(folders), builtAtEpoch: Date.now() },
          cacheFile, persist, onProgress)          // publish a new folder immediately
      } catch (e) {
        folders[key] = { ...(folders[key] || { files: [] }), error: e.message, indexedAtEpoch: Date.now() }
        onProgress && onProgress(key, `error: ${e.message}`)
      }
    }

    const files = _flatten(folders)
    const index = { builtFiles: files.length, buckets, folders, files, builtAtEpoch: Date.now() }
    _state.phase = 'saving'
    await _persist(index, cacheFile, persist, onProgress)

    _state.lastRunAt = Date.now()
    _state.lastAdded = added; _state.lastRefreshed = refreshed; _state.lastRemoved = removed
    console.log(`[vision-index] ${added} new, ${refreshed} refreshed, ${removed} gone · ${files.length} files across ${Object.keys(folders).length} folders in ${Math.round(spent()/1000)}s`)
    return index
  } catch (err) {
    _state.lastError = err.message
    _state.lastRunAt = Date.now()
    console.error('[vision-index] refresh failed:', err.message)
    throw err
  } finally {
    _state.running = false
    _state.phase = null
    _state.folder = null
  }
}

/**
 * Kept for callers that want the old whole-estate rebuild. It is now a refresh
 * with no time limit that ignores what is already indexed.
 */
export async function buildVisionIndex({ cacheFile, onProgress, persist = true } = {}) {
  return refreshVisionIndex({ cacheFile, onProgress, persist, full: true, budgetMs: Infinity })
}

/** Fire-and-forget refresh guarded against overlap. Returns immediately. */
export function reindexVisionIndex({ cacheFile, full = false, budgetMs } = {}) {
  if (_state.running) return { started: false, reason: 'already-building' }
  refreshVisionIndex({ cacheFile, full, budgetMs })
    .catch(err => console.error('[vision-index] rebuild failed:', err.message))
  return { started: true }
}

/**
 * Keep the index current without anyone pressing a button. Each tick discovers
 * new folders and refreshes the stalest few within a small budget, so a folder
 * added at any point is searchable within a cycle.
 */
export function startVisionIndexAutoRefresh({ cacheFile } = {}) {
  const every = Number(process.env.VISION_INDEX_AUTO_MS || 15 * 60 * 1000)
  if (!every || every < 0) return null            // set to 0 to switch off
  const tick = () => {
    if (_state.running) return
    refreshVisionIndex({ cacheFile }).catch(() => { /* logged in refresh */ })
  }
  setTimeout(tick, 30 * 1000).unref?.()           // once, shortly after boot
  const t = setInterval(tick, every)
  t.unref?.()
  console.log(`[vision-index] auto-refresh every ${Math.round(every / 60000)} min`)
  return t
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
