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
  // _rehydrate rebuilds the flattened lists, which are no longer written to the
  // file. An index written by an older build still HAS them, and rehydrate
  // leaves those alone, so both shapes load.
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const c = _rehydrate(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))
      if (Array.isArray(c.files) && c.files.length) return (_memIndex = c)
    } catch { /* try S3 */ }
  }
  try {
    const head = await headAnyKey(INDEX_S3_KEY)
    if (head.exists) {
      const { buffer } = await downloadAnyKey(INDEX_S3_KEY)
      const c = _rehydrate(JSON.parse(buffer.toString('utf8')))
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
    builtOthers: idx?.builtOthers || 0,
    // Folders indexed before non-audio was added carry no `others` key at all;
    // they gain one when the rotation next reaches them. Reported so the UI can
    // say "still filling in" rather than implying non-audio search is complete.
    foldersWithOthers: idx?.folders
      ? Object.values(idx.folders).filter(f => Array.isArray(f.others)).length
      : 0,
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

// Junk that is never worth indexing — OS litter, not content.
const JUNK_RE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/i

// Whole trees that are machinery rather than content. People have parked
// website checkouts on Vision, and indexing those wholesale buries the real
// files: of the first 4,427 non-audio objects found, 4,236 were node_modules
// and .git internals — 96% noise against 191 actual documents and images
// (Ian, 2026-08-17). Applied to NON-AUDIO ONLY, so no audio can ever be hidden
// by a path rule.
const NOISE_RE = new RegExp(
  process.env.VISION_INDEX_NOISE_DIRS
    ? `/(${process.env.VISION_INDEX_NOISE_DIRS.split(',').map(s => s.trim()).filter(Boolean).join('|')})/`
    : '/(node_modules|\\.git|\\.scannerwork|\\.next|\\.cache|__pycache__)/',
)

// Sidecars an audio editor drops next to a WAV: waveform caches, peak files,
// marker files, scratch temps. They carry the track's name, so unfiltered they
// double every search result — 6,300 of them turned up beside the real files on
// the first full non-audio pass (Ian, 2026-08-17). Override with
// VISION_INDEX_SIDECAR_EXTS (comma-separated, no dots) to index them again.
const SIDECAR_RE = new RegExp(
  `\\.(${(process.env.VISION_INDEX_SIDECAR_EXTS || 'gpk,peak,pkf,mrk,mon,asd,sfk,ovw,reapeaks,\\$\\$\\$')
    .split(',').map(s => s.trim()).filter(Boolean).join('|')})$`, 'i')

const isOther = k => !AUDIO_RE.test(k.key) && !JUNK_RE.test(k.key)
  && !NOISE_RE.test(k.path) && !SIDECAR_RE.test(k.key)

/**
 * List one folder, splitting audio from everything else.
 *
 * AUDIO AND NON-AUDIO ARE KEPT APART ON PURPOSE. filesForCatalogue() matches a
 * catalogue number against index.files to fill in a track's audio_Url, so a
 * sleeve scan or a DDEX XML landing in that array would be silently linked as
 * the audio for a track. Non-audio therefore lives in its own `others` list
 * that only search reads (Ian, 2026-08-17).
 */
async function indexOneFolder(bucket, folder, onProgress) {
  const keys = await visionAllKeys(bucket, {
    prefix: folder + '/',
    onProgress: n => onProgress && onProgress(`${bucket}/${folder}`, n),
  })
  const entry = k => ({ path: k.path, size: k.size, name: k.path.split('/').pop() })
  const files = keys.filter(k => AUDIO_RE.test(k.key)).map(entry)
  const others = keys.filter(isOther).map(entry)
  // objects, not files: what a listing costs is everything it walks past.
  // "Artists and PR folders" is 17,167 objects for 505 audio files — cheap by
  // file count, nearly two minutes to list.
  return { files, others, objects: keys.length }
}

// `files` is audio; `others` is everything else. Both are flattened the same
// way, but they must never be merged — see indexOneFolder.
const _flatten = (folders, key = 'files') => {
  const out = []
  for (const f of Object.values(folders)) if (f[key]) out.push(...f[key])
  return out
}

/** The whole index object, built from the folder map. */
const _assemble = (folders, buckets) => {
  const files = _flatten(folders, 'files')
  const others = _flatten(folders, 'others')
  return {
    builtFiles: files.length, builtOthers: others.length,
    buckets, folders, files, others, builtAtEpoch: Date.now(),
  }
}

/**
 * Serialise WITHOUT the flattened lists. `files` and `others` hold the very
 * same records that `folders` already holds, so writing both put every entry in
 * the file twice — 53MB where 27MB would do. Parsing that on the 512MB plan
 * died inside JSON.parse at a 256MB heap: "Reached heap limit Allocation
 * failed", and the service would not start (Ian, 2026-08-17). They cost nothing
 * to rebuild after the parse — see loadVisionIndex.
 */
function _serialise(index) {
  const { files, others, ...slim } = index
  return JSON.stringify(slim)
}

/** Put the flattened lists back on an index that was loaded from disk or S3. */
function _rehydrate(c) {
  if (!c || !c.folders) return c
  if (!Array.isArray(c.files))  c.files  = _flatten(c.folders, 'files')
  if (!Array.isArray(c.others)) c.others = _flatten(c.folders, 'others')
  return c
}

async function _persist(index, cacheFile, persist, onProgress) {
  const json = _serialise(index)
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
    // The due big folder goes BEFORE the small refreshes, not after. Behind
    // them it was never reached: the small folders alone overrun the 120s
    // budget (~180s), so every pass broke partway through `small` and the big
    // folders stayed at their migration timestamp indefinitely — 175 passes
    // without one being touched, which is why new work under "Rendered Files"
    // (e.g. Updates/Clara Taub) was unsearchable (Ian, 2026-08-17).
    // It is still at most one per pass and only once genuinely old, so a big
    // folder costs one long pass a day and the smalls get the next one whole.
    const queue  = [...unseen, ...bigDue, ...small]

    let added = 0, refreshed = 0
    for (const key of queue) {
      const isNew = !folders[key]
      const isDueBig = bigDue.includes(key)
      // New folders are always done, however long it takes, and so is the due
      // big folder — it cannot fit in the budget by definition, and skipping it
      // is what starved it. Ordinary refreshes stop when the budget is out; the
      // rest are picked up next pass, oldest first, so everything comes round.
      if (!isNew && !isDueBig && spent() > budgetMs) break
      const [bucket, ...rest] = key.split('/')
      const folder = rest.join('/')
      _state.phase = isNew ? 'indexing new folder' : 'refreshing'
      _state.folder = key
      try {
        const { files, others, objects } = await indexOneFolder(bucket, folder, onProgress)
        folders[key] = { files, others, indexedAtEpoch: Date.now(), count: files.length, otherCount: others.length, objects }
        isNew ? added++ : refreshed++
        if (isNew) await _persist(_assemble(folders, buckets), cacheFile, persist, onProgress) // publish a new folder immediately
      } catch (e) {
        folders[key] = { ...(folders[key] || { files: [] }), error: e.message, indexedAtEpoch: Date.now() }
        onProgress && onProgress(key, `error: ${e.message}`)
      }
    }

    const index = _assemble(folders, buckets)
    _state.phase = 'saving'
    await _persist(index, cacheFile, persist, onProgress)

    _state.lastRunAt = Date.now()
    _state.lastAdded = added; _state.lastRefreshed = refreshed; _state.lastRemoved = removed
    console.log(`[vision-index] ${added} new, ${refreshed} refreshed, ${removed} gone · ${index.builtFiles} audio + ${index.builtOthers} other across ${Object.keys(folders).length} folders in ${Math.round(spent()/1000)}s`)
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

/**
 * Reindex ONE path — a top-level folder or any subfolder inside one.
 *
 * The rotation above works in whole top-level folders, which is the wrong grain
 * when you have just dropped files into somewhere like "Rendered Files/Updates":
 * that subfolder is a handful of objects, but its parent is 21,000+ and takes
 * minutes, so making the new work searchable meant waiting for the parent's turn
 * (Ian, 2026-08-17). This lists only the given prefix and splices the result
 * into the parent's file list, so a new subfolder is searchable in seconds.
 *
 * `path` is a browse path as shown in the UI crumb, e.g.
 * "/gallo-digital-cupboard/Rendered Files/Updates".
 */
export async function reindexVisionPath(pathArg, { cacheFile, persist = true, onProgress } = {}) {
  // A full pass keeps the folder map in a local and rewrites it wholesale when
  // it finishes, so a splice made underneath it would be silently dropped.
  if (_state.running) return { ok: false, reason: 'already-building' }

  const parts = String(pathArg || '').split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('Give a path inside a top-level folder, e.g. /bucket/Rendered Files/Updates')
  const [bucket, top, ...sub] = parts
  const topKey = `${bucket}/${top}`
  const prefix = [top, ...sub].join('/') + '/'

  _state.running = true
  _state.phase = 'indexing folder'
  _state.folder = topKey + (sub.length ? '/' + sub.join('/') : '')
  const t0 = Date.now()
  try {
    const keys = await visionAllKeys(bucket, { prefix, onProgress: n => onProgress && onProgress(_state.folder, n) })
    const entryOf = k => ({ path: k.path, size: k.size, name: k.path.split('/').pop() })
    const found = keys.filter(k => AUDIO_RE.test(k.key)).map(entryOf)
    const foundOthers = keys.filter(isOther).map(entryOf)

    const existing = await loadVisionIndex({ cacheFile })
    const folders = { ...((existing && existing.folders) || {}) }
    const entry = folders[topKey] || { files: [], others: [], indexedAtEpoch: 0 }

    // Replace only what lives under this prefix; everything else in the parent
    // stays as it was. `/bucket/` + prefix reconstructs the stored path form.
    const pathPrefix = `/${bucket}/${prefix}`
    const under = f => f.path.startsWith(pathPrefix)
    const kept = (entry.files || []).filter(f => !under(f))
    const keptOthers = (entry.others || []).filter(f => !under(f))
    const files = [...kept, ...found]
    const others = [...keptOthers, ...foundOthers]

    // Deliberately NOT stamping indexedAtEpoch when this was a partial: the
    // parent has not been fully verified, and marking it fresh would push it to
    // the back of the staleness queue — the same starvation this is working
    // around. A whole-folder reindex does stamp it.
    const isWholeFolder = sub.length === 0
    folders[topKey] = {
      ...entry,
      files, others,
      count: files.length,
      otherCount: others.length,
      ...(isWholeFolder
        ? { indexedAtEpoch: Date.now(), objects: keys.length }
        : { indexedAtEpoch: entry.indexedAtEpoch || 0 }),
    }

    await _persist(_assemble(folders, (existing && existing.buckets) || [bucket]), cacheFile, persist, onProgress)

    const took = Date.now() - t0
    console.log(`[vision-index] path ${_state.folder} · ${found.length} audio + ${foundOthers.length} other of ${keys.length} objects in ${Math.round(took / 1000)}s`)
    return {
      ok: true, path: _state.folder, audio: found.length, others: foundOthers.length,
      objects: keys.length, tookMs: took,
      replaced: ((entry.files || []).length - kept.length) + ((entry.others || []).length - keptOthers.length),
    }
  } finally {
    _state.running = false
    _state.phase = null
    _state.folder = null
  }
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
