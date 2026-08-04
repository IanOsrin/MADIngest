// routes/vision-import.js — the Add Album tab: build a complete Gallo
// Catalogue album (one Tape Files Master record + one song record per track)
// from one or more Vision folders (vinyl A/B sides may live in separate
// folders) plus the metadata cache (Gallo_Metadata_Extract),
// writing Audio_URL so playback works immediately, exactly like the CYL 1054 /
// TJL 13000 pilot records.
//
// Two endpoints, one shared planner:
//   POST /preview — dry run. Lists the folder's audio, looks up the catalogue's
//                   tracks in the metadata cache, matches rows ↔ files by
//                   normalised title, and reports what WOULD be created.
//                   Blocked (409-shaped payload) if the catalogue already has
//                   Gallo records — this tab never appends to an existing album.
//   POST /create  — re-runs the same plan server-side (never trusts a stale
//                   browser payload), then writes: Tape Files Master first,
//                   then each song record sequentially. createGalloRecord's
//                   read-back verify covers Audio_URL.
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionList } from '../lib/vision-drive.js'
import { loadMetadata, lookupAlbumTracks, getStatus } from '../lib/metadata-cache.js'
import { normTitle } from '../lib/gallo-vision-link.js'
import { fuzzyScore } from '../lib/fuzzy-match.js'
import { findGalloRecordsByCatalogue, createGalloRecord, createTapeFileRecord, reloadGalloLayoutFields } from '../lib/fm-gallo.js'
import { readVisionWavInfo, buildSoundInfoBlock, computeVisionMd5 } from '../lib/wav-info.js'

const router = Router()
const AUDIO_RE = /\.(wav|flac|aif|aiff|mp3|m4a)$/i
// The formats that count as a master. m4a is an MP4 container — lossy — and
// must never be ingested as the master when a WAV exists.
const LOSSLESS_RE = /\.(wav|flac|aif|aiff)$/i

const yearOf = (s) => {
  const m = String(s || '').match(/(\d{4})/)
  return m ? m[1] : null
}

// Minimum similarity for a fuzzy claim. Measured on real titles: typos score
// 0.93+ ("Kuzwe"/"Kuzwa" 0.94, "Umbhulo"/"Umbulo" 0.93), a leading track number
// 0.89, accent differences 1.00, while genuinely different titles sit under 0.2.
// 0.72 sits in that gap with room either side. Extra-word cases ("Zahlangana
// Ngami" vs "Zahlangana Ngami Izangoma", 0.65) score low on raw edit distance
// but the containment pass has already claimed those, so they never reach here.
const FUZZY_MIN = 0.72

/**
 * Match cache rows to the folders' audio files by normalised title.
 *
 * Three passes, narrowing from certain to plausible:
 *   1. exact — so "I Wanna See The Sun" can't steal
 *      "I Wanna See the Sun (Instrumental).wav"
 *   2. containment, longest filename first
 *   3. fuzzy (Levenshtein), for typos and transcription drift between the
 *      metadata and whoever named the WAV
 *
 * The fuzzy pass assigns GLOBALLY BEST-FIRST rather than per row in order:
 * scoring every remaining pair and taking the strongest first stops track 1
 * claiming a file that is a far better match for track 5. Row order should not
 * decide the outcome.
 *
 * Files carry their source folder (A/B sides live in separate folders), so
 * claims are keyed on the full path — same-named files on both sides stay
 * individually claimable.
 *
 * Returns per-row `methods` and `scores` so the preview can show HOW each match
 * was made. A fuzzy match is a guess and the operator should be able to see it.
 */
// "Track 1", "track_02", "Trk 3", "01 Foo", "1. Foo", "01" -> 1, 2, 3, 1, 1, 1.
// Returns null when the name carries no leading position.
function trackNumFromName(name) {
  const base = String(name || '').replace(AUDIO_RE, '').trim()
  let m = base.match(/^(?:track|trk|tr)\s*[._-]?\s*(\d{1,3})$/i)
  if (m) return parseInt(m[1], 10)
  m = base.match(/^(\d{1,3})(?:\b|[._\s-])/)
  if (m) return parseInt(m[1], 10)
  return null
}

function matchTracksToFiles(rows, files) {
  const fileKey  = (f) => `${f.folder}/${f.name}`
  const fileNorm = (f) => normTitle(f.matchName || f.name) // matchName = title segment in flat folders
  const claimed = new Map() // folder/name → row index
  const matches = new Array(rows.length).fill(null)
  const methods = new Array(rows.length).fill(null)
  const scores  = new Array(rows.length).fill(null)

  rows.forEach((row, i) => {
    const want = normTitle(row.track_name)
    if (!want) return
    const hit = files.find(f => !claimed.has(fileKey(f)) && fileNorm(f) === want)
    if (hit) { claimed.set(fileKey(hit), i); matches[i] = hit; methods[i] = 'exact'; scores[i] = 1 }
  })

  rows.forEach((row, i) => {
    if (matches[i]) return
    const want = normTitle(row.track_name)
    if (!want) return
    const candidates = files
      .filter(f => !claimed.has(fileKey(f)))
      .filter(f => { const nf = fileNorm(f); return nf.includes(want) || want.includes(nf) })
      .sort((a, b) => fileNorm(b).length - fileNorm(a).length)
    if (candidates.length) {
      claimed.set(fileKey(candidates[0]), i); matches[i] = candidates[0]
      methods[i] = 'contains'; scores[i] = fuzzyScore(want, fileNorm(candidates[0]))
    }
  })

  // Pass 4 — track number. When files are named "Track 1", "01", "Trk 3" and
  // the like, the filename carries NO title signal at all and position is the
  // only thing linking a row to a file. Mirrors the FM Submit tab's pass 3,
  // which falls back to a number when name matching fails — though its
  // extractor is parseInt(filename), so it reads "01 Foo.wav" and not
  // "Track 1.wav". This handles both.
  //
  // Runs BEFORE fuzzy on purpose: "Track 1" against a real title scores near
  // zero, so fuzzy cannot rescue these, and a generic name must never be
  // fuzzy-matched to a title it merely resembles.
  const numbered = rows.some((r, i) => !matches[i]) &&
                   files.some(f => !claimed.has(fileKey(f)) && trackNumFromName(f.matchName || f.name) != null)
  if (numbered) {
    rows.forEach((row, i) => {
      if (matches[i]) return
      const want = Number(row.seq)
      if (!Number.isFinite(want)) return
      const hit = files.find(f => {
        if (claimed.has(fileKey(f))) return false
        const n = trackNumFromName(f.matchName || f.name)
        // Bounded by the tracklist: a title like "7 Seconds.wav" yields 7 and
        // could otherwise steal seq 7, while "1999.wav" yields 1999 and is
        // harmlessly out of range.
        return n != null && n === want && n <= rows.length
      })
      if (hit) { claimed.set(fileKey(hit), i); matches[i] = hit; methods[i] = 'track #'; scores[i] = null }
    })
  }

  const pairs = []
  rows.forEach((row, i) => {
    if (matches[i]) return
    const want = normTitle(row.track_name)
    if (!want) return
    for (const f of files) {
      if (claimed.has(fileKey(f))) continue
      const s = fuzzyScore(want, fileNorm(f))
      if (s >= FUZZY_MIN) pairs.push({ i, f, s })
    }
  })
  pairs.sort((a, b) => b.s - a.s)
  for (const p of pairs) {
    if (matches[p.i] || claimed.has(fileKey(p.f))) continue
    claimed.set(fileKey(p.f), p.i); matches[p.i] = p.f
    methods[p.i] = 'fuzzy'; scores[p.i] = p.s
  }

  return { matches, methods, scores, unmatchedFiles: files.filter(f => !claimed.has(fileKey(f))) }
}

/** Build the full import plan. Throws {status, message} on bad input. */
async function buildPlan({ folder, folders, catalogue, artist, album }) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }

  // One or several folders (vinyl A/B sides often live in separate folders,
  // e.g. …_ML 4090A and …_ML 4090B). Accept `folders` (array) or `folder`.
  const folderList = [...new Set(
    (Array.isArray(folders) ? folders : [folder])
      .map(f => String(f || '').trim().replace(/\/+$/, ''))
      .filter(Boolean)
      .map(f => f.startsWith('/') ? f : '/' + f)
  )]
  catalogue = String(catalogue || '').trim()
  artist    = String(artist    || '').trim()
  album     = String(album     || '').trim()
  if (!folderList.length) fail(400, 'At least one Vision folder path is required')
  if (!catalogue) fail(400, 'Catalogue number is required')
  // A slash means a folder path landed in the wrong field — catch it here
  // rather than letting it fail as "catalogue not found in the cache".
  if (catalogue.includes('/')) fail(400, `"${catalogue}" looks like a folder path, not a catalogue number — check the fields`)
  if (!artist)    fail(400, 'Artist name is required')
  if (!album)     fail(400, 'Album title is required')
  if (!visionStatus().configured) fail(503, 'Vision drive is not configured')

  // 1. The folders' audio files, each tagged with its source folder.
  //
  // Two Vision layouts exist. Rendered Files is folder-per-album (plain track
  // filenames); the GalloImports folders are FLAT — thousands of files from
  // many albums named Artist_Album_CAT_Track.wav. When any filename in a
  // folder carries the entered catalogue number, we treat the folder as flat:
  // only those files take part, and title matching runs on the track segment
  // AFTER the catalogue (the Artist_Album_CAT prefix would otherwise cause
  // cross-album title collisions).
  const normCat = catalogue.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const titlePartAfterCat = (name) => {
    const segs = name.replace(AUDIO_RE, '').split('_')
    const i = segs.findIndex(s => s.toLowerCase().replace(/[^a-z0-9]+/g, '') === normCat)
    return i >= 0 && i < segs.length - 1 ? segs.slice(i + 1).join('_') : name
  }
  const files = []
  const folderCounts = []
  for (const dirGiven of folderList) {
    let dir = dirGiven
    let { entries } = await visionList(dir).catch(e => fail(502, `Vision folder list failed for ${dir}: ${e.message}`))
    let audio = (entries || []).filter(e => e.type === 'file' && AUDIO_RE.test(e.name))

    // Prefer the masters. Some albums keep lossy copies in the album-named
    // folder and the WAVs in a subfolder beside them — e.g.
    //   izingane zamakhuze/amathambo/  8 x .m4a
    //   izingane zamakhuze/WAV/        8 x .wav
    // Pointing at the album folder would otherwise ingest the m4a as if it were
    // the master. If this folder has no lossless audio but a subfolder does,
    // switch to it. One level only, and only when the current folder offers
    // nothing lossless — an album that already has WAVs is left alone.
    if (!audio.some(f => LOSSLESS_RE.test(f.name))) {
      const subs = (entries || []).filter(e => e.type === 'dir')
      // A folder actually called WAV wins over any other candidate.
      subs.sort((a, b) => (/^wavs?$/i.test(b.name) ? 1 : 0) - (/^wavs?$/i.test(a.name) ? 1 : 0))
      const candidates = subs.map(s => ({ name: s.name, path: `${dir.replace(/\/+$/, '')}/${s.name}` }))

      // …and beside them. The real layout puts the masters in a SIBLING:
      //   izingane zamakhuze/amathambo/  8 x .m4a   <- the album folder
      //   izingane zamakhuze/WAV/        8 x .wav   <- the masters
      // Only a sibling explicitly named WAV/WAVS is considered. Any other
      // sibling is a different album, and guessing across albums would be far
      // worse than importing nothing.
      const parent = dir.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
      if (parent) {
        const pr = await visionList(parent).catch(() => ({ entries: [] }))
        for (const e of (pr.entries || [])) {
          if (e.type === 'dir' && /^wavs?$/i.test(e.name)) candidates.push({ name: e.name, path: `${parent}/${e.name}`, sibling: true })
        }
      }

      for (const c of candidates) {
        const r = await visionList(c.path).catch(() => ({ entries: [] }))
        const subAudio = (r.entries || []).filter(e => e.type === 'file' && AUDIO_RE.test(e.name))
        if (subAudio.some(f => LOSSLESS_RE.test(f.name))) {
          console.log(`[vision-import] ${dirGiven}: no lossless audio here, using ${c.sibling ? 'sibling ' : ''}${c.name}/ (${subAudio.length} file(s))`)
          dir = c.path; entries = r.entries; audio = subAudio
          break
        }
      }
    }

    // Same track delivered twice — keep the lossless copy, drop the lossy one.
    const byBase = new Map()
    for (const f of audio) {
      const base = f.name.replace(AUDIO_RE, '').toLowerCase()
      const prev = byBase.get(base)
      if (!prev || (LOSSLESS_RE.test(f.name) && !LOSSLESS_RE.test(prev.name))) byBase.set(base, f)
    }
    if (byBase.size < audio.length) {
      console.log(`[vision-import] ${dir}: ${audio.length - byBase.size} lossy duplicate(s) ignored in favour of the lossless copy`)
      audio = [...byBase.values()]
    }
    const catFiles = normCat
      ? audio.filter(f => f.name.toLowerCase().replace(/[^a-z0-9]+/g, '').includes(normCat))
      : []
    const use = catFiles.length ? catFiles : audio
    folderCounts.push({ folder: dir, audioFiles: use.length, totalAudio: audio.length, filteredByCatalogue: !!catFiles.length })
    for (const f of use) files.push({ name: f.name, size: f.size, folder: dir, matchName: catFiles.length ? titlePartAfterCat(f.name) : f.name })
  }
  if (!files.length) fail(404, `No audio files found in ${folderList.join(' + ')}`)

  // 2. The catalogue's track rows from the metadata cache. The cache loads at
  // boot (routes/ingest.js); only trigger a load when that hasn't finished —
  // reloading per-request would re-pull the whole extract from S3 every click.
  if (!getStatus().loaded) await loadMetadata()
  const rows = lookupAlbumTracks(catalogue)
  if (!rows.length) fail(404, `Catalogue "${catalogue}" not found in the metadata cache — add it via the Cache Viewer first`)

  // 3. Duplicate guard — this tab only creates brand-new albums.
  const existing = await findGalloRecordsByCatalogue(catalogue).catch(e => fail(502, `FM duplicate check failed: ${e.message}`))
  if (existing.length) {
    return {
      blocked: true,
      existingCount: existing.length,
      existing: existing.slice(0, 30).map(r => ({
        fm_record_id: r.fm_record_id, title: r.title, isrc: r.isrc, sequence_no: r.sequence_no,
      })),
    }
  }

  // 4. Match rows ↔ files and shape the per-track create metadata.
  const { matches, methods, scores, unmatchedFiles } = matchTracksToFiles(rows, files)
  const first = rows[0]
  const tracks = rows.map((row, i) => {
    const file = matches[i]
    return {
      seq:        row.seq ?? null,
      title:      row.track_name,
      isrc:       row.isrc,
      duration:   row.duration,
      wav:        file ? file.name : null,
      wav_folder: file ? file.folder : null,
      match_method: methods[i],
      match_score:  scores[i] == null ? null : Math.round(scores[i] * 100) / 100,
      size:       file ? file.size : null,
      audio_url:  file ? `${file.folder}/${file.name}`.normalize('NFC') : null,
      metadata: {
        title:                 row.track_name,
        artist:                row.track_artist || artist,
        album_artist:          row.album_artist || artist,
        featured_artist:       row.featured_artist,
        album:                 album,
        catalogue_no:          catalogue,
        isrc:                  row.isrc,
        barcode:               row.barcode,
        sequence_no:           row.seq,
        duration:              row.duration,
        genre:                 row.genre,
        language:              row.audio_language || row.language,
        composers:             row.composer,
        producers:             row.producer,
        publishers:            row.publisher,
        label:                 row.label,
        p_line:                row.p_line,
        c_line:                row.c_line,
        release_date:          row.release_date,
        original_release_date: row.original_release_date,
        parental:              row.parental,
        rights_territories:    row.rights_territories,
        year:                  yearOf(row.release_date || row.original_release_date),
        audio_url:             file ? `${file.folder}/${file.name}`.normalize('NFC') : null,
        // Deliberately NO wav_filename: the FM 'Filename' field must stay
        // empty on Add Album records (Ian, 2026-07-24) — Audio_URL is the
        // audio reference. audio_hash_md5 is computed at create time.
      },
    }
  })

  const tapeMeta = {
    album_artist:          first.album_artist || artist,
    album:                 album,
    catalogue_no:          catalogue,
    barcode:               first.barcode,
    year:                  yearOf(first.release_date || first.original_release_date),
    release_date:          first.release_date,
    original_release_date: first.original_release_date,
    genre:                 first.genre,
    language:              first.audio_language || first.language,
    rights_territories:    first.rights_territories,
    parental:              first.parental,
    label:                 first.label,
    p_line:                first.p_line,
    c_line:                first.c_line,
    publishers:            first.publisher,
  }

  return {
    blocked: false,
    folders: folderList, folderCounts, catalogue, artist, album,
    tapeMeta, tracks,
    matchedCount:   tracks.filter(t => t.wav).length,
    unmatchedRows:  tracks.filter(t => !t.wav).length,
    unmatchedFiles: unmatchedFiles.map(f => ({ name: f.name, size: f.size, folder: f.folder })),
  }
}

const publicTrack = ({ metadata, ...t }) => t // strip the FM payload from responses

router.post('/preview', adminAuth, express.json(), async (req, res) => {
  const t0 = Date.now()
  try {
    const plan = await buildPlan(req.body || {})
    console.log(`[vision-import] preview ${req.body?.catalogue}: ok in ${Date.now() - t0}ms${plan.blocked ? ' (blocked)' : ''}`)
    if (plan.blocked) return res.json({ ok: true, blocked: true, existingCount: plan.existingCount, existing: plan.existing })
    res.json({
      ok: true, blocked: false,
      folders: plan.folders, folderCounts: plan.folderCounts, catalogue: plan.catalogue,
      matchedCount: plan.matchedCount, unmatchedRows: plan.unmatchedRows,
      tracks: plan.tracks.map(publicTrack),
      unmatchedFiles: plan.unmatchedFiles,
    })
  } catch (e) {
    console.error(`[vision-import] preview ${req.body?.catalogue} FAILED after ${Date.now() - t0}ms:`, e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.post('/create', adminAuth, express.json(), async (req, res) => {
  const includeUnmatched = req.body?.includeUnmatched !== false
  try {
    const plan = await buildPlan(req.body || {})
    if (plan.blocked) {
      return res.status(409).json({ error: `Catalogue "${req.body?.catalogue}" already has ${plan.existingCount} Gallo record(s) — refusing to create duplicates`, existing: plan.existing })
    }

    const toCreate = plan.tracks.filter(t => t.wav || includeUnmatched)
    if (!toCreate.length) return res.status(400).json({ error: 'Nothing to create — no cache rows matched the folder\'s audio' })

    console.log(`[vision-import] CREATE ${plan.catalogue} — "${plan.album}" by ${plan.artist}: ${toCreate.length} song record(s) (${plan.matchedCount} with audio), folder(s) ${plan.folders.join(' + ')}`)

    // Re-introspect the layout once per run — fields like "Audio details" are
    // often added in FileMaker mid-session and the in-process cache would
    // silently drop writes to them otherwise (same pattern as the enrich flow).
    reloadGalloLayoutFields()

    // Tape Files Master first — album-level fields cascade onto songs via the
    // FM relationship. A tape failure aborts the whole import (nothing else
    // written yet), rather than leaving songs with no album record.
    const { tapeRecordId } = await createTapeFileRecord(plan.tapeMeta)
    console.log(`[vision-import] Tape Files Master created: ${tapeRecordId}`)

    // Song records sequentially — keeps FM Data API load sane and the log readable.
    const results = []
    for (const t of toCreate) {
      try {
        // Fill "Audio details" (the Media_GetSoundInfo block, from the WAV
        // header) and AudioHashSum (MD5, streamed over the whole file). A
        // read failure never blocks the create — that field just stays empty.
        if (t.audio_url) {
          try {
            const read = await readVisionWavInfo(t.audio_url)
            if (read) t.metadata.audio_details = buildSoundInfoBlock(read.info, { modified: read.modified })
          } catch (e) {
            console.warn(`[vision-import] audio-details read failed for ${t.title}: ${e.message}`)
          }
          try {
            const tHash = Date.now()
            t.metadata.audio_hash_md5 = await computeVisionMd5(t.audio_url)
            console.log(`[vision-import] md5 ${t.title}: ${t.metadata.audio_hash_md5} (${Date.now() - tHash}ms)`)
          } catch (e) {
            console.warn(`[vision-import] md5 failed for ${t.title}: ${e.message}`)
          }
        }
        const { fmRecordId } = await createGalloRecord(t.metadata)
        results.push({ ...publicTrack(t), fmRecordId, ok: true, audioDetails: !!t.metadata.audio_details, audioHash: t.metadata.audio_hash_md5 || null })
      } catch (e) {
        console.warn(`[vision-import] ✗ ${t.title}: ${e.message}`)
        results.push({ ...publicTrack(t), ok: false, error: e.message })
      }
    }

    const created = results.filter(r => r.ok).length
    const failed  = results.length - created
    console.log(`[vision-import] DONE ${plan.catalogue}: tape ${tapeRecordId}, ${created} song(s) created${failed ? `, ${failed} FAILED` : ''}`)
    res.json({ ok: failed === 0, tapeRecordId, created, failed, results })
  } catch (e) {
    console.error('[vision-import] create failed:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

export default router
