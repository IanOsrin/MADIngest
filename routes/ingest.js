/**
 * routes/ingest.js
 * Gallo Catalogue ingest API.
 * Flow: upload → S3 AudioImports/ → FileMaker Gallo Catalogue record
 */

import express, { Router } from 'express'
import multer from 'multer'
import path from 'path'
import os from 'os'
import { readFile, writeFile, unlink, mkdir, rm } from 'fs/promises'
import { mkdirSync, existsSync } from 'fs'
import { adminAuth } from '../lib/admin-auth.js'
import { extractAudioMeta, detectAudioFormat, generateWarnings, titleFromFilename } from '../lib/audio-meta.js'
import { parseDDEXPackage, parseDDEXXml } from '../lib/ddex.js'
import { parseTrackSheet } from '../lib/excel-ingest.js'
import { uploadImport, uploadArtworkImport, presignImport, presignArtworkImport, downloadImport,
         uploadMp3ByGcat, uploadWavByGcat, uploadArtworkByGmvi, uploadPlaylistArt, downloadAnyKey, keyFromS3Url, downloadByUrl } from '../lib/s3-imports.js'
import { createGalloRecord, createTapeFileRecord, updateGalloRecord, runGalloScript, runScriptOnRecord, pingGallo, findGalloRecordsByCatalogue, searchGalloRecords, fetchContainerData, getGalloTrack, getGalloLayoutFields, getGalloLayoutFieldSet, reloadGalloLayoutFields, getRecentGalloCreates, clearRecentGalloCreates } from '../lib/fm-gallo.js'
import { lookupGmviByCatalogue, upsertMp3Record, upsertTapeFileRecord, pingMadStreamer, getLayoutFields, reloadLayoutFields, findRecordsByCatalogue as findStreamerRecordsByCatalogue, searchMadStreamerRecords, findArtistBio, upsertArtistBio, listArtistBios, findPlaylistArt, upsertPlaylistArt, listPlaylistArt, findStreamerSongsByArtist, listPublicPlaylists, findSongsByPlaylist, setPublicPlaylist, getStreamerSongAudioUrl, _config as madStreamerConfig } from '../lib/madstreamer.js'
import {
  pingCms2024,
  findRecord            as findCms2024Record,
  findRecords           as findCms2024Records,
  findRecordsByCatalogue as findCms2024RecordsByCatalogue,
  findArtworkByCatalogue as findCms2024ArtworkByCatalogue,
  getRecord             as getCms2024Record,
  createRecord          as createCms2024Record,
  updateRecord          as updateCms2024Record,
  deleteRecord          as deleteCms2024Record,
  upsertRecord          as upsertCms2024Record,
  searchRecords         as searchCms2024Records,
  runScriptOnRecord     as runCms2024Script,
  reloadLayoutFields    as reloadCms2024LayoutFields,
  getLayoutFieldMeta    as getCms2024LayoutFieldMeta,
  mapCms2024Record,
  _config               as cms2024Config,
} from '../lib/fm-cms2024.js'
import { wavBufferToMp3, ensureFfmpeg } from '../lib/audio-convert.js'
import { languageNameToCode } from '../lib/language-codes.js'
import { generateDDEX382 } from '../lib/ddex-generate.js'
import { buildDdexPackage } from '../lib/ddex-build.js'
import AdmZip from 'adm-zip'
import { loadMetadata, lookupByIsrc, lookupByCatalogue, lookupAlbumTracks, lookupByFilename, lookupByBarcodeAndSeq, lookupCataloguesByBarcode, searchMetadata, getStatus, getAllRows, appendRow as appendMetadataRow, mergeFromBuffer as mergeMetadataFromBuffer, extractHeaders as extractMetadataHeaders, mergeWithMapping as mergeMetadataWithMapping } from '../lib/metadata-cache.js'

// Load metadata on startup (non-blocking — portal works even if file is missing)
loadMetadata()

const router = Router()

// FM string fields like Composers / Producers expect a single string value.
// Mappers from different DBs return different shapes (Gallo & CMS 2024 give
// arrays; getGalloTrack gives a string). _flatten coerces either into a
// semicolon-joined string for FM writes — null when the input is empty.
function _flatten(v) {
  if (v == null) return null
  if (Array.isArray(v)) {
    const s = v.filter(Boolean).map(x => String(x).trim()).filter(Boolean).join('; ')
    return s || null
  }
  const s = String(v).trim()
  return s || null
}

// ── CCA business rules ───────────────────────────────────────────────────────
// Catalogue numbers starting "CCA_" belong to Content Connect Africa.
//  • Label is always the constant "Content Connect Africa" (the spreadsheet
//    label, e.g. "Bird Box Entertainment", appears only in the ℗/© lines).
//  • When the spreadsheet ℗/© line is empty, default it to:
//      "℗ <current year> <spreadsheet label> under exclusive license to CCA"
//      "© <current year> <spreadsheet label> under exclusive license to CCA"
function isCcaCatalogue(cat) {
  return /^CCA_/i.test(String(cat || '').trim())
}

// FM rejects the ENTIRE update if even one field name is unknown on the
// layout, and updateGalloRecord is deliberately unfiltered. So before the
// enrich loops we introspect the layout once and resolve which name variant
// the ℗/© line fields actually use ('pLine' vs 'PLine' etc.) — null means
// the layout has no such field, and we skip writing it rather than 102 the
// whole record. Falls back to the historical names if introspection fails.
const _DEFAULT_LINE_FIELDS = { pName: 'pLine', cName: 'cLine', labelOk: true, parentalName: 'Lyrical Content rating' }
async function resolveGalloLineFields() {
  try {
    // Re-introspect on every enrich run — the layout may have just been
    // changed in FileMaker and the in-process cache would otherwise be stale.
    reloadGalloLayoutFields()
    const known = await getGalloLayoutFieldSet()
    const pick = (...cands) => cands.find(n => known.has(n)) || null
    const lf = {
      pName:   pick('pLine', 'PLine', 'P Line', 'pline'),
      cName:   pick('cLine', 'CLine', 'C Line', 'cline'),
      labelOk: known.has('Label'),
      // The spreadsheet "Parental" value lives in FM as "Lyrical Content rating"
      parentalName: pick('Lyrical Content rating', 'Lyrical Content Rating', 'Parental'),
    }
    console.log(`[Enrich] Gallo layout line fields: pLine→${lf.pName || '(absent — will skip)'}, cLine→${lf.cName || '(absent — will skip)'}, Label ${lf.labelOk ? 'present' : 'ABSENT — will skip'}, parental→${lf.parentalName || '(absent — will skip)'}`)
    return lf
  } catch (e) {
    console.warn(`[Enrich] layout introspection failed (${e.message}) — using default field names`)
    return _DEFAULT_LINE_FIELDS
  }
}

// PATCH wrapper for the enrich routes. On FM error 102 ("Field is missing")
// we refresh the layout metadata, identify exactly which payload keys the
// layout doesn't have, log + surface them, and retry the update without them
// so the remaining fields still land. updateGalloRecord itself stays
// unfiltered by design — this only kicks in after a 102.
async function updateGalloWithDiagnosis(fmRecordId, f) {
  try {
    await updateGalloRecord(fmRecordId, f)
    return { skipped: [] }
  } catch (e) {
    if (!/field is missing/i.test(e.message)) throw e
    reloadGalloLayoutFields()                       // layout may have changed in FM
    const known   = await getGalloLayoutFieldSet()
    const unknown = Object.keys(f).filter(k => !known.has(k))
    if (!unknown.length) throw e                    // 102 but names all valid — rethrow
    const slim = {}
    for (const [k, v] of Object.entries(f)) if (known.has(k)) slim[k] = v
    console.warn(`[Enrich] Layout is missing field(s): ${unknown.join(', ')} — retried without them`)
    await updateGalloRecord(fmRecordId, slim)
    return { skipped: unknown }
  }
}

// Mutates fieldData in place. row needs .label_name / .p_line / .c_line.
function applyCcaRules(f, row, catalogue, lf = _DEFAULT_LINE_FIELDS) {
  if (!isCcaCatalogue(catalogue)) return
  if (lf.labelOk) f['Label'] = 'Content Connect Africa'
  if (row.label_name) {
    const tail = `${new Date().getFullYear()} ${row.label_name} under exclusive license to CCA`
    if (!row.p_line && lf.pName) f[lf.pName] = `℗ ${tail}`
    if (!row.c_line && lf.cName) f[lf.cName] = `© ${tail}`
  }
}

// ── Fuzzy track-title matching ─────────────────────────────────────────────
// Used to align Gallo_Metadata_Extract.xlsx rows with FM records on the
// DB-sync matrix when ISRC is missing on one side: normalize titles to
// alphanumerics-only, lowercase, compute Levenshtein distance, return a
// 0…1 similarity score.

function _levenshtein(a, b) {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i-1] === b[j-1] ? prev[j-1] : 1 + Math.min(prev[j], curr[j-1], prev[j-1])
    }
    prev = curr
  }
  return prev[b.length]
}
function _normTitle(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }
function _fuzzyScore(a, b) {
  const A = _normTitle(a), B = _normTitle(b)
  const max = Math.max(A.length, B.length)
  return max ? 1 - _levenshtein(A, B) / max : 1
}
// Threshold used by the DB-sync matrix when matching a metadata-cache row to
// an FM track by sequence_no + title similarity. 0.7 means "at least 70% of
// characters line up" — empirically catches typo / casing / punctuation drift
// without producing false positives.
const _FUZZY_TITLE_THRESHOLD = 0.7

// ── CMS 2024 → Gallo / Streamer payload builders ───────────────────────────
// Multiple endpoints (pull-catalogue-to-gallo, ensure-catalogue-replicated,
// push-catalogue-to-streamer) build the same per-track and album-level
// payloads from CMS 2024 records. These helpers consolidate the field maps
// so a schema change has exactly one place to update.

/**
 * Translate a CMS 2024 mapped track into the metadata shape `createGalloRecord`
 * expects. Used by both the per-catalogue pull and the ensure-replicated wrapper.
 *
 * @param {object} c            — output of mapCms2024Record
 * @param {string} catalogueNo  — explicit catalogue (defaults to c.catalogue_no)
 */
function _galloMetadataFromCms(c, catalogueNo) {
  return {
    title:                 c.title,
    artist:                c.artist_name,
    album_artist:          c.album_artist,
    featured_artist:       c.featured_artist,
    album:                 c.album_title,
    album_description:     c.album_description,
    catalogue_no:          catalogueNo || c.catalogue_no,
    isrc:                  c.isrc,
    iswc:                  c.iswc,
    barcode:               c.barcode,
    sequence_no:           c.sequence_no,
    year:                  c.year,
    release_date:          c.release_date,
    original_release_date: c.original_release_date,
    genre:                 c.genre,
    local_genre:           c.local_genre,
    sub_genre:             c.sub_genre,
    language:              c.language,
    country:               c.country,
    rights_territories:    c.rights_territories,
    duration:              _durationForFm(c.duration_sec ?? c.duration),
    composers:             _flatten(c.composers),
    producers:             _flatten(c.producers),
    publishers:            _flatten(c.publishers),
    label:                 c.label,
    p_line:                c.p_line,
    c_line:                c.c_line,
    filename:              c.filename || c.wav_filename,
    wav_filename:          c.wav_filename,
    asset_number:          c.asset_number,
    audio_hash_md5:        c.audio_hash_md5,
    technical_resource:    c.technical_resource,
    resource_reference:    c.resource_reference,
    sound_recording_id:    c.sound_recording_id,
    parental:              c.parental,
  }
}

/**
 * Album-level metadata pulled from the first CMS 2024 track. Used for Gallo's
 * `createTapeFileRecord` (which then cascades these values onto Song records
 * via the FM Tape-Files → Songs relationship).
 */
function _galloTapeMetadataFromCms(first, catalogueNo) {
  return {
    album_artist:          first.album_artist || first.artist_name,
    album:                 first.album_title,
    album_description:     first.album_description,
    catalogue_no:          catalogueNo,
    barcode:               first.barcode,
    year:                  first.year,
    release_date:          first.release_date,
    original_release_date: first.original_release_date,
    genre:                 first.genre,
    local_genre:           first.local_genre,
    sub_genre:             first.sub_genre,
    language:              first.language,
    country:               first.country,
    rights_territories:    first.rights_territories,
    label:                 first.label,
    p_line:                first.p_line,
    c_line:                first.c_line,
    publishers:            _flatten(first.publishers),
  }
}

/**
 * Translate a CMS 2024 mapped track into the metadata shape `upsertMp3Record`
 * expects for MadStreamer's API_Album_Songs layout.
 */
function _streamerMetadataFromCms(c, catalogueNo) {
  const gcat = c.filename ? String(c.filename).replace(/\.[^.]+$/, '') : null
  return {
    filename:        gcat || undefined,
    title:           c.title,
    artist:          c.artist_name,
    album_artist:    c.album_artist,
    album:           c.album_title,
    catalogue_no:    catalogueNo || c.catalogue_no,
    isrc:            c.isrc,
    barcode:         c.barcode,
    sequence_no:     c.sequence_no,
    year:            c.year,
    release_date:    c.release_date,
    genre:           c.genre,
    language:        c.language,
    duration:        _durationForFm(c.duration_sec ?? c.duration),
    composers:       _flatten(c.composers),
    producers:       _flatten(c.producers),
    audio_url:       c.audio_url,
  }
}

/**
 * Album-level metadata for MadStreamer's Tape Files Master layout.
 */
function _streamerTapeMetadataFromCms(first, catalogueNo) {
  return {
    album_artist:  first.album_artist || first.artist_name,
    album:         first.album_title,
    catalogue_no:  catalogueNo,
    barcode:       first.barcode,
    year:          first.year,
    release_date:  first.release_date,
    genre:         first.genre,
  }
}

// Gallo's API_Album_Songs Duration is a TIME field with validation. FM rejects
// ISO 8601 ("PT4M10S") and bare seconds ("270"). _durationForFm coerces every
// known input shape — number of seconds, ISO 8601, MM:SS, HH:MM:SS — into a
// safe "HH:MM:SS" string. Returns null for empty input so the caller can skip
// the field entirely.
function _durationForFm(v) {
  if (v == null || v === '') return null
  let sec = null
  if (typeof v === 'number' && !isNaN(v)) {
    sec = Math.round(v)
  } else {
    const s = String(v).trim()
    if (/^\d+(\.\d+)?$/.test(s)) {
      sec = Math.round(parseFloat(s))
    } else {
      const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
      if (iso) {
        sec = Math.round((+iso[1]||0)*3600 + (+iso[2]||0)*60 + (+iso[3]||0))
      } else {
        const parts = s.split(':').map(p => parseFloat(p))
        if (parts.every(n => !isNaN(n))) {
          if (parts.length === 3) sec = Math.round(parts[0]*3600 + parts[1]*60 + parts[2])
          else if (parts.length === 2) sec = Math.round(parts[0]*60 + parts[1])
        }
      }
    }
  }
  if (sec == null) return null
  const h  = Math.floor(sec / 3600); sec %= 3600
  const m  = Math.floor(sec / 60);   sec %= 60
  const pad = n => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

// ── Catalog live search — queries FileMaker directly ─────────────────────────
router.get('/catalog/search', adminAuth, async (req, res) => {
  const { q } = req.query
  const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0)
  if (!q || q.trim().length < 2) return res.json({ tracks: [], count: 0, foundCount: 0 })
  try {
    const { tracks, foundCount } = await searchGalloRecords(q.trim(), limit, offset)
    tracks.sort((a, b) => {
      const albumA = (a.album_title || '').toLowerCase()
      const albumB = (b.album_title || '').toLowerCase()
      if (albumA < albumB) return -1
      if (albumA > albumB) return  1
      return (a.sequence_no ?? Infinity) - (b.sequence_no ?? Infinity)
    })
    res.json({ tracks, count: tracks.length, foundCount, limit, offset })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// ── Cross-database search — queries every source in parallel ─────────────────
// Merges results by ISRC (fallback: normalised title+artist) and tags each
// song with the databases it was found in.
router.get('/catalog/search-all', adminAuth, async (req, res) => {
  const { q } = req.query
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
  if (!q || q.trim().length < 2) return res.json({ songs: [], count: 0, sources: {} })

  const term = q.trim()
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

  const SOURCES = [
    { key: 'gallo',       label: 'Gallo Catalogue',
      run: () => searchGalloRecords(term, limit) },
    { key: 'cms2024',     label: 'CMS 2024',
      run: () => searchCms2024Records(term, { limit }) },
    { key: 'madstreamer', label: 'MadStreamer',
      run: () => searchMadStreamerRecords(term, { limit }) },
    { key: 'metadata',    label: 'Metadata Extract',
      run: async () => {
        const rows = searchMetadata(term, limit)
        return {
          foundCount: rows.length,
          tracks: rows.map(r => ({
            title:        r.track_name,
            artist_name:  r.track_artist || r.album_artist,
            album_title:  r.album_title,
            catalogue_no: r.catalogue,
            isrc:         r.isrc,
            sequence_no:  r.seq,
          })),
        }
      } },
  ]

  const settled = await Promise.allSettled(SOURCES.map(s => s.run()))

  const merged  = new Map()   // mergeKey → song
  const sources = {}          // per-source result/error summary

  SOURCES.forEach((src, i) => {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      console.warn(`[Search-all] ${src.label} failed:`, outcome.reason?.message)
      sources[src.key] = { label: src.label, ok: false, error: outcome.reason?.message || 'failed' }
      return
    }
    const { tracks = [], foundCount = 0 } = outcome.value || {}
    sources[src.key] = { label: src.label, ok: true, foundCount, returned: tracks.length }

    for (const t of tracks) {
      const isrc = (t.isrc || '').trim().toUpperCase()
      const key  = isrc || `t:${norm(t.title)}|a:${norm(t.artist_name)}`
      if (!merged.has(key)) {
        merged.set(key, {
          title:        t.title        || null,
          artist:       t.artist_name  || null,
          album:        t.album_title  || null,
          catalogue_no: t.catalogue_no || null,
          isrc:         isrc || null,
          sequence_no:  t.sequence_no ?? null,
          sources:      [],
        })
      }
      const song = merged.get(key)
      if (!song.sources.some(s => s.db === src.label)) {
        song.sources.push({ db: src.label, key: src.key, fm_record_id: t.fm_record_id || null })
      }
      // Backfill blanks from whichever source has the value
      song.title        ||= t.title        || null
      song.artist       ||= t.artist_name  || null
      song.album        ||= t.album_title  || null
      song.catalogue_no ||= t.catalogue_no || null
    }
  })

  const songs = [...merged.values()].sort((a, b) =>
    (b.sources.length - a.sources.length) ||
    String(a.artist || '').localeCompare(String(b.artist || '')) ||
    String(a.title  || '').localeCompare(String(b.title  || ''))
  )

  res.json({ songs, count: songs.length, sources })
})

// ── FM serial queue — prevents Thrift pool exhaustion ────────────────────────
let _fmBusy = false
const _fmQueue = []

function enqueueFm(fn) {
  return new Promise((resolve, reject) => {
    _fmQueue.push({ fn, resolve, reject })
    _drainFmQueue()
  })
}

async function _drainFmQueue() {
  if (_fmBusy || _fmQueue.length === 0) return
  _fmBusy = true
  const { fn, resolve, reject } = _fmQueue.shift()
  try {
    resolve(await fn())
  } catch (e) {
    reject(e)
  } finally {
    _fmBusy = false
    _drainFmQueue()
  }
}

// ── Multer ────────────────────────────────────────────────────────────────────
const UPLOAD_TMP = process.env.UPLOAD_TMP_DIR || './tmp/uploads'
mkdirSync(UPLOAD_TMP, { recursive: true })

const storage = multer.diskStorage({
  destination: UPLOAD_TMP,
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9. _-]/g, '_')
    cb(null, safe)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (file.fieldname === 'artwork') {
      const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype)
             || ['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)
      return cb(ok ? null : new Error(`Artwork must be an image, got: ${file.mimetype}`), ok)
    }
    const allowedExts  = ['.wav', '.mp3', '.flac', '.aif', '.aiff']
    const allowedMimes = ['audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/flac','audio/aiff','audio/x-aiff']
    const ok = allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)
    cb(ok ? null : new Error(`File type not accepted: ${file.mimetype}`), ok)
  }
})

const uploadZip = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ext === '.zip') cb(null, true)
    else cb(new Error(`Expected ZIP, got: ${file.mimetype}`))
  }
})

const uploadSheet = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true)
    else cb(new Error(`Expected spreadsheet, got: ${file.mimetype}`))
  }
})

// ── Invite gate (internal tool — always open) ─────────────────────────────────
router.get('/invite-required', (req, res) => res.json({ required: false }))

// ── Health / FM ping ──────────────────────────────────────────────────────────
router.get('/ping', adminAuth, async (req, res) => {
  const fm = await pingGallo()
  res.json({ ok: true, fm_connected: fm })
})

// ── Client config — exposes non-secret settings the UI needs ─────────────────
router.get('/config', (req, res) => {
  res.json({
    fm_asset_base: (process.env.FM_SERVER_ASSET_PATH || '').trim(),
    fm_wav_subpath: (process.env.FM_WAV_SUBPATH || '').trim()
  })
})

// ── Meta preview (no auth — called on file drop) ──────────────────────────────
router.post('/meta-preview',
  upload.fields([{ name: 'audio', maxCount: 1 }]),
  async (req, res) => {
    const file = req.files?.audio?.[0]
    if (!file) return res.status(400).json({ error: 'No audio file' })
    try {
      const buffer   = await readFile(file.path)
      const format   = detectAudioFormat(buffer)
      const accepted = ['wav', 'flac'].includes(format)
      const { meta, technical, errors } = await extractAudioMeta(buffer, file.mimetype)
      const warnings = generateWarnings(technical, format)
      await unlink(file.path).catch(() => {})
      res.json({ format, accepted, meta, technical, warnings, errors })
    } catch(err) {
      await unlink(file.path).catch(() => {})
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Presign — browser uploads directly to S3 ─────────────────────────────────
router.get('/presign', async (req, res) => {
  try {
    const { filename, content_type, artist, album, title } = req.query
    if (!filename) return res.status(400).json({ error: 'filename required' })
    const result = await presignImport(filename, content_type || 'audio/wav', { artist, album, title })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/presign-artwork', async (req, res) => {
  try {
    const { filename, content_type, artist, album, catalogue_no } = req.query
    if (!filename) return res.status(400).json({ error: 'filename required' })
    const result = await presignArtworkImport(filename, content_type || 'image/jpeg', { artist, album, catalogue_no })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Register — create FM record after browser has uploaded to S3 ──────────────
router.post('/register', express.json(), async (req, res) => {
  const body = req.body
  const metadata = {
    title:           body.title,
    artist:          body.artist,
    album_artist:    body.album_artist || body.artist || null,
    album:           body.album,
    year:            body.year,
    release_date:          body.release_date || null,
    original_release_date: body.original_release_date || null,
    parental:              body.parental || null,
    rights_territories:    body.rights_territories || null,
    genre:           body.genre,
    isrc:            body.isrc,
    barcode:         body.barcode,
    catalogue_no:    body.catalogue_no,
    sequence_no:     body.sequence_no ? parseInt(body.sequence_no, 10) : null,
    language:        body.language || 'en',
    bpm:             body.bpm,
    explicit:        body.explicit === true || body.explicit === 'true',
    notes:           body.notes,
    submitter_name:  body.submitter_name,
    submitter_email: body.submitter_email,
    org:             body.org,
    duration:        body.duration,
    format:          body.format,
    format_flag:     body.format && !['wav','flac'].includes(body.format) ? body.format : null,
    s3_key:          body.key,
    s3_url:          body.url,
    filename:        body.key ? body.key.split('/').pop() : null,
    artwork_url:     body.artwork_url,
    fm_path:         body.fm_path || null
  }

  // Respond immediately — FM record creation runs in the background
  res.json({ ok: true, s3_key: body.key, s3_url: body.url,
             format: metadata.format, format_flag: metadata.format_flag })

  console.log('[Register] metadata →', JSON.stringify({
    title: metadata.title, artist: metadata.artist, album_artist: metadata.album_artist,
    album: metadata.album, isrc: metadata.isrc, catalogue_no: metadata.catalogue_no,
    year: metadata.year, create_tape_record: body.create_tape_record
  }))
  console.log('[Register] extended fields →', JSON.stringify({
    language: metadata.language,
    original_release_date: metadata.original_release_date,
    parental: metadata.parental,
    rights_territories: metadata.rights_territories
  }))
  console.log('[Register] fm_path →', body.fm_path || '(none — Pending Audio Path will be blank)')
  console.log('[Register] pending audio path →', metadata.fm_path || '(none)')

  enqueueFm(() => createGalloRecord(metadata))
    .then(fm => {
      console.log('[FM] Gallo Catalogue record created:', fm.fmRecordId)
      if (body.create_tape_record !== false) {
        enqueueFm(() => createTapeFileRecord(metadata))
          .then(t => console.log('[FM] Tape Files Master record created:', t.tapeRecordId))
          .catch(e => console.warn('[FM] Tape Files Master create failed:', e.message))
      }
    })
    .catch(e => console.warn('[FM] Gallo Catalogue create failed:', e.message))
})

// ── Submit single track ───────────────────────────────────────────────────────
router.post('/submit',
  upload.fields([
    { name: 'audio',   maxCount: 1 },
    { name: 'artwork', maxCount: 1 }
  ]),
  async (req, res) => {
    const audioFile   = req.files?.audio?.[0]
    const artworkFile = req.files?.artwork?.[0]
    if (!audioFile) return res.status(400).json({ error: 'Audio file required' })

    try {
      const buffer = await readFile(audioFile.path)
      const format = detectAudioFormat(buffer)
      const { meta: fileMeta, technical } = await extractAudioMeta(buffer, audioFile.mimetype)
      const body   = req.body

      // Merge form fields with embedded metadata (form takes priority)
      const metadata = {
        title:           body.title    || fileMeta.title  || titleFromFilename(audioFile.originalname),
        artist:          body.artist   || fileMeta.artist || 'Unknown Artist',
        album:           body.album    || fileMeta.album  || null,
        year:            body.year     || fileMeta.year   || null,
        genre:           body.genre    || fileMeta.genre  || null,
        isrc:            body.isrc     || fileMeta.isrc   || null,
        barcode:         body.barcode      || null,
        catalogue_no:    body.catalogue_no || null,
        language:        body.language || fileMeta.language || 'en',
        bpm:             body.bpm      || fileMeta.bpm    || null,
        explicit:        body.explicit === 'true',
        notes:           body.notes    || null,
        submitter_name:  body.submitter_name  || null,
        submitter_email: body.submitter_email || null,
        org:             body.org      || null,
        duration:        technical?.duration_sec || null,
        format,
        format_flag:     !['wav','flac'].includes(format) ? format : null
      }

      // Upload audio to S3 AudioImports/
      const { key, url } = await uploadImport(buffer, audioFile.originalname, audioFile.mimetype, { artist: metadata.artist, album: metadata.album, title: metadata.title })
      metadata.s3_key = key
      metadata.s3_url = url

      // Upload artwork if provided
      let artworkUrl = null
      if (artworkFile) {
        try {
          const artBuf = await readFile(artworkFile.path)
          const art    = await uploadArtworkImport(artBuf, artworkFile.originalname, { artist: metadata.artist, album: metadata.album, catalogue_no: metadata.catalogue_no })
          artworkUrl   = art.url
          metadata.artwork_url = artworkUrl
        } catch(artErr) {
          console.warn('[Ingest] Artwork upload failed:', artErr.message)
        }
        await unlink(artworkFile.path).catch(() => {})
      }

      // Create FileMaker record in Gallo Catalogue
      let fmRecordId = null
      try {
        const fm = await createGalloRecord(metadata)
        fmRecordId = fm.fmRecordId
        console.log('[FM] Gallo Catalogue record created:', fmRecordId)
      } catch(fmErr) {
        console.warn('[FM] Gallo Catalogue create failed:', fmErr.message)
      }

      await unlink(audioFile.path).catch(() => {})

      // Send response immediately — post-submit FM tasks run after
      res.json({
        ok:           true,
        s3_url:       url,
        s3_key:       key,
        fm_record_id: fmRecordId,
        format,
        format_flag:  metadata.format_flag
      })

      // Tape Files Master disabled — revisit later

    } catch(err) {
      await unlink(audioFile?.path).catch(() => {})
      await unlink(artworkFile?.path).catch(() => {})
      console.error('[Ingest] Submit error:', err.message)
      res.status(500).json({ error: err.message })
    }
  }
)

// ── DDEX export — generate + ZIP ─────────────────────────────────────────────
router.post('/ddex/export', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, recipient, source } = req.body
  if (!catalogue_no) return res.status(400).json({ error: 'catalogue_no required' })

  // 1. Pull all tracks for this album from the chosen source DB.
  //    Default = Gallo Catalogue (canonical). source='cms2024' reads from
  //    the Gallo CMS 2024 Song Files layout instead, then hydrates audio +
  //    artwork file references from Gallo (filenames are identical across DBs).
  const src = (source || 'gallo').toLowerCase()
  const isCmsSource = src === 'cms2024' || src === 'cms-2024' || src === '2024'
  let tracks
  try {
    tracks = isCmsSource
      ? await findCms2024RecordsByCatalogue(catalogue_no)
      : await findGalloRecordsByCatalogue(catalogue_no)
  } catch (e) {
    throw Object.assign(new Error(`FM query failed (${src}): ${e.message}`), { status: 502 })
  }
  if (!tracks.length) return res.status(404).json({ error: `No tracks found in ${isCmsSource ? 'CMS 2024' : 'Gallo Catalogue'} for catalogue number "${catalogue_no}"` })

  if (isCmsSource) tracks = await _hydrateFromGallo(tracks, catalogue_no)

  const sorted = [...tracks].sort((a, b) => (a.sequence_no || 999) - (b.sequence_no || 999))

  // 2. Derive album-level metadata from first track
  const firstTrack = sorted[0]
  const s3Base = (process.env.S3_IMPORTS_BASE_URL || '').replace(/\/$/, '')

  function urlToKey(url) {
    if (!url || !s3Base) return null
    return url.startsWith(s3Base) ? url.slice(s3Base.length + 1) : null
  }

  // 3. Download audio files from S3
  const zip = new AdmZip()
  const tracksWithFilenames = []

  for (const t of sorted) {
    let audioFilename = null
    const s3Key = urlToKey(t.s3_url)
    if (s3Key) {
      try {
        const buf = await downloadImport(s3Key)
        const ext = s3Key.split('.').pop() || 'wav'
        audioFilename = `${t.isrc || ('track_' + (t.sequence_no || sorted.indexOf(t)+1))}.${ext}`
        zip.addFile(`resources/${audioFilename}`, buf)
        console.log(`[DDEX Export] Added audio: ${audioFilename}`)
      } catch(e) {
        console.warn(`[DDEX Export] Could not fetch audio for ${t.title}: ${e.message}`)
      }
    }
    tracksWithFilenames.push({ ...t, audio_filename: audioFilename })
  }

  // 4. Download artwork
  let artworkFilename = null
  const artworkUrl = sorted.find(t => t.artwork_url)?.artwork_url
  const artworkKey = urlToKey(artworkUrl)
  if (artworkKey) {
    try {
      const artBuf = await downloadImport(artworkKey)
      const ext = artworkKey.split('.').pop() || 'jpg'
      artworkFilename = `artwork.${ext}`
      zip.addFile(`resources/${artworkFilename}`, artBuf)
      console.log(`[DDEX Export] Added artwork: ${artworkFilename}`)
    } catch(e) {
      console.warn(`[DDEX Export] Could not fetch artwork: ${e.message}`)
    }
  }

  // 5. Generate DDEX XML
  const album = {
    title:            firstTrack.album_title || catalogue_no,
    artist:           firstTrack.artist_name || '',
    catalogue_no:     firstTrack.catalogue_no || catalogue_no,
    barcode:          firstTrack.barcode || '',
    year:             firstTrack.year || '',
    genre:            firstTrack.genre || '',
    artwork_filename: artworkFilename,
  }
  const xml = generateDDEX382(tracksWithFilenames, album, recipient || {})
  const safeTitle = (album.title || catalogue_no).replace(/[^a-zA-Z0-9_\-. ]/g, '_')
  zip.addFile(`${safeTitle}_NewReleaseMessage.xml`, Buffer.from(xml, 'utf8'))

  // 6. Stream ZIP back
  const zipBuf = zip.toBuffer()
  res.set({
    'Content-Type':        'application/zip',
    'Content-Disposition': `attachment; filename="${safeTitle}_DDEX.zip"`,
    'Content-Length':      zipBuf.length
  })
  res.send(zipBuf)
})

// ── Ingrooves DDEX folder build ──────────────────────────────────────────────
// Pulls FM data, fetches audio + artwork from S3, runs validation, writes a
// folder layout (no zip): <UPC>/<UPC>.xml + <UPC>/resources/{*.wav, *.jpg}.
// Output dir is configurable via DDEX_OUTPUT_DIR (default ~/Desktop/Ingrooves_DDEX).
/**
 * Boilerplate for any GET endpoint that wants to stream progress via
 * Server-Sent Events. Handles auth (token query param), SSE headers,
 * heartbeat, log/warn helpers, and emitting `done` / `error` from the
 * caller's async runner.
 *
 * Usage:
 *   router.get('/some-endpoint-stream', (req, res) =>
 *     _sseStreamRunner({ req, res, runner: async ({ log, warn }) => {
 *       log('starting…')
 *       return await doTheWork({ log, warn })
 *     } })
 *   )
 */
function _sseStreamRunner({ req, res, runner }) {
  const token = (req.query.token || req.headers.authorization?.replace('Bearer ', '') || '').trim()
  if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
    return res.status(401).end('Unauthorized')
  }

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  function emit(event, data) {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (typeof res.flush === 'function') res.flush()
  }
  const ts   = () => new Date().toISOString().slice(11, 19)
  const log  = (msg) => { const l = `[${ts()}] ${msg}`;   console.log(l);  emit('log', { msg: l, level: 'info' }) }
  const warn = (msg) => { const l = `[${ts()}] ⚠ ${msg}`; console.warn(l); emit('log', { msg: l, level: 'warn' }) }

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
  req.on('close', () => clearInterval(heartbeat))

  Promise.resolve()
    .then(() => runner({ log, warn }))
    .then(result => emit('done', result))
    .catch(err => emit('error', {
      message: err.message || String(err),
      status:  err.status || 500,
      ...(err.payload || {}),
    }))
    .finally(() => { clearInterval(heartbeat); res.end() })
}

/**
 * Core DDEX build, shared by both the JSON (`POST /ddex/build`) and the
 * Server-Sent Events streaming endpoint (`GET /ddex/build-stream`).
 *
 * The caller supplies `log` and `warn` callbacks — for the JSON endpoint they
 * push lines into an array that's returned in the response; for SSE they
 * write each line down the wire as it happens. Errors are thrown with a
 * `.status` property and (where relevant) `.payload` so the caller can shape
 * the appropriate response.
 */
async function _runDdexBuild({ catalogue_no, source, overrides, output_dir, log, warn }) {
  const src = (source || 'gallo').toLowerCase()
  const isCmsSource = src === 'cms2024' || src === 'cms-2024' || src === '2024'

  log(`Starting build for ${catalogue_no} (source: ${src})`)

  // 1. Pull tracks from the chosen source DB. CMS 2024 uses the same flat
  //    track shape (via mapCms2024Record) so the rest of the build pipeline
  //    treats both sources identically. When source=cms2024 we then hydrate
  //    audio/artwork file references from Gallo Catalogue, since the files
  //    themselves live on Gallo and filenames are identical across DBs.
  let tracks
  try {
    tracks = isCmsSource
      ? await findCms2024RecordsByCatalogue(catalogue_no)
      : await findGalloRecordsByCatalogue(catalogue_no)
  } catch (e) {
    throw Object.assign(new Error(`FM query failed (${src}): ${e.message}`), { status: 502 })
  }
  if (!tracks.length) {
    throw Object.assign(new Error(`No tracks for catalogue "${catalogue_no}" (source: ${src})`), { status: 404 })
  }

  log(`Pulled ${tracks.length} tracks from ${isCmsSource ? 'CMS 2024' : 'Gallo Catalogue'}`)
  if (isCmsSource) {
    tracks = await _hydrateFromGallo(tracks, catalogue_no)
    log(`Hydrated audio/artwork refs from Gallo Catalogue`)

    // CMS 2024 artwork lives on a separate "Artwork" layout (not on Song
    // Files records). If none of the Song Files / Gallo records came back
    // with artwork, query that layout directly by catalogue number.
    const haveArtwork = tracks.some(t => t.artwork_container_url || t.artwork_url)
    if (!haveArtwork) {
      try {
        const art = await findCms2024ArtworkByCatalogue(catalogue_no)
        if (art && (art.container || art.s3_url)) {
          const via = art.container ? `container "${art.container_field}"` : `S3 URL`
          log(`Artwork found on CMS 2024 Artwork layout via ${via} — GMVi ${art.resource_reference || '(none)'}`)
          for (const t of tracks) {
            t.artwork_container_url ||= art.container || null
            t.artwork_url           ||= art.s3_url    || null
            if (!t.image_asset_number && art.resource_reference) t.image_asset_number = art.resource_reference
          }
        } else {
          warn(`No artwork record on CMS 2024 Artwork layout for catalogue ${catalogue_no}`)
        }
      } catch (e) {
        warn(`Artwork layout lookup failed: ${e.message}`)
      }
    }
  }

  const sorted = [...tracks].sort((a, b) => (a.sequence_no || 999) - (b.sequence_no || 999))

  // 2. Fetch audio — prefer FM container (Audio File), fall back to S3 if present
  const s3Base = (process.env.S3_IMPORTS_BASE_URL || '').replace(/\/$/, '')
  const urlToKey = url => (url && s3Base && url.startsWith(s3Base)) ? url.slice(s3Base.length + 1) : null

  const audioBufs = []
  const fetchErrors = []
  for (const t of sorted) {
    let buf = null
    let source = null
    if (t.audio_container_url) {
      // FileMaker "store by reference" containers look like:
      //   movie:filename.wav\rmoviemac:/Macintosh HD/full/path/to/file.wav
      // These are local file paths (often on a Mountain Duck mount), not HTTP URLs.
      if (t.audio_container_url.startsWith('movie:')) {
        const parts = t.audio_container_url.split('\r')
        const moviemacPart = parts.find(p => p.startsWith('moviemac:'))
        if (moviemacPart) {
          let filePath = moviemacPart.replace('moviemac:', '').replace(/^\/Macintosh HD/, '')
          try {
            buf = await readFile(filePath)
            source = 'local file (FM store-by-reference)'
          } catch (e) {
            fetchErrors.push(`${t.title}: local file read failed (${filePath}): ${e.message}`)
          }
        } else {
          fetchErrors.push(`${t.title}: movie: container has no moviemac: path`)
        }
      } else {
        try {
          buf = await fetchContainerData(t.audio_container_url)
          source = 'FM container'
        } catch (e) {
          fetchErrors.push(`${t.title}: FM container fetch failed: ${e.message}`)
        }
      }
    }
    if (!buf) {
      const key = urlToKey(t.s3_url)
      if (key) {
        try {
          buf = await downloadImport(key)
          source = 'S3'
        } catch (e) {
          fetchErrors.push(`${t.title}: S3 fallback failed: ${e.message}`)
        }
      }
    }
    if (!buf) {
      if (!t.audio_container_url && !t.s3_url) {
        fetchErrors.push(`${t.title}: no audio source on FM record (neither Audio File container nor File URL)`)
      }
      audioBufs.push(Buffer.alloc(0))
    } else {
      log(`Audio ${t.sequence_no ?? '?'} "${t.title}" — ${(buf.length / 1024 / 1024).toFixed(2)} MB via ${source}`)
      audioBufs.push(buf)
    }
  }

  // 3. Fetch artwork — prefer artwork::picture container, fall back to artwork URL
  let artworkBuf = Buffer.alloc(0)
  let artworkExt = 'jpg'
  let derivedImageAsset = null  // GMVi number inferred from artwork source
  const artContainer = sorted.find(t => t.artwork_container_url)?.artwork_container_url
  const artUrl       = sorted.find(t => t.artwork_url)?.artwork_url

  // A valid Gallo asset reference looks like GMVi6506, GCAT00123, etc. — short, alphanumeric.
  // Reject anything that looks like a content-hash (hex string ≥ 20 chars).
  const looksLikeAssetRef = s => s && s.length < 20 && /^[A-Za-z]{1,6}\d+$/.test(s)

  if (artContainer) {
    try {
      artworkBuf = await fetchContainerData(artContainer)
      const containerFilename = artContainer.split('/').pop().split('?')[0].replace(/\.[^.]+$/, '')
      if (looksLikeAssetRef(containerFilename)) derivedImageAsset = containerFilename
      log(`Artwork — ${(artworkBuf.length / 1024).toFixed(0)} KB via FM container${derivedImageAsset ? ` (${derivedImageAsset})` : ''}`)
    } catch (e) {
      fetchErrors.push(`artwork: FM container fetch failed: ${e.message}`)
    }
  }
  if (artworkBuf.length === 0 && artUrl) {
    const artKey = urlToKey(artUrl)
    if (artKey) {
      try {
        artworkBuf = await downloadImport(artKey)
        artworkExt = (artKey.split('.').pop() || 'jpg').toLowerCase()
        const keyFilename = artKey.split('/').pop().replace(/\.[^.]+$/, '')
        if (looksLikeAssetRef(keyFilename)) derivedImageAsset = keyFilename
        log(`Artwork — ${(artworkBuf.length / 1024).toFixed(0)} KB via S3${derivedImageAsset ? ` (${derivedImageAsset})` : ''}`)
      } catch (e) {
        fetchErrors.push(`artwork: S3 fallback failed: ${e.message}`)
      }
    }
  }
  if (artworkBuf.length === 0 && !artContainer && !artUrl) {
    fetchErrors.push('No artwork on any track (neither artwork::picture container nor Artwork URL)')
  }

  // Backfill image_asset_number on all tracks if FM didn't supply it
  if (derivedImageAsset) {
    for (const t of sorted) {
      if (!t.image_asset_number) t.image_asset_number = derivedImageAsset
    }
  }

  if (fetchErrors.length) {
    fetchErrors.forEach(e => warn(e))
    throw Object.assign(new Error('Failed to fetch one or more assets from S3'), {
      status:  424,
      payload: { details: fetchErrors },
    })
  }

  // 4. Build the package (validation runs inside; throws on hard errors)
  let pkg
  try {
    log('Building DDEX package + running validation…')
    pkg = buildDdexPackage({ tracks: sorted, audioBufs, artworkBuf, artworkExt, overrides: overrides || {} })
    log(`Package built — ${pkg.files.length} resource files`)
    if (pkg.validation?.warnings?.length) {
      pkg.validation.warnings.forEach(w => warn(w))
    }
  } catch (e) {
    throw Object.assign(new Error(e.message), {
      status:  422,
      payload: { validation: e.validation || null },
    })
  }

  // 5. Write folder to disk. safePart preserves spaces and most readable
  // punctuation; only strips characters that actually cause cross-platform
  // filesystem trouble (Windows-illegal + control chars). Result reads
  // naturally — e.g. "Spiroman - Tsa Tsawane" instead of "Spiroman_Tsa_Tsawane".
  //
  // Output location precedence:
  //   1. caller-supplied output_dir (the admin UI's remembered choice)
  //   2. DDEX_OUTPUT_DIR env var
  //   3. ~/Desktop/Ingrooves_DDEX (default)
  // ~ is expanded to the current user's home so we accept paths like
  // "~/Desktop/My DDEX Output".
  const _resolveOutDir = (p) => {
    if (!p) return null
    const s = String(p).trim()
    if (!s) return null
    if (s === '~' || s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
    return s
  }
  const outRoot = _resolveOutDir(output_dir)
                || _resolveOutDir(process.env.DDEX_OUTPUT_DIR)
                || path.join(os.homedir(), 'Desktop', 'Ingrooves_DDEX')
  log(`Output folder: ${outRoot}`)
  const safePart = (s) => (s || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')   // strip filesystem-illegal + control chars
    .replace(/\s+/g, ' ')                     // collapse runs of whitespace
    .replace(/^[\s.]+|[\s.]+$/g, '')          // trim leading/trailing dots + whitespace
  const folderName = `${safePart(pkg.album.artist)} - ${safePart(pkg.album.title)}`
  const folder = path.join(outRoot, folderName)

  try {
    await rm(folder, { recursive: true, force: true })
    await mkdir(path.join(folder, 'resources'), { recursive: true })
    await mkdir(path.join(outRoot, 'xml'), { recursive: true })

    // XML goes in the shared xml/ folder at the root, named after the album folder
    const xmlPath = path.join(outRoot, 'xml', `${folderName}.xml`)
    await writeFile(xmlPath, pkg.xml, 'utf8')

    // Asset files (resources/)
    for (const f of pkg.files) {
      await writeFile(path.join(folder, f.path), f.buffer)
    }

    log(`Wrote ${pkg.files.length + 1} files to ${folder}`)
    log(`XML: ${xmlPath}`)
    log(`✓ Build complete`)
  } catch (e) {
    throw Object.assign(new Error(`Failed to write folder: ${e.message}`), { status: 500 })
  }

  return {
    ok: true,
    folder,
    folder_name: folderName,
    xml_filename: `xml/${folderName}.xml`,
    files: pkg.files.map(f => f.path),
    track_count: pkg.tracks.length,
    warnings: pkg.validation.warnings,
    album: {
      title:        pkg.album.title,
      artist:       pkg.album.artist,
      barcode:      pkg.album.barcode,
      catalogue_no: pkg.album.catalogue_no,
      release_date: pkg.album.release_date,
    },
  }
}

/**
 * JSON endpoint — runs _runDdexBuild to completion and returns the result
 * with all log lines collected in `logs`. Used by callers that just want
 * the final outcome (e.g. for non-interactive scripts).
 */
router.post('/ddex/build', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, overrides, source, output_dir } = req.body || {}
  if (!catalogue_no) return res.status(400).json({ error: 'catalogue_no required' })

  const buildLog = []
  const ts  = () => new Date().toISOString().slice(11, 19)
  const log  = (msg) => { const l = `[${ts()}] ${msg}`;   console.log(l);  buildLog.push(l) }
  const warn = (msg) => { const l = `[${ts()}] ⚠ ${msg}`; console.warn(l); buildLog.push(l) }

  try {
    const result = await _runDdexBuild({ catalogue_no, overrides, source, output_dir, log, warn })
    res.json({ ...result, logs: buildLog })
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      ...(err.payload || {}),
      logs: buildLog,
    })
  }
})

/**
 * Server-Sent Events endpoint for DDEX build — streams every log line live.
 * Auth via ?token= query param (EventSource can't set custom headers).
 */
router.get('/ddex/build-stream', (req, res) => {
  const catalogue_no = (req.query.catalogue_no || '').toString().trim()
  const source       = (req.query.source       || 'gallo').toString().trim()
  const output_dir   = (req.query.output_dir   || '').toString().trim() || undefined
  let overrides = {}
  if (req.query.overrides) {
    try { overrides = JSON.parse(req.query.overrides) } catch { /* ignore */ }
  }
  if (!catalogue_no) return res.status(400).end('catalogue_no required')

  _sseStreamRunner({ req, res, runner: ({ log, warn }) =>
    _runDdexBuild({ catalogue_no, overrides, source, output_dir, log, warn })
  })
})

// Preview the FM data + computed XML for a catalogue without writing anything.
router.post('/ddex/build-preview', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no } = req.body || {}
  if (!catalogue_no) return res.status(400).json({ error: 'catalogue_no required' })
  const tracks = await findGalloRecordsByCatalogue(catalogue_no)
  if (!tracks.length) return res.status(404).json({ error: 'No tracks found' })
  res.json({ track_count: tracks.length, tracks })
})

// ── DDEX XML-only preview ─────────────────────────────────────────────────────
const uploadXml = multer({ dest: 'tmp/uploads/', limits: { fileSize: 5 * 1024 * 1024 } })

router.post('/ddex/xml-preview', adminAuth, uploadXml.single('xml'), async (req, res) => {
  try {
    const buf    = await readFile(req.file.path)
    // Handle UTF-16 LE/BE BOM — many DDEX files from Windows tools are UTF-16
    let xmlStr
    if (buf[0] === 0xFF && buf[1] === 0xFE) xmlStr = buf.toString('utf16le')
    else if (buf[0] === 0xFE && buf[1] === 0xFF) xmlStr = buf.swap16().toString('utf16le')
    else xmlStr = buf.toString('utf8')
    xmlStr = xmlStr.replace(/^﻿/, '')  // strip BOM
    await unlink(req.file.path).catch(() => {})
    const { version, tracks } = await parseDDEXXml(xmlStr)
    res.json({
      version,
      count: tracks.length,
      tracks: tracks.map(t => ({
        sequence_no:  t.track_number,
        title:        t.track_title,
        artist:       t.artist_name,
        album:        t.album_title,
        isrc:         t.isrc,
        year:         t.year,
        genre:        t.genre,
        language:     t.language,
        duration_sec: t.duration_sec,
        explicit:     t.explicit,
        catalogue_no: t.catalogue_no,
        barcode:      t.barcode,
      }))
    })
  } catch(err) {
    res.status(400).json({ error: err.message })
  }
})

// ── DDEX preview ──────────────────────────────────────────────────────────────
router.post('/ddex/preview', adminAuth, uploadZip.single('package'), async (req, res) => {
  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const { version, tracks } = await parseDDEXPackage(buf)
    res.json({
      version,
      count: tracks.length,
      tracks: tracks.map(t => ({
        title:       t.track_title,
        artist:      t.artist_name,
        isrc:        t.isrc,
        duration_sec: t.duration_sec,
        has_audio:   !!t.wav_buffer
      }))
    })
  } catch(err) {
    res.status(400).json({ error: err.message })
  }
})

// ── DDEX import ───────────────────────────────────────────────────────────────
router.post('/ddex', adminAuth, uploadZip.single('package'), async (req, res) => {
  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const { version, tracks } = await parseDDEXPackage(buf)

    // Respect track selection from the preview step
    let selectedIndices = null
    try { selectedIndices = new Set(JSON.parse(req.body.selectedIndices || 'null')) } catch(_) {}
    const toImport = selectedIndices
      ? tracks.filter((_, i) => selectedIndices.has(i))
      : tracks

    const created = []
    const errors  = []

    for (const track of toImport) {
      let s3_url = null
      // Upload audio to S3 if the ZIP contained the WAV file
      if (track.wav_buffer) {
        const { url, key } = await uploadImport(
          track.wav_buffer,
          `${track.track_title || 'track'}.wav`,
          'audio/wav',
          { artist: track.artist_name, album: track.album_title, title: track.track_title }
        )
        s3_url = url
        track.s3_url = url; track.s3_key = key
      }
      // Create FileMaker record
      try {
        const fm = await createGalloRecord({
          title:        track.track_title,
          artist:       track.artist_name,
          album:        track.album_title,
          isrc:         track.isrc,
          year:         track.year,
          release_date: track.release_date,
          genre:        track.genre,
          language:     track.language,
          duration:     track.duration_sec,
          explicit:     track.explicit,
          sequence_no:  track.track_number,
          catalogue_no: track.catalogue_no,
          barcode:      track.barcode,
          label:        track.label_name,
          s3_url,
          s3_key:       track.s3_key
        })
        created.push({ title: track.track_title, fmRecordId: fm.fmRecordId })
        console.log(`[DDEX] FM record created: ${fm.fmRecordId} — ${track.track_title}`)
      } catch(fmErr) {
        console.warn('[DDEX] FM record failed for', track.track_title, ':', fmErr.message)
        errors.push({ title: track.track_title, error: fmErr.message })
      }
    }

    res.json({ ok: true, version, created: created.length, results: created, errors })
  } catch(err) {
    res.status(400).json({ error: err.message })
  }
})

// ── Metadata lookup (from Gallo_Metadata_Extract.xlsx) ───────────────────────

// Lookup by ISRC or catalogue number (exact match, no auth — called from ingest form)
// Returns album-level data plus a full sorted track list when looking up by cat#
router.get('/metadata/lookup', async (req, res) => {
  const { isrc, cat } = req.query
  let row = null
  if (isrc) row = lookupByIsrc(isrc)
  if (!row && cat) row = lookupByCatalogue(cat)
  if (!row) return res.json({ ok: false, found: false })

  // When we have a catalogue number, return all tracks for the album too
  const catKey = row.catalogue || cat
  const tracks = catKey ? lookupAlbumTracks(catKey) : []

  res.json({ ok: true, found: true, data: row, tracks })
})

// Search metadata (admin only)
router.get('/metadata/search', adminAuth, async (req, res) => {
  const { q, limit } = req.query
  const results = searchMetadata(q, parseInt(limit, 10) || 20)
  res.json({ ok: true, results, count: results.length })
})

// Reload metadata file (admin only — call after replacing the xlsx on disk)
router.post('/metadata/reload', adminAuth, async (req, res) => {
  const result = await loadMetadata()
  res.json(result)
})

// Metadata status
router.get('/metadata/status', adminAuth, async (req, res) => {
  res.json({ ok: true, ...getStatus() })
})

// Full cache dump for the admin viewer. Null fields are stripped per row to
// roughly halve the payload — the viewer treats missing keys as ''.
router.get('/metadata/rows', adminAuth, async (req, res) => {
  let status = getStatus()
  if (!status.loaded) {
    await loadMetadata()
    status = getStatus()
  }
  const rows = getAllRows().map(r => {
    const slim = {}
    for (const [k, v] of Object.entries(r)) if (v != null && v !== '') slim[k] = v
    return slim
  })
  res.json({ ok: true, count: rows.length, loadedAt: status.loadedAt, rows })
})

// ── Filename-based metadata lookup ───────────────────────────────────────────
// GET  /metadata/lookup-filename?filename=198704266508_011_011.wav
//   → returns metadata row (no FM write)
// POST /metadata/lookup-filename  body: { filename, fmRecordId }
//   → looks up metadata and writes it to an existing FM record
router.get('/metadata/lookup-filename', async (req, res) => {
  const { filename } = req.query
  if (!filename) return res.status(400).json({ error: 'filename required' })
  const row = lookupByFilename(filename)
  if (!row) return res.json({ ok: false, found: false, filename })
  res.json({ ok: true, found: true, filename, data: row })
})

router.post('/metadata/lookup-filename', adminAuth, express.json(), async (req, res) => {
  const { filename, fmRecordId } = req.body || {}
  if (!filename) return res.status(400).json({ error: 'filename required' })
  if (!fmRecordId) return res.status(400).json({ error: 'fmRecordId required' })

  const row = lookupByFilename(filename)
  if (!row) return res.json({ ok: false, found: false, filename })

  try {
    const { updateGalloRecord } = await import('../lib/fm-gallo.js')
    await updateGalloRecord(fmRecordId, {
      title:           row.track_name,
      artist:          row.track_artist,
      featured_artist: row.featured_artist,
      album:           row.album_title,
      album_artist:    row.album_artist,
      isrc:            row.isrc,
      catalogue_no:    row.catalogue,
      barcode:         row.barcode,
      release_date:    row.release_date,
      year:            row.release_date ? row.release_date.slice(0, 4) : null,
      genre:           row.genre,
      language:        row.language,
      sequence_no:     row.seq,
      composer:        row.composer,
      publisher:       row.publisher,
      producer:        row.producer,
      label:           row.label,
      p_line:          row.p_line,
      c_line:          row.c_line,
    })
    res.json({ ok: true, found: true, filename, data: row })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Debug: raw FM record for one barcode ─────────────────────────────────────
// GET /metadata/fm-debug?barcode=198704266508
// Returns the raw wav_filename values FM sends back + cache lookup result
router.get('/metadata/fm-debug', adminAuth, async (req, res) => {
  const { barcode } = req.query
  if (!barcode) return res.status(400).json({ error: 'barcode required' })
  try {
    const { findGalloRecordsByBarcode, getGalloLayoutFields } = await import('../lib/fm-gallo.js')
    const { getStatus } = await import('../lib/metadata-cache.js')
    const LAYOUT = process.env.GALLO_FM_LAYOUT

    // 1. Layout field names containing 'file', 'wav', 'audio', 'barcode'
    let fieldNames = []
    try {
      const meta = await getGalloLayoutFields(LAYOUT)
      fieldNames = meta.map(f => f.name).filter(n => /file|wav|audio|barcode/i.test(n))
    } catch (e) { fieldNames = [`(introspection error: ${e.message})`] }

    // 2. Fetch a few raw records so we can see the EXACT Filename field values
    let rawSample = []
    try {
      const { getRawGalloSample } = await import('../lib/fm-gallo.js')
      rawSample = await getRawGalloSample(3)
    } catch (e) { rawSample = [{ error: e.message }] }

    // 3. Try the barcode find
    let findResult = null, findError = null
    try {
      const recs = await findGalloRecordsByBarcode(barcode)
      findResult = {
        count: recs.length,
        samples: recs.slice(0, 5).map(r => ({
          fm_record_id: r.fm_record_id,
          wav_filename:  r.wav_filename,
          asset_number:  r.asset_number,
          title:         r.title,
        }))
      }
    } catch (e) { findError = e.message }

    // 4. Cache lookup on each sample
    let cacheResults = []
    if (findResult?.samples?.length) {
      cacheResults = findResult.samples.map(s => {
        const match = s.wav_filename ? lookupByFilename(s.wav_filename) : null
        return { wav_filename: s.wav_filename, cacheFound: !!match, match_title: match?.track_name || null }
      })
    }

    res.json({
      ok: true,
      layout: LAYOUT,
      relevantFields: fieldNames,
      rawSample,
      findResult,
      findError,
      cacheResults,
      cacheStatus: getStatus(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Fetch FM records and preview metadata matches ─────────────────────────────
// GET /metadata/fm-preview?catalogue=CCA_xxx  or  ?barcode=198704266508
// Queries FileMaker for matching records, checks each Filename.wav against the
// metadata cache, and returns a preview list without writing anything.
router.get('/metadata/fm-preview', adminAuth, async (req, res) => {
  // Accept multiple values: ?catalogue=A&catalogue=B&barcode=X&barcode=Y
  const catalogues = (req.query.catalogues || req.query.catalogue || '').split(',').map(s => s.trim()).filter(Boolean)
  const barcodes   = (req.query.barcodes   || req.query.barcode   || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!catalogues.length && !barcodes.length) {
    return res.status(400).json({ error: 'catalogue or barcode parameter required' })
  }
  // Wait up to 10s for the metadata cache — prevents found=0 on a fresh server restart
  for (let i = 0; i < 20; i++) {
    if (getStatus().loaded) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (!getStatus().loaded) {
    return res.status(503).json({ error: 'Metadata cache is still loading — please retry in a few seconds' })
  }
  try {
    const { findGalloRecordsByCatalogue, findGalloRecordsByBarcode } = await import('../lib/fm-gallo.js')

    // Sequential — one FM query at a time, accuracy over speed.
    const allRecs = []
    const fetchErrors = []
    console.log(`[fm-preview] processing ${barcodes.length} barcodes: ${barcodes.join(', ')}`)
    for (const c of catalogues) {
      const recs = await findGalloRecordsByCatalogue(c).catch(e => { fetchErrors.push({ catalogue: c, error: e.message }); return [] })
      console.log(`[fm-preview] catalogue ${c} → ${recs.length} records`)
      allRecs.push(...recs)
    }
    for (const barcode of barcodes) {
      const recs = await findGalloRecordsByBarcode(barcode).catch(e => { fetchErrors.push({ barcode, error: e.message }); return [] })
      console.log(`[fm-preview] barcode ${barcode} → ${recs.length} records`)
      allRecs.push(...recs)
    }
    console.log(`[fm-preview] total before dedup: ${allRecs.length}`)
    if (fetchErrors.length) console.warn('[fm-preview] FM fetch errors:', JSON.stringify(fetchErrors))
    const seen = new Set()
    const fmRecords = allRecs.filter(r => {
      if (seen.has(r.fm_record_id)) return false
      seen.add(r.fm_record_id); return true
    })

    // Match each FM record against the metadata cache.
    // 1. Try barcode+seq (works for records found via the Barcode field search).
    // 2. Fall back to filename parse (works for CCA-style records where Filename = barcode_seq_seq).
    const preview = fmRecords.map(rec => {
      let meta = null

      // Primary: barcode + sequence number
      const bc = rec.barcode
      if (bc && rec.sequence_no != null) {
        meta = lookupByBarcodeAndSeq(bc, rec.sequence_no)
      }
      // Fallback: parse barcode+seq from filename
      if (!meta) {
        const filename = rec.wav_filename || null
        if (filename) meta = lookupByFilename(filename)
      }

      return {
        fm_record_id:   rec.fm_record_id,
        filename:       rec.wav_filename || null,
        barcode:        rec.barcode      || null,
        sequence_no:    rec.sequence_no  ?? null,
        current_title:  rec.title,
        current_artist: rec.artist_name,
        current_isrc:   rec.isrc,
        found:          !!meta,
        match_title:    meta?.track_name   || null,
        match_artist:   meta?.track_artist || null,
        match_cat:      meta?.catalogue    || null,
        match_isrc:     meta?.isrc         || null,
      }
    })

    const found    = preview.filter(p => p.found).length
    const notFound = preview.length - found
    res.json({ ok: true, total: preview.length, found, notFound, preview, fetchErrors })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Bulk FM update from FileMaker export ─────────────────────────────────────
// POST /metadata/bulk-filename-update
// Body: JSON array of { filename, fmRecordId }
// Looks up each filename in the cache and writes metadata to the FM record.
// Returns per-row results: { filename, fmRecordId, found, updated, error }
router.post('/metadata/bulk-filename-update', adminAuth, express.json({ limit: '2mb' }), async (req, res) => {
  const rows = req.body?.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array required' })
  }

  // ── Tape Files Master — create FIRST, before the (slow) per-track loop ──
  // Use the barcodes the user typed (req.body.barcodes) — these are reliable.
  // Fall back to deriving from row data in case the client is older.
  const inputBarcodes  = Array.isArray(req.body.barcodes) ? req.body.barcodes.map(String) : []
  const rowBarcodes    = rows.filter(r => r.barcode).map(r => String(r.barcode).trim())
  const uniqueBarcodes = [...new Set([...inputBarcodes, ...rowBarcodes].map(b => b.trim()).filter(Boolean))]
  const seenCatalogues = new Set()
  const tapeResults    = []

  for (const barcode of uniqueBarcodes) {
    const cats = lookupCataloguesByBarcode(barcode)
    for (const catalogue_no of cats) {
      if (seenCatalogues.has(catalogue_no)) continue
      seenCatalogues.add(catalogue_no)

      const tracks = lookupAlbumTracks(catalogue_no)
      const first  = tracks[0]
      if (!first) {
        tapeResults.push({ catalogue_no, ok: false, error: 'no tracks found in cache for this catalogue' })
        continue
      }

      try {
        const tapeMeta = {
          catalogue_no,
          album:                 first.album_title,
          album_artist:          first.album_artist || first.track_artist,
          barcode:               first.barcode,
          year:                  first.release_date ? String(first.release_date).slice(0, 4) : undefined,
          release_date:          first.release_date,
          original_release_date: first.original_release_date,
          genre:                 first.genre,
          local_genre:           first.local_genre,
          sub_genre:             first.sub_genre,
          language:              first.language,
          country:               first.country,
          rights_territories:    first.rights_territories,
          parental:              first.parental,
          label:                 first.label,
          p_line:                first.p_line,
          c_line:                first.c_line,
          publishers:            first.publisher,
        }
        const t = await createTapeFileRecord(tapeMeta)
        tapeResults.push({ catalogue_no, ok: true, tapeRecordId: t.tapeRecordId })
        console.log(`[BFU] Tape Files Master created for ${catalogue_no}: ${t.tapeRecordId}`)
      } catch (e) {
        tapeResults.push({ catalogue_no, ok: false, error: e.message })
        console.warn(`[BFU] Tape Files Master failed for ${catalogue_no}: ${e.message}`)
      }
    }
  }

  // ── Per-track updates ──────────────────────────────────────────────────────
  // Introspect layout once — resolves pLine/cLine/Label names AND builds a
  // full known-field set so we can pre-filter payloads (avoids FM error 102
  // "field missing" on every record, which would cause a layout re-fetch each
  // time and make bulk updates extremely slow / time out).
  const lf = await resolveGalloLineFields()
  let knownFields = null
  try {
    knownFields = await getGalloLayoutFieldSet()
  } catch (e) {
    console.warn('[BFU] Layout field set unavailable — will proceed without pre-filtering:', e.message)
  }

  const results = []

  for (const { filename, fmRecordId, barcode, sequence_no } of rows) {
    if (!fmRecordId) {
      results.push({ filename, fmRecordId, found: false, updated: false, error: 'missing fmRecordId' })
      continue
    }

    // Try barcode+seq first (reliable for records found via Barcode field search),
    // then fall back to parsing the filename.
    let row = null
    if (barcode && sequence_no != null) row = lookupByBarcodeAndSeq(barcode, sequence_no)
    if (!row && filename)               row = lookupByFilename(filename)
    if (!row) {
      results.push({ filename, fmRecordId, found: false, updated: false })
      continue
    }

    try {
      // Build FM field names exactly as the enrich route does
      const f = {}
      if (row.track_name)      f['Track Name']              = row.track_name
      if (row.track_artist)    f['Track Artist']            = row.track_artist
      if (row.featured_artist) f['Featured Artist']         = row.featured_artist
      if (row.album_title)     f['Album Title']             = row.album_title
      if (row.album_artist)    f['Album Artist']            = row.album_artist
      if (row.isrc)            f['ISRC']                    = row.isrc
      if (row.catalogue)     { f['Album Catalogue Number']  = row.catalogue
                               f['Reference Catalogue Number'] = row.catalogue }
      if (row.barcode)         f['Barcode']                 = String(row.barcode)
      if (row.barcode)         f['UPC']                     = String(row.barcode)
      if (row.seq != null)     f['Sequence Number']         = String(row.seq)
      if (row.seq != null)     f['Track Number']            = Number(row.seq)
      if (row.release_date)    f['Release Date']            = row.release_date
      if (row.release_date)    f['Year of Release']         = String(row.release_date).slice(0, 4)
      if (row.original_release_date) f['Original Release date'] = row.original_release_date
      if (row.genre)           f['Genre']                   = row.genre
      if (row.language) {
        f['Language'] = row.language
        const iso = row.language.length <= 3 ? row.language : languageNameToCode(row.language)
        if (iso) f['Language Code'] = iso
      }
      if (row.composer)        f['Composers']               = row.composer
      if (row.producer)        f['Producers']               = row.producer
      if (row.publisher)       f['Publishers']              = row.publisher
      if (row.label && lf.labelOk) f['Label']              = row.label
      if (row.p_line && lf.pName)  f[lf.pName]             = row.p_line
      if (row.c_line && lf.cName)  f[lf.cName]             = row.c_line

      // Pre-filter against the layout field set so FM never sees unknown fields.
      // updateGalloWithDiagnosis is still used as a safety net for any 102 errors.
      let payload = f
      let preSkipped = []
      if (knownFields) {
        payload = {}
        for (const [k, v] of Object.entries(f)) {
          if (knownFields.has(k)) payload[k] = v
          else preSkipped.push(k)
        }
        if (preSkipped.length) console.log(`[BFU] Pre-filtered unknown fields for ${fmRecordId}: ${preSkipped.join(', ')}`)
      }
      const { skipped } = await updateGalloWithDiagnosis(fmRecordId, payload)
      results.push({ filename, fmRecordId, found: true, updated: true,
                     title: row.track_name, artist: row.track_artist,
                     skipped_fields: [...preSkipped, ...skipped] })
    } catch (err) {
      results.push({ filename, fmRecordId, found: true, updated: false, error: err.message })
    }
  }

  const updated  = results.filter(r => r.updated).length
  const notFound = results.filter(r => !r.found).length
  const errors   = results.filter(r => r.found && !r.updated).length

  res.json({ ok: true, total: rows.length, updated, notFound, errors, results, tape: tapeResults })
})

// Return column headers from an uploaded file — used by the mapping UI before committing
router.post('/metadata/preview-headers', adminAuth, uploadSheet.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const buffer = await readFile(req.file.path)
    const result = extractMetadataHeaders(buffer)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (req.file?.path) unlink(req.file.path).catch(() => {})
  }
})

// Apply an explicit column mapping and append rows — used after user confirms mapping
router.post('/metadata/merge-mapped', adminAuth, uploadSheet.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  let mapping
  try {
    mapping = JSON.parse(req.body.mapping || '[]')
  } catch {
    return res.status(400).json({ error: 'Invalid mapping JSON' })
  }
  if (!mapping.length) return res.status(400).json({ error: 'Mapping is empty' })
  try {
    const buffer = await readFile(req.file.path)
    const result = await mergeMetadataWithMapping(buffer, mapping)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (req.file?.path) unlink(req.file.path).catch(() => {})
  }
})

// Merge an uploaded xlsx/csv into the metadata cache
router.post('/metadata/merge', adminAuth, uploadSheet.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const buffer = await readFile(req.file.path)
    const result = await mergeMetadataFromBuffer(buffer)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (req.file?.path) unlink(req.file.path).catch(() => {})
  }
})

// Append a single row to the metadata xlsx and reload the cache
router.post('/metadata/append', adminAuth, async (req, res) => {
  const row = req.body
  if (!row.isrc && !row.catalogue) {
    return res.status(400).json({ error: 'At least one of isrc or catalogue is required' })
  }
  try {
    const result = await appendMetadataRow(row)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Excel preview ─────────────────────────────────────────────────────────────
router.post('/excel', adminAuth, uploadSheet.single('sheet'), async (req, res) => {
  try {
    const buf = await readFile(req.file.path)
    await unlink(req.file.path).catch(() => {})
    const result = parseTrackSheet(buf)
    res.json({ ok: true, ...result })
  } catch(err) {
    res.status(400).json({ error: err.message })
  }
})

// ── FM-First Enrich: load existing FM records for a catalogue ────────────────
// Returns the FM records plus a derived track number extracted from each
// audio container filename (e.g. "01 Umtshotsho.wav" → trackNum 1).
router.get('/catalogue/:cat/records', adminAuth, async (req, res) => {
  const { cat } = req.params
  const tracks = await findGalloRecordsByCatalogue(cat).catch(e => {
    throw Object.assign(new Error(`FM query failed: ${e.message}`), { status: 502 })
  })
  if (!tracks.length) return res.status(404).json({ error: `No FM records found for catalogue "${cat}"` })

  // Extract track number from the movie: container filename prefix
  function extractTrackNum(containerUrl) {
    if (!containerUrl) return null
    const filename = containerUrl.startsWith('movie:')
      ? containerUrl.split('\r')[0].replace('movie:', '').trim()
      : containerUrl.split('/').pop().split('?')[0]
    const n = parseInt(filename, 10)
    return isNaN(n) ? null : n
  }

  const records = tracks.map(t => ({
    fm_record_id:  t.fm_record_id,
    track_num:     extractTrackNum(t.audio_container_url) ?? t.sequence_no ?? null,
    audio_file:    t.audio_container_url
                     ? t.audio_container_url.split('\r')[0].replace('movie:', '').trim()
                     : null,
    title:         t.title,
    isrc:          t.isrc,
    sequence_no:   t.sequence_no,
    catalogue_no:  t.catalogue_no,
  }))

  records.sort((a, b) => (a.track_num ?? 999) - (b.track_num ?? 999))
  res.json({ ok: true, count: records.length, records })
})

// ── FM-First Enrich: apply Excel metadata to existing FM records ─────────────
// Accepts either:
//   { pairs: [{ fm_record_id, row }] }  — explicit pairings from user-assisted UI
//   { rows: [...] }                      — auto-match by sequence/ISRC (legacy)
router.post('/catalogue/:cat/enrich', adminAuth, express.json(), async (req, res) => {
  const { cat } = req.params
  const { rows, pairs } = req.body || {}
  const lf = await resolveGalloLineFields()

  // Build FM fieldData using the exact same field names as createGalloRecord.
  function buildFieldData(row) {
    const f = {}

    if (row.title)        f['Track Name']                 = row.title
    if (row.artist_name)  f['Track Artist']               = row.artist_name
    if (row.album_artist) f['Album Artist']               = row.album_artist
    if (row.album_title)  f['Album Title']                = row.album_title
    if (row.catalogue)  { f['Album Catalogue Number']     = row.catalogue
                          f['Reference Catalogue Number'] = row.catalogue }
    if (row.isrc)         f['ISRC']                       = row.isrc
    const upc = row.album_upc || row.barcode
    if (upc)              f['Barcode']                    = String(upc)
    if (row.sequence_no != null) f['Sequence Number']     = String(row.sequence_no)
    if (row.year)         f['Year of Release']            = String(row.year)
    if (row.release_date) f['Release Date']               = row.release_date
    if (row.genre)        f['Genre']                      = row.genre
    if (row.language) {
      f['Language'] = row.language
      const iso = row.language.length <= 3 ? row.language : languageNameToCode(row.language)
      if (iso) f['Language Code'] = iso
    }
    if (row.release_date || row.original_release_date)
                          f['Original Release date']      = row.original_release_date || row.release_date
    if (row.rights_territories) f['Rights Territories']  = row.rights_territories
    if (row.parental && lf.parentalName) f[lf.parentalName] = row.parental
    if (row.bpm)          f['BPM']                        = String(row.bpm)
    if (row.duration_sec != null) f['Duration']           = String(row.duration_sec)
    if (row.explicit !== undefined && row.explicit !== null)
                          f['Explicit']                   = row.explicit ? 'Explicit' : 'No'
    if (row.composer)     f['Composers']                  = row.composer
    if (row.producer)     f['Producers']                  = row.producer
    if (row.publisher)    f['Publishers']                 = row.publisher
    if (row.label_name && lf.labelOk) f['Label']          = row.label_name
    if (row.p_line && lf.pName) f[lf.pName]               = row.p_line
    if (row.c_line && lf.cName) f[lf.cName]               = row.c_line
    applyCcaRules(f, row, row.catalogue || cat, lf)

    console.log(`[Enrich] fieldData keys: ${Object.keys(f).join(', ')}`)
    return f
  }

  // Mode 1: explicit pairs from user-assisted UI (no server-side matching needed)
  if (Array.isArray(pairs) && pairs.length) {
    const results = []
    const errors  = []
    // One-time diagnostic of the row shape coming in from the browser. If
    // expected keys (genre / composer / publisher / producer / label_name /
    // p_line / c_line) are absent here, the browser is sending stale data —
    // typically because admin.html is cached. Hard-refresh the admin page.
    if (pairs[0]?.row) {
      console.log(`[Enrich] incoming row keys (first pair): ${Object.keys(pairs[0].row).sort().join(', ')}`)
    }
    for (const { fm_record_id, row } of pairs) {
      try {
        const { skipped } = await updateGalloWithDiagnosis(fm_record_id, buildFieldData(row))
        results.push({ fm_record_id, title: row.title, sequence_no: row.sequence_no, skipped_fields: skipped })
        console.log(`[Enrich] ✓ ${fm_record_id} → ${row.title}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`)
      } catch (e) {
        errors.push({ fm_record_id, title: row.title, error: e.message })
        console.warn(`[Enrich] ✗ ${fm_record_id}: ${e.message}`)
      }
    }

    // Create one Tape Files Master record for the album using the first
    // successfully patched row's album-level fields (same as the register flow).
    if (results.length > 0) {
      const firstRow = pairs.find(p => results.some(r => r.fm_record_id === p.fm_record_id))?.row
      if (firstRow) {
        const tapeMeta = {
          album_artist:  firstRow.album_artist || firstRow.artist_name,
          album:         firstRow.album_title,
          catalogue_no:  firstRow.catalogue || cat,
        }
        createTapeFileRecord(tapeMeta)
          .then(t  => console.log(`[Enrich] Tape Files Master record created: ${t.tapeRecordId}`))
          .catch(e => console.warn(`[Enrich] Tape Files Master create failed: ${e.message}`))
      }
    }

    return res.json({ ok: true, matched: results.length, results, errors, unmatched_fm: [], unmatched_xl: [] })
  }

  // Mode 2: auto-match from rows array
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows or pairs required' })

  // 1. Fetch existing FM records
  const fmTracks = await findGalloRecordsByCatalogue(cat).catch(e => {
    throw Object.assign(new Error(`FM query failed: ${e.message}`), { status: 502 })
  })
  if (!fmTracks.length) return res.status(404).json({ error: `No FM records found for catalogue "${cat}"` })

  // 2. Build lookup maps
  function extractTrackNum(containerUrl) {
    if (!containerUrl) return null
    const filename = containerUrl.startsWith('movie:')
      ? containerUrl.split('\r')[0].replace('movie:', '').trim()
      : containerUrl.split('/').pop().split('?')[0]
    const n = parseInt(filename, 10)
    return isNaN(n) ? null : n
  }

  const fmByTrackNum = new Map()
  const fmByIsrc     = new Map()
  for (const fm of fmTracks) {
    const trackNum = extractTrackNum(fm.audio_container_url) ?? fm.sequence_no
    if (trackNum != null) fmByTrackNum.set(trackNum, fm)
    if (fm.isrc) fmByIsrc.set(fm.isrc.toUpperCase().trim(), fm)
  }

  // 3. Match Excel rows to FM records
  const matched      = []
  const unmatchedXl  = []
  const usedFmIds    = new Set()

  for (const row of rows) {
    let fm = null
    if (row.isrc) fm = fmByIsrc.get(row.isrc.toUpperCase().trim())
    // sequence_no is populated when Excel column header is "Seq" / "Sequence";
    // track_number is populated when header is "Track" / "Track No" / "#".
    // Treat both as equivalent position identifiers for matching.
    const rowSeq = row.sequence_no ?? row.track_number
    if (!fm && rowSeq != null) fm = fmByTrackNum.get(parseInt(rowSeq, 10))
    if (fm) {
      // Normalise sequence_no so the PATCH always sets Sequence Number
      if (row.sequence_no == null && row.track_number != null) row.sequence_no = row.track_number
      matched.push({ fm, row })
      usedFmIds.add(fm.fm_record_id)
    } else {
      unmatchedXl.push(row)
    }
  }

  const unmatchedFm = fmTracks.filter(fm => !usedFmIds.has(fm.fm_record_id))

  // 4. Apply metadata patches
  const results = []
  const errors  = []

  for (const { fm, row } of matched) {
    try {
      const { skipped } = await updateGalloWithDiagnosis(fm.fm_record_id, buildFieldData(row))
      results.push({ fm_record_id: fm.fm_record_id, title: row.title, sequence_no: row.sequence_no, skipped_fields: skipped })
      console.log(`[Enrich] ✓ Updated FM record ${fm.fm_record_id} → ${row.title}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`)
    } catch (e) {
      errors.push({ fm_record_id: fm.fm_record_id, title: row.title || `(track ${row.sequence_no})`, error: e.message })
      console.warn(`[Enrich] ✗ Failed to update ${fm.fm_record_id}: ${e.message}`)
    }
  }

  res.json({
    ok: true,
    matched: results.length,
    results,
    errors,
    unmatched_fm: unmatchedFm.map(fm => ({
      fm_record_id: fm.fm_record_id,
      audio_file:   fm.audio_container_url?.split('\r')[0].replace('movie:', '').trim() || '—'
    })),
    unmatched_xl: unmatchedXl.map(row => ({
      sequence_no: row.sequence_no,
      title:       row.title,
      isrc:        row.isrc
    }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  MadStreamer push — separate admin action.
//  The Gallo Catalogue is the source of truth: we look up the canonical track
//  from Gallo, fetch its WAV, transcode to 320 kbps MP3, and push everything
//  (MP3, GMVi-named artwork, optionally the WAV) into the MadStreamer S3 paths
//  + API_Album_Songs layout. GMVi comes from the MadStreamer Artwork layout
//  (lookup by Reference Catalogue Number) and is non-negotiable for naming.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/madstreamer/ping', adminAuth, async (req, res) => {
  res.json({ ok: await pingMadStreamer(), config: madStreamerConfig })
})

/**
 * Diagnostic — return the actual field names on the Gallo Catalogue layout
 * the API writes to (defaults to GALLO_FM_LAYOUT, currently API_Album_Songs).
 * Pass ?layout=SomeOther to inspect a different layout.
 * Useful for verifying that field names in buildFieldData / createGalloRecord
 * actually exist on the FM layout (FM rejects unknown field names silently
 * or with a generic "field is missing" error).
 */
/**
 * Diagnostic — replay the last N create attempts against Gallo so we don't
 * have to chase a fast-scrolling terminal. Returns each event with its phase
 * (post / recordId / verify_ok / verify_404 / verify_mismatch / error / ...).
 * Pass ?clear=1 to drop the buffer first.
 */
router.get('/gallo/recent-creates', adminAuth, (req, res) => {
  if (req.query.clear) clearRecentGalloCreates()
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
  res.json({ events: getRecentGalloCreates(limit) })
})

/**
 * GET /api/ingest/system/volumes
 * Lists removable + network volumes mounted under /Volumes (macOS) so the
 * admin UI can offer them as one-click DDEX output folders. The system root
 * ("Macintosh HD") and hidden / dotfile entries are filtered out. Returns
 * { volumes: [{ name, path, free_gb? }], platform } — a best-effort enumeration.
 */
router.get('/system/volumes', adminAuth, async (req, res) => {
  try {
    const fsP = await import('fs/promises')
    const entries = await fsP.readdir('/Volumes', { withFileTypes: true })
    const names = entries
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name)
      .filter(n => !n.startsWith('.'))
      .filter(n => n !== 'Macintosh HD')
      .sort()
    const volumes = names.map(name => ({ name, path: `/Volumes/${name}` }))
    res.json({ volumes, platform: process.platform, mountpoint: '/Volumes' })
  } catch (err) {
    // /Volumes doesn't exist on Linux/Windows or if the user has no removable
    // drives — return empty silently so the UI just hides the section.
    res.json({ volumes: [], platform: process.platform, error: err.code === 'ENOENT' ? null : err.message })
  }
})

router.get('/gallo/layout-fields', adminAuth, async (req, res) => {
  const layout = req.query.layout
  try {
    const fields = await getGalloLayoutFields(layout)
    // If specific names were passed in ?check=Genre,Composers%20All,pLine,…
    // we annotate each with whether it exists.
    const checkList = (req.query.check || '').split(',').map(s => s.trim()).filter(Boolean)
    const present   = new Set(fields.map(f => f.name))
    const checkResult = checkList.length
      ? checkList.map(n => ({ name: n, present: present.has(n) }))
      : null
    res.json({
      ok: true,
      layout: layout || process.env.GALLO_FM_LAYOUT,
      count:  fields.length,
      fields,
      check:  checkResult,
    })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/madstreamer/layout-fields', adminAuth, async (req, res) => {
  const layout = req.query.layout || madStreamerConfig.LAYOUT
  if (req.query.reload) reloadLayoutFields(layout)
  try {
    const fields = await getLayoutFields(layout)
    res.json({ ok: true, layout, count: fields.size, fields: [...fields].sort() })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/**
 * Artist Bio (API_Artist_Bio on MadStreamer). Biography tab.
 * GET  /madstreamer/bios        → all bio rows, for the admin list
 * GET  /madstreamer/bio?artist= → single bio lookup, for the edit/load flow
 * POST /madstreamer/bio         → { artistName, bio } — creates or updates
 *                                  the artist's record and forces Active = 1
 *                                  on commit.
 */
router.get('/madstreamer/bios', adminAuth, async (req, res) => {
  try {
    const bios = await listArtistBios()
    res.json({ ok: true, bios })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/madstreamer/bio', adminAuth, async (req, res) => {
  const artist = String(req.query.artist || '').trim()
  if (!artist) return res.status(400).json({ error: 'artist query param required' })
  try {
    const bio = await findArtistBio(artist)
    res.json({ ok: true, bio })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.post('/madstreamer/bio', adminAuth, express.json(), async (req, res) => {
  const artistName = String(req.body?.artistName || '').trim()
  const bio         = String(req.body?.bio || '')
  if (!artistName) return res.status(400).json({ error: 'artistName is required' })
  try {
    const result = await upsertArtistBio({ artistName, bio })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/**
 * Playlist Artwork (API_Playlist_Art on MadStreamer). Playlist Artwork tab.
 * GET  /madstreamer/playlist-arts      → all rows, for the admin list
 * GET  /madstreamer/playlist-art?name= → single lookup
 * POST /madstreamer/playlist-art       → multipart: image (required) + playlistName.
 *                                        Uploads the cover to S3 (artwork/playlist-<slug>.<ext>),
 *                                        then upserts the record with Image_S3_URL + Active = 1.
 */
const uploadPlaylistImage = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
           || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
    cb(ok ? null : new Error(`Cover must be jpg/png/webp, got: ${file.mimetype}`), ok)
  }
})

router.get('/madstreamer/playlist-arts', adminAuth, async (req, res) => {
  try {
    const items = await listPlaylistArt()
    res.json({ ok: true, items })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/madstreamer/playlist-art', adminAuth, async (req, res) => {
  const name = String(req.query.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name query param required' })
  try {
    const item = await findPlaylistArt(name)
    res.json({ ok: true, item })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.post('/madstreamer/playlist-art', adminAuth, uploadPlaylistImage.single('image'), async (req, res) => {
  const playlistName = String(req.body?.playlistName || '').trim()
  if (!playlistName) return res.status(400).json({ error: 'playlistName is required' })
  if (!req.file)     return res.status(400).json({ error: 'image file is required' })
  try {
    const ext = path.extname(req.file.originalname) || '.jpg'
    const up  = await uploadPlaylistArt(req.file.buffer, playlistName, ext, req.file.mimetype)
    const result = await upsertPlaylistArt({ playlistName, imageUrl: up.url })
    res.json({ ok: true, imageUrl: up.url, key: up.key, ...result })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/**
 * Public Playlists (PublicPlaylist tag on MadStreamer API_Album_Songs). Playlists tab.
 * GET  /madstreamer/playlist-songs?q=              → artist search across streamer tracks
 * GET  /madstreamer/public-playlists               → distinct playlist names + track counts
 * GET  /madstreamer/public-playlists/tracks?name=  → songs currently tagged with that name
 * POST /madstreamer/public-playlists/assign        → { recordIds:[], playlistName } tags each
 *                                                    record; playlistName '' clears the tag.
 * GET  /madstreamer/audition/:recordId?token=      → streams the track MP3 from S3
 *                                                    (query-token auth: <audio> can't send headers)
 */
router.get('/madstreamer/playlist-songs', adminAuth, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.status(400).json({ error: 'Search term must be at least 2 characters' })
  try {
    const songs = await findStreamerSongsByArtist(q)
    res.json({ ok: true, songs })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/madstreamer/public-playlists', adminAuth, async (req, res) => {
  try {
    const playlists = await listPublicPlaylists()
    res.json({ ok: true, playlists })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/madstreamer/public-playlists/tracks', adminAuth, async (req, res) => {
  const name = String(req.query.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name query param required' })
  try {
    const songs = await findSongsByPlaylist(name)
    res.json({ ok: true, songs })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.post('/madstreamer/public-playlists/assign', adminAuth, express.json(), async (req, res) => {
  const { recordIds } = req.body || {}
  const playlistName  = String(req.body?.playlistName ?? '').trim() // '' = untag
  if (!Array.isArray(recordIds) || !recordIds.length) {
    return res.status(400).json({ error: 'recordIds array required' })
  }
  if (recordIds.length > 500) {
    return res.status(400).json({ error: 'Too many records in one request (max 500)' })
  }

  const results = []
  for (const id of recordIds) {
    try {
      await setPublicPlaylist(String(id), playlistName)
      results.push({ recordId: String(id), ok: true })
    } catch (err) {
      results.push({ recordId: String(id), ok: false, error: err.message })
      console.warn(`[Playlists] ✗ ${id} → "${playlistName}": ${err.message}`)
    }
  }
  const tagged = results.filter(r => r.ok).length
  console.log(`[Playlists] ${playlistName ? `Tagged ${tagged} record(s) as "${playlistName}"` : `Untagged ${tagged} record(s)`}${tagged < results.length ? ` (${results.length - tagged} failed)` : ''}`)
  res.json({ ok: tagged === results.length, playlistName, tagged, failed: results.length - tagged, results })
})

router.get('/madstreamer/audition/:recordId', async (req, res) => {
  const token = (req.query.token || req.headers.authorization?.replace('Bearer ', '') || '').trim()
  if (!token || token !== process.env.INGEST_ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const url = await getStreamerSongAudioUrl(req.params.recordId)
    if (!url) return res.status(404).json({ error: 'No audio on this record' })
    const key = keyFromS3Url(url)
    if (!key) return res.redirect(url) // not our bucket — let the browser fetch it directly
    const { buffer, contentType } = await downloadAnyKey(key)
    res.set('Content-Type', contentType || 'audio/mpeg')
    res.set('Content-Length', String(buffer.length))
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(buffer)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/**
 * Metadata-only sync for a whole catalogue.
 * Reads every Gallo record for the catalogue, looks up GMVi once
 * (artwork-only — non-blocking), and upserts each track into MadStreamer's
 * API_Album_Songs layout. NO audio download, NO transcode, NO S3 work.
 *
 * Body: { catalogue_no }
 * Returns: { ok, catalogue_no, gmvi, total, succeeded, failed, results: [...] }
 */
async function _runMadStreamerMetadataSync(track, gmvi) {
  // `track` is mapGalloRecord output, from findGalloRecordsByCatalogue.
  // Streamer's Filename field stores the bare GCAT (no extension).
  const gcat = track.asset_number
            || (track.wav_filename ? String(track.wav_filename).replace(/\.[^.]+$/, '') : null)
  if (!gcat) {
    const err = new Error(`Track "${track.title || track.fm_record_id}" has no Filename — can't derive GCAT`)
    err.code = 'NO_GCAT'
    throw err
  }
  const fm = await upsertMp3Record({
    gmvi:            gmvi || undefined,
    filename:        gcat,                         // bare GCAT, no .wav
    title:           track.title,
    artist:          track.artist_name,
    album_artist:    track.album_artist || track.artist_name,
    album:           track.album_title,
    catalogue_no:    track.catalogue_no,
    isrc:            track.isrc,
    barcode:         track.barcode,
    sequence_no:     track.sequence_no,
    year:            track.year,
    release_date:    track.release_date,
    genre:           track.genre,
    language:        track.language,
    duration:        track.duration_sec ? String(track.duration_sec) : null,
    explicit:        track.explicit,
    composers:       _flatten(track.composers),
    producers:       _flatten(track.producers),
    publishers:      _flatten(track.publishers),
    // No URL fields — those come from the audio push, not metadata sync.
  })
  return { gcat, fm }
}

router.post('/madstreamer/sync-metadata-by-catalogue', adminAuth, express.json(), async (req, res) => {
  const catalogue_no = req.body?.catalogue_no
  if (!catalogue_no) return res.status(400).json({ error: 'catalogue_no required' })

  try {
    // 1. Pull every Gallo record for the catalogue (single FM find).
    const tracks = await findGalloRecordsByCatalogue(catalogue_no)
    if (!tracks.length) return res.status(404).json({ error: `No Gallo records for catalogue "${catalogue_no}"` })

    // 2. Look up GMVi once for the whole catalogue (artwork-only — non-blocking).
    const gmviRec = await lookupGmviByCatalogue(catalogue_no).catch(e => {
      console.warn('[Sync metadata] GMVi lookup error:', e.message)
      return null
    })
    const gmvi = gmviRec?.gmvi || null
    if (!gmvi) console.warn(`[Sync metadata] No GMVi for "${catalogue_no}" — records will sync without artwork ID`)

    // 3. Sort by sequence and upsert each.
    tracks.sort((a, b) => (a.sequence_no ?? 999) - (b.sequence_no ?? 999))
    const results = []
    for (const track of tracks) {
      try {
        const r = await _runMadStreamerMetadataSync(track, gmvi)
        results.push({
          ok: true,
          sequence_no:   track.sequence_no,
          title:         track.title,
          gcat:          r.gcat,
          action:        r.fm.action,
          fm_record_id:  r.fm.recordId,
        })
        console.log(`[Sync metadata] ${r.gcat} ${r.fm.action} (${track.title})`)
      } catch (err) {
        results.push({
          ok: false,
          sequence_no: track.sequence_no,
          title:       track.title,
          error:       err.message,
        })
        console.warn(`[Sync metadata] FAIL ${track.title}: ${err.message}`)
      }
    }

    const succeeded = results.filter(r => r.ok).length
    const failed    = results.length - succeeded

    // 4. Upsert the album-level Tape Files Master record (once per catalogue).
    //    Driven from the first track's data — all tracks in the catalogue
    //    share the album-level fields anyway. Non-blocking: if this fails,
    //    the per-track sync is still considered a success.
    let tape = null
    const sample = tracks[0] || {}
    try {
      const r = await upsertTapeFileRecord({
        catalogue_no: catalogue_no,
        album:        sample.album_title,
        album_artist: sample.album_artist || sample.artist_name,
        artist:       sample.artist_name,
        barcode:      sample.barcode,
        year:         sample.year,
        release_date: sample.release_date || sample.original_release_date,
        genre:        sample.genre,
      })
      tape = { ok: true, action: r.action, fm_record_id: r.recordId, dropped: r.dropped }
      console.log(`[Sync metadata] Tape Files Master ${r.action}: ${r.recordId}`)
    } catch (err) {
      tape = { ok: false, error: err.message }
      console.warn(`[Sync metadata] Tape Files Master FAIL: ${err.message}`)
    }

    res.json({ ok: true, catalogue_no, gmvi, total: results.length, succeeded, failed, results, tape })
  } catch (err) {
    console.error('[Sync metadata]', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * Core push — does the heavy lifting given a resolved track and (optional)
 * GMVi for the artwork. Audio paths are keyed by GCAT (read from Gallo's
 * Filename field). GMVi is used strictly for artwork.
 *
 * Used by /madstreamer/push-by-catalogue.
 *
 * @param {object} track       — output of getGalloTrack(); must include .gcat
 * @param {string|null} gmvi   — required for artwork; if null, artwork is skipped
 * @param {object} opts        — { include_wav: bool }
 * @returns {object}           — { gcat, gmvi, mp3, wav, artwork, fm }
 */
async function _runMadStreamerPush(track, gmvi, opts = {}) {
  if (!track)       throw new Error('No Gallo track provided')
  if (!track.gcat)  throw new Error('Gallo record has no Filename — cannot derive GCAT for audio asset name')

  const gcat = track.gcat

  // ── Catalogue-readiness pre-flight ──────────────────────────────────────
  // The catalogue is the source of truth for MadStreamer. If a record hasn't
  // been processed yet (no S3 mirror of the WAV via "File URL"), the push is
  // premature — surface this cleanly instead of throwing deep in the stack.
  if (!track.audio_url) {
    const err = new Error(
      `Catalogue not ready for ${gcat}: no File URL on the Gallo record. ` +
      `Run the daily sync (or otherwise mirror the WAV to S3 and set File URL) before pushing.`
    )
    err.code = 'CATALOGUE_NOT_READY'
    throw err
  }

  let wavBuffer
  let wavSourceLabel
  const galloKey = keyFromS3Url(track.audio_url)
  if (galloKey) {
    const dl = await downloadAnyKey(galloKey)
    wavBuffer = dl.buffer
    wavSourceLabel = `s3://…/${galloKey}`
  } else {
    const dl = await downloadByUrl(track.audio_url)
    wavBuffer = dl.buffer
    wavSourceLabel = track.audio_url
  }
  console.log(`[MadStreamer ${gcat}] WAV source: ${wavSourceLabel} (${wavBuffer.length} bytes)`)

  // 2. Transcode WAV → MP3 (320 kbps CBR by default).
  await ensureFfmpeg()
  const mp3Buf = await wavBufferToMp3(wavBuffer)
  console.log(`[MadStreamer ${gcat}] MP3 transcoded: ${mp3Buf.length} bytes (320 kbps)`)

  // 3. Upload MP3 to s3://…/mp3/<GCAT>.mp3
  const mp3Up = await uploadMp3ByGcat(mp3Buf, gcat)
  console.log(`[MadStreamer ${gcat}] MP3 uploaded → ${mp3Up.url}`)

  // 4. Optional: push the WAV too, also keyed by GCAT.
  let wavUp = null
  if (opts.include_wav) {
    wavUp = await uploadWavByGcat(wavBuffer, gcat)
    console.log(`[MadStreamer ${gcat}] WAV uploaded → ${wavUp.url}`)
  }

  // 5. Artwork — pull from Gallo's Artwork URL, re-upload as <GMVi>.<ext>.
  //    Requires a GMVi from MadStreamer's Artwork layout. Skipped (warning)
  //    when GMVi is unavailable so the audio push still succeeds.
  let artworkUp = null
  if (track.artwork_url && gmvi) {
    const artKey = keyFromS3Url(track.artwork_url)
    let artBuf, artType, artExt
    if (artKey) {
      const dl = await downloadAnyKey(artKey)
      artBuf  = dl.buffer
      artType = dl.contentType || 'image/jpeg'
      artExt  = path.extname(artKey) || '.jpg'
    } else {
      const dl = await downloadByUrl(track.artwork_url)
      artBuf  = dl.buffer
      artType = dl.contentType || 'image/jpeg'
      artExt  = path.extname(new URL(track.artwork_url).pathname) || '.jpg'
    }
    artworkUp = await uploadArtworkByGmvi(artBuf, gmvi, artExt, artType)
    console.log(`[MadStreamer ${gcat}] Artwork uploaded → ${artworkUp.url}`)
  } else if (!gmvi) {
    console.warn(`[MadStreamer ${gcat}] No GMVi available for catalogue ${track.catalogue_no} — artwork not pushed`)
  } else {
    console.warn(`[MadStreamer ${gcat}] No Artwork URL on Gallo record — skipping artwork upload`)
  }

  // 6. Upsert the MadStreamer API_Album_Songs record. Filename = bare GCAT
  //    (no extension); GMVi is included only when we found one.
  const fm = await upsertMp3Record({
    gmvi:            gmvi || undefined,           // artwork-only — only set if known
    filename:        gcat,                        // bare GCAT, no .wav
    title:           track.title,
    artist:          track.artist,
    album_artist:    track.album_artist,
    album:           track.album,
    catalogue_no:    track.catalogue_no,
    isrc:            track.isrc,
    barcode:         track.barcode,
    sequence_no:     track.sequence_no,
    year:            track.year,
    release_date:    track.release_date,
    genre:           track.genre,
    language:        track.language,
    bpm:             track.bpm,
    duration:        track.duration,
    explicit:        track.explicit,
    composers:       track.composers,
    producers:       track.producers,
    publishers:      track.publishers,
    mp3_url:         mp3Up.url,
    wav_url:         wavUp?.url,
    artwork_url:     artworkUp?.url || track.artwork_url,
    audio_url:       mp3Up.url,
  })
  console.log(`[MadStreamer ${gcat}] FM record ${fm.action}: ${fm.recordId}`)

  return {
    gcat,
    gmvi:    gmvi || null,
    mp3:     { key: mp3Up.key,                 url: mp3Up.url },
    wav:     wavUp     ? { key: wavUp.key,      url: wavUp.url }     : null,
    artwork: artworkUp ? { key: artworkUp.key,  url: artworkUp.url } : null,
    fm,
    gallo_record_id: track.fm_record_id,
  }
}

/**
 * Push by catalogue + sequence (or ISRC) directly.
 * Body: { catalogue_no, sequence_no?, isrc?, include_wav? }
 */
router.post('/madstreamer/push-by-catalogue', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, sequence_no, isrc } = req.body || {}
  const include_wav = !!req.body?.include_wav
  if (!catalogue_no && !isrc) {
    return res.status(400).json({ error: 'Provide catalogue_no (and ideally sequence_no), or isrc' })
  }
  try {
    const track = await getGalloTrack({ catalogue_no, sequence_no, isrc })
    if (!track) return res.status(404).json({ error: 'No matching Gallo Catalogue record' })

    // GMVi is artwork-only — non-blocking. Audio push uses GCAT regardless.
    const gmviRec = await lookupGmviByCatalogue(track.catalogue_no || catalogue_no).catch(e => {
      console.warn('[MadStreamer push-by-catalogue] GMVi lookup error:', e.message)
      return null
    })
    if (!gmviRec) {
      console.warn(`[MadStreamer push-by-catalogue] No GMVi for catalogue "${track.catalogue_no || catalogue_no}" — artwork will be skipped`)
    }

    const result = await _runMadStreamerPush(track, gmviRec?.gmvi || null, { include_wav })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[MadStreamer push-by-catalogue]', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  Gallo CMS 2024 — third sibling database (digitalcupboard.app).
//  Fully cross-integrated with Gallo Catalogue: same credentials, free
//  read/write access, and helpers to push records from Catalogue → CMS 2024
//  (and back). All endpoints are admin-gated.
//
//  All endpoints accept ?layout=<NAME> to target a layout other than the
//  default (CMS2024_FM_LAYOUT, currently "Song Files").
// ─────────────────────────────────────────────────────────────────────────────

// Health check + config dump. Mirror of /madstreamer/ping.
router.get('/cms2024/ping', adminAuth, async (req, res) => {
  res.json({ ok: await pingCms2024(), config: cms2024Config })
})

// Live layout introspection. Returns the names+types FM is reporting for the
// layout, plus an optional ?check=Foo,Bar,Baz that annotates whether each
// name is present. Useful when buildFieldData is being silently dropped.
router.get('/cms2024/layout-fields', adminAuth, async (req, res) => {
  const layout = req.query.layout || cms2024Config.LAYOUT
  if (req.query.reload) reloadCms2024LayoutFields(layout)
  try {
    const fields = await getCms2024LayoutFieldMeta(layout)
    const checkList = (req.query.check || '').split(',').map(s => s.trim()).filter(Boolean)
    const present   = new Set(fields.map(f => f.name))
    const checkResult = checkList.length
      ? checkList.map(n => ({ name: n, present: present.has(n) }))
      : null
    res.json({ ok: true, layout, count: fields.length, fields, check: checkResult })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Free-text search — mirrors /catalog/search but against CMS 2024.
router.get('/cms2024/search', adminAuth, async (req, res) => {
  const { q } = req.query
  const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0)
  const layout = req.query.layout
  if (!q || q.trim().length < 2) return res.json({ tracks: [], count: 0, foundCount: 0 })
  try {
    const { tracks, foundCount } = await searchCms2024Records(q, { layout, limit, offset })
    res.json({ tracks, count: tracks.length, foundCount })
  } catch (err) {
    console.error('[CMS 2024 search]', err)
    res.status(502).json({ error: err.message })
  }
})

// Fetch a single record by its FM internal recordId.
router.get('/cms2024/records/:id', adminAuth, async (req, res) => {
  const layout = req.query.layout
  try {
    const rec = await getCms2024Record(req.params.id, layout)
    if (!rec) return res.status(404).json({ error: 'Record not found' })
    res.json({ ok: true, record: rec, track: mapCms2024Record(rec) })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Find records by FM-style query. Body: { query, limit?, offset?, sort?, layout? }
router.post('/cms2024/find', adminAuth, express.json(), async (req, res) => {
  const { query, limit, offset, sort, layout } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  try {
    const result = await findCms2024Records(query, { layout, limit, offset, sort })
    res.json({ ok: true, ...result, tracks: result.records.map(mapCms2024Record) })
  } catch (err) {
    console.error('[CMS 2024 find]', err)
    res.status(502).json({ error: err.message })
  }
})

// Create a new record. Body: { fieldData, layout? }
router.post('/cms2024/records', adminAuth, express.json(), async (req, res) => {
  const { fieldData, layout } = req.body || {}
  if (!fieldData || typeof fieldData !== 'object') {
    return res.status(400).json({ error: 'fieldData object required' })
  }
  try {
    const { recordId, dropped } = await createCms2024Record(fieldData, { layout })
    res.status(201).json({ ok: true, recordId, dropped })
  } catch (err) {
    console.error('[CMS 2024 create]', err)
    res.status(502).json({ error: err.message })
  }
})

// Update an existing record. Body: { fieldData, layout? }
router.patch('/cms2024/records/:id', adminAuth, express.json(), async (req, res) => {
  const { fieldData, layout } = req.body || {}
  if (!fieldData || typeof fieldData !== 'object') {
    return res.status(400).json({ error: 'fieldData object required' })
  }
  try {
    const { recordId, dropped } = await updateCms2024Record(req.params.id, fieldData, { layout })
    res.json({ ok: true, recordId, dropped })
  } catch (err) {
    console.error('[CMS 2024 update]', err)
    res.status(502).json({ error: err.message })
  }
})

// Delete a record by FM recordId.
router.delete('/cms2024/records/:id', adminAuth, async (req, res) => {
  const layout = req.query.layout
  try {
    await deleteCms2024Record(req.params.id, { layout })
    res.json({ ok: true })
  } catch (err) {
    console.error('[CMS 2024 delete]', err)
    res.status(502).json({ error: err.message })
  }
})

// Run a FileMaker script on a record. Body: { script, scriptParam?, layout? }
router.post('/cms2024/records/:id/run-script', adminAuth, express.json(), async (req, res) => {
  const { script, scriptParam, layout } = req.body || {}
  if (!script) return res.status(400).json({ error: 'script name required' })
  try {
    const result = await runCms2024Script(req.params.id, script, scriptParam, { layout })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[CMS 2024 run-script]', err)
    res.status(502).json({ error: err.message })
  }
})

// ── Cross-DB: Gallo Catalogue ↔ CMS 2024 ─────────────────────────────────
// Push a single canonical Gallo Catalogue track into CMS 2024. Looks up the
// track on Gallo, builds a payload, and upserts on CMS 2024 keyed by ISRC
// (preferred) or Filename. The introspection filter drops anything CMS 2024's
// "Song Files" layout doesn't expose, so this remains safe even if field
// names drift between the two DBs.
//
// Body: { catalogue_no, sequence_no?, isrc?, layout? }
router.post('/cms2024/push-from-gallo', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, sequence_no, isrc, layout } = req.body || {}
  if (!catalogue_no && !isrc) {
    return res.status(400).json({ error: 'Provide catalogue_no (and ideally sequence_no), or isrc' })
  }
  try {
    const track = await getGalloTrack({ catalogue_no, sequence_no, isrc })
    if (!track) return res.status(404).json({ error: 'No matching Gallo Catalogue record' })

    // Build a generous payload; introspection trims unknown fields server-side.
    // Song Files uses singular Composer/Producer and Filename.wav (not Filename).
    // We send both variants so the layout can keep whichever it has.
    const fd = {}
    if (track.title)        fd['Track Name']                  = track.title
    if (track.title)        fd['Song Title']                  = track.title
    if (track.artist)       fd['Track Artist']                = track.artist
    if (track.album_artist) fd['Album Artist']                = track.album_artist
    if (track.album)        fd['Album Title']                 = track.album
    if (track.catalogue_no) { fd['Album Catalogue Number']    = track.catalogue_no
                              fd['Reference Catalogue Number'] = track.catalogue_no }
    if (track.isrc)         fd['ISRC']                        = track.isrc
    // Song Files uses UPC as the barcode field — there's no separate Barcode field.
    if (track.barcode)      fd['UPC']                         = String(track.barcode)
    // Song Files uses 'Track Number' (number); also send 'Sequence Number'
    // for layouts that prefer the older name.
    if (track.sequence_no != null) { fd['Track Number']        = Number(track.sequence_no)
                                     fd['Sequence Number']     = String(track.sequence_no) }
    if (track.year)         fd['Year of Release']             = String(track.year)
    if (track.year)         fd['Year']                        = String(track.year)
    if (track.release_date) fd['Release Date']                = track.release_date
    if (track.genre) {      fd['Genre']                       = track.genre
                            fd['Local Genre']                 = track.genre }
    if (track.language) {
      fd['Language'] = track.language
      const iso = track.language.length <= 3
        ? track.language
        : languageNameToCode(track.language)
      if (iso) fd['Language Code'] = iso
    }
    if (track.duration)     fd['Duration']                    = _durationForFm(track.duration)
    if (track.bpm)          fd['BPM']                         = String(track.bpm)
    // Composer/Producer in Song Files are singular text fields; keep both names
    // so whichever the schema uses gets the value. _flatten coerces arrays
    // (from mapGalloRecord / mapCms2024Record) to FM-safe strings.
    const _composers  = _flatten(track.composers)
    const _producers  = _flatten(track.producers)
    const _publishers = _flatten(track.publishers)
    if (_composers)  { fd['Composer']  = _composers;  fd['Composers']  = _composers  }
    if (_producers)  { fd['Producer']  = _producers;  fd['Producers']  = _producers  }
    if (_publishers) { fd['Publisher'] = _publishers; fd['Publishers'] = _publishers }
    if (track.label)        fd['Label']                       = track.label
    if (track.p_line)       fd['pLine']                       = track.p_line
    if (track.c_line)       fd['cLine']                       = track.c_line
    if (track.audio_url)    fd['File URL']                    = track.audio_url
    if (track.audio_url)    fd['S3_URL']                      = track.audio_url
    if (track.artwork_url)  fd['Artwork URL']                 = track.artwork_url
    // Both Filename and Filename.wav exist on Song Files; per Ian's call we
    // write to Filename only (keeps the legacy .wav field untouched).
    if (track.filename)     fd['Filename']                    = track.filename

    // Uniqueness key — ISRC first (track-level unique), Filename second.
    const queries = []
    if (track.isrc)     queries.push({ 'ISRC':     `==${track.isrc}` })
    if (track.filename) queries.push({ 'Filename': `==${track.filename}` })
    if (!queries.length) {
      return res.status(400).json({ error: 'Gallo track has no ISRC or Filename — cannot key the CMS 2024 record uniquely' })
    }

    const result = await upsertCms2024Record(fd, queries, { layout })
    res.json({
      ok: true,
      ...result,
      gallo_record_id: track.fm_record_id,
      catalogue_no:    track.catalogue_no,
      isrc:            track.isrc,
      filename:        track.filename,
    })
  } catch (err) {
    console.error('[CMS 2024 push-from-gallo]', err)
    res.status(502).json({ error: err.message })
  }
})

// Bulk push every track on a catalogue from Gallo Catalogue → CMS 2024.
// Body: { catalogue_no, layout? }
router.post('/cms2024/push-catalogue-from-gallo', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, layout } = req.body || {}
  if (!catalogue_no) return res.status(400).json({ error: 'catalogue_no required' })

  try {
    const tracks = await findGalloRecordsByCatalogue(catalogue_no)
    if (!tracks.length) return res.status(404).json({ error: `No Gallo tracks for catalogue ${catalogue_no}` })

    const results = []
    let succeeded = 0, failed = 0
    for (const t of tracks) {
      try {
        const fd = {}
        // Song Files-aware field map — send both singular and plural variants;
        // the introspection filter drops whichever the layout doesn't have.
        if (t.title)         fd['Track Name']                  = t.title
        if (t.title)         fd['Song Title']                  = t.title
        if (t.artist_name)   fd['Track Artist']                = t.artist_name
        if (t.album_artist)  fd['Album Artist']                = t.album_artist
        if (t.album_title)   fd['Album Title']                 = t.album_title
        if (t.catalogue_no)  { fd['Album Catalogue Number']     = t.catalogue_no
                               fd['Reference Catalogue Number'] = t.catalogue_no }
        if (t.isrc)            fd['ISRC']                        = t.isrc
        if (t.barcode)       fd['UPC']                         = String(t.barcode)
        if (t.sequence_no != null) { fd['Track Number']         = Number(t.sequence_no)
                                     fd['Sequence Number']      = String(t.sequence_no) }
        if (t.year) {        fd['Year of Release']             = String(t.year)
                             fd['Year']                        = String(t.year) }
        if (t.genre) {       fd['Genre']                       = t.genre
                             fd['Local Genre']                 = t.genre }
        if (t.language) {
          fd['Language'] = t.language
          const iso = t.language.length <= 3
            ? t.language
            : languageNameToCode(t.language)
          if (iso) fd['Language Code'] = iso
        }
        if (t.duration_sec)  fd['Duration']                    = _durationForFm(t.duration_sec)
        if (t.s3_url) {      fd['File URL']                    = t.s3_url
                             fd['S3_URL']                      = t.s3_url }
        if (t.artwork_url)   fd['Artwork URL']                 = t.artwork_url
        if (t.wav_filename)  fd['Filename']                    = t.wav_filename

        const queries = []
        if (t.isrc)         queries.push({ 'ISRC':     `==${t.isrc}` })
        if (t.wav_filename) queries.push({ 'Filename': `==${t.wav_filename}` })
        if (!queries.length) {
          failed++
          results.push({ ok: false, gallo_record_id: t.fm_record_id, error: 'No ISRC or Filename for uniqueness key' })
          continue
        }

        const r = await upsertCms2024Record(fd, queries, { layout })
        succeeded++
        results.push({ ok: true, gallo_record_id: t.fm_record_id, ...r })
      } catch (err) {
        failed++
        console.error(`[push-catalogue-from-gallo] track failed — gallo_record_id=${t.fm_record_id} isrc=${t.isrc || '-'}: ${err.message}`)
        results.push({ ok: false, gallo_record_id: t.fm_record_id, error: err.message })
      }
    }
    res.json({ ok: true, catalogue_no, total: tracks.length, succeeded, failed, results })
  } catch (err) {
    console.error('[CMS 2024 push-catalogue-from-gallo]', err)
    res.status(502).json({ error: err.message })
  }
})

// Pull from CMS 2024 → Gallo Catalogue. Looks up a track on CMS 2024 by
// ISRC / catalogue+sequence, then PATCHes the corresponding Gallo record.
// Body: { isrc?, catalogue_no?, sequence_no?, fields?: string[], layout? }
//   fields  — optional whitelist of CMS 2024 field names to copy over.
//             If omitted, copies a sensible default set.
router.post('/cms2024/pull-to-gallo', adminAuth, express.json(), async (req, res) => {
  const { isrc, catalogue_no, sequence_no, fields, layout } = req.body || {}
  if (!isrc && !catalogue_no) {
    return res.status(400).json({ error: 'Provide isrc, or catalogue_no (and ideally sequence_no)' })
  }
  try {
    // 1. Find on CMS 2024.
    const query = isrc
      ? { 'ISRC': `==${isrc}` }
      : (sequence_no != null
          ? { 'Album Catalogue Number': `==${catalogue_no}`, 'Sequence Number': `==${sequence_no}` }
          : { 'Album Catalogue Number': `==${catalogue_no}` })
    const cmsRec = await findCms2024Record(query, { layout })
    if (!cmsRec) return res.status(404).json({ error: 'No matching CMS 2024 record' })
    const mapped = mapCms2024Record(cmsRec)

    // 2. Find the Gallo Catalogue record — prefer ISRC, fall back to cat+seq.
    const galloTrack = await getGalloTrack({
      catalogue_no: catalogue_no   || mapped.catalogue_no,
      sequence_no:  sequence_no    ?? mapped.sequence_no,
      isrc:         isrc           || mapped.isrc,
    })
    if (!galloTrack) return res.status(404).json({ error: 'No matching Gallo Catalogue record' })

    // 3. Decide which Gallo fields to write. The keys here are *Gallo* field
    //    names — translating from mapped CMS 2024 values.
    const defaultMap = {
      'Track Name':              mapped.title,
      'Track Artist':            mapped.artist_name,
      'Album Title':             mapped.album_title,
      'ISRC':                    mapped.isrc,
      'Barcode':                 mapped.barcode,
      'Sequence Number':         mapped.sequence_no != null ? String(mapped.sequence_no) : null,
      'Year of Release':         mapped.year,
      'Release Date':            mapped.release_date,
      'Genre':                   mapped.genre,
      'Language':                mapped.language,
      'Duration':                _durationForFm(mapped.duration_sec ?? mapped.duration),
      'Composers':               _flatten(mapped.composers),
      'Producers':               _flatten(mapped.producers),
      'Publishers':              _flatten(mapped.publishers),
      'Label':                   mapped.label,
      'pLine':                   mapped.p_line,
      'cLine':                   mapped.c_line,
    }

    const writePayload = {}
    if (Array.isArray(fields) && fields.length) {
      for (const f of fields) {
        if (defaultMap[f] != null && defaultMap[f] !== '') writePayload[f] = defaultMap[f]
      }
    } else {
      for (const [k, v] of Object.entries(defaultMap)) {
        if (v != null && v !== '') writePayload[k] = v
      }
    }
    if (!Object.keys(writePayload).length) {
      return res.status(400).json({ error: 'Nothing to write — all source values were empty' })
    }

    await updateGalloRecord(galloTrack.fm_record_id, writePayload)
    res.json({
      ok: true,
      gallo_record_id: galloTrack.fm_record_id,
      cms2024_record_id: cmsRec.recordId,
      fields_written: Object.keys(writePayload),
    })
  } catch (err) {
    console.error('[CMS 2024 pull-to-gallo]', err)
    res.status(502).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
//  3-DB status & cross-DB copy (catalogue-driven workflow).
//
//  Primary admin workflow: given a catalogue number, check which of the three
//  databases already has its tracks, then copy from a source DB to whichever
//  is missing. CMS 2024 is treated as read-only in the primary flow — copies
//  go FROM 2024 (to Gallo / Streamer), never the other way.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/ingest/catalogue/:catNo/status
 * Reports presence across Gallo Catalogue, Gallo CMS 2024, and MadStreamer.
 * Track-level matrix lets the UI show "track 3 missing from Streamer" etc.
 *
 *   { catalogue_no, counts: { gallo, cms2024, streamer },
 *     gallo:   { count, tracks: [...] },
 *     cms2024: { count, tracks: [...] },
 *     streamer:{ count, tracks: [...] },
 *     matrix:  [{ sequence_no, isrc, title, in_gallo, in_cms2024, in_streamer }]
 *   }
 */
router.get('/catalogue/:catNo/status', adminAuth, async (req, res) => {
  const catalogueNo = req.params.catNo
  if (!catalogueNo) return res.status(400).json({ error: 'catalogue_no required' })

  // Hit all three DBs in parallel; one failure shouldn't sink the whole check
  const [galloRes, cmsRes, streamerRes] = await Promise.allSettled([
    findGalloRecordsByCatalogue(catalogueNo),
    findCms2024RecordsByCatalogue(catalogueNo),
    findStreamerRecordsByCatalogue(catalogueNo),
  ])

  function summary(s) {
    if (s.status === 'fulfilled') return { ok: true,  tracks: s.value, count: s.value.length, error: null }
    return                              { ok: false, tracks: [],       count: 0,              error: s.reason?.message || String(s.reason) }
  }
  const gallo    = summary(galloRes)
  const cms2024  = summary(cmsRes)
  const streamer = summary(streamerRes)

  // Also pull rows for this catalogue out of the preloaded
  // Gallo_Metadata_Extract.xlsx cache. Used to backfill missing ISRCs and
  // surface tracks that exist in the spreadsheet but in none of the FM DBs.
  const metaTracks = lookupAlbumTracks(catalogueNo) || []
  const metadata = { ok: true, count: metaTracks.length, tracks: metaTracks }

  // Build the per-track matrix. Key on ISRC where possible; fall back to
  // sequence number + filename. The three DBs use slightly different track
  // shapes but all expose isrc / sequence_no / title / artist.
  // Multi-key merge: each track can match an existing row by ISRC OR by
  // normalised filename (strip extension, lowercase). This handles the common
  // case where Gallo's record predates ISRC assignment but the GMV asset
  // number is the same across all three DBs. Without this, Gallo's
  // "GMVE12345.wav" and CMS 2024's "GMVE12345" come in as separate rows.
  function _normFilename(f) {
    if (!f) return null
    return String(f).trim().toLowerCase().replace(/\.[^.]+$/, '')
  }
  function _firstFilename(t) {
    return t.filename || t.wav_filename || t.asset_number || null
  }
  const byIsrc      = new Map()
  const byFilename  = new Map()
  const allRows     = []
  function add(track, db) {
    const isrc  = track.isrc ? String(track.isrc).trim().toUpperCase() : null
    const fname = _normFilename(_firstFilename(track))
    const seq   = track.sequence_no ?? null
    const title = track.title || track.title_name || null
    // Look up an existing row by any shared identifier.
    let row = (isrc  && byIsrc.get(isrc))
           || (fname && byFilename.get(fname))
           || null
    // Fallback for legacy tracks with no ISRC and no filename: match by
    // sequence_no + fuzzy title within this catalogue. Sequence is unique
    // per DB within a catalogue, so a seq + 70% title similarity is a
    // confident merge signal. Stops "track 1 / Vhaloi" appearing once for
    // Gallo and again for CMS 2024.
    if (!row && seq != null && title) {
      let bestRow = null, bestScore = 0
      for (const candidate of allRows) {
        if (candidate.sequence_no !== seq) continue
        const score = _fuzzyScore(candidate.title || '', title)
        if (score > bestScore && score >= _FUZZY_TITLE_THRESHOLD) {
          bestScore = score
          bestRow = candidate
        }
      }
      row = bestRow
    }
    if (!row) {
      row = {
        key:           isrc || (fname && `f:${fname}`) || `seq:${track.sequence_no ?? '?'}:${(track.title || '').toLowerCase()}`,
        isrc:          null,
        title:         null,
        artist:        null,
        sequence_no:   null,
        filename:      null,
        in_gallo:      false,
        in_cms2024:    false,
        in_streamer:   false,
        in_metadata:   false,
        gallo_id:      null,
        cms2024_id:    null,
        streamer_id:   null,
        metadata_isrc: null,
      }
      allRows.push(row)
    }
    // Re-index this row under whatever identifiers we have now, so later
    // tracks can find it via either ISRC or filename.
    if (isrc)  byIsrc.set(isrc, row)
    if (fname) byFilename.set(fname, row)

    row[`in_${db}`] = true
    row[`${db}_id`] = track.fm_record_id || track.recordId || null
    row.isrc        ||= isrc
    row.title       ||= track.title || track.title_name || null
    row.artist      ||= track.artist || track.artist_name || null
    row.sequence_no  ??= track.sequence_no ?? null
    row.filename    ||= _firstFilename(track) || null
  }
  for (const t of gallo.tracks)    add(t, 'gallo')
  for (const t of cms2024.tracks)  add(t, 'cms2024')
  for (const t of streamer.tracks) add(t, 'streamer')

  // Fold metadata-cache rows into the matrix. Strategy:
  //   1. Try ISRC exact match first (always reliable when present).
  //   2. Fall back to sequence_no + fuzzy title (Levenshtein-based) — used
  //      when Gallo records pre-date ISRC assignment but the spreadsheet
  //      has them.
  //   3. If neither matches, the metadata row is appended as a new matrix
  //      entry tagged in_metadata=true. Surfaces tracks that the catalogue
  //      should have but FM doesn't.
  for (const m of metaTracks) {
    const isrc = m.isrc ? String(m.isrc).trim().toUpperCase() : null
    let row = isrc ? byIsrc.get(isrc) : null
    if (!row) {
      // Sequence + fuzzy title match against existing rows
      let bestRow = null
      let bestScore = 0
      for (const candidate of allRows) {
        if (candidate.sequence_no == null || m.seq == null) continue
        if (candidate.sequence_no !== m.seq) continue
        const score = _fuzzyScore(candidate.title || '', m.track_name || '')
        if (score > bestScore && score >= _FUZZY_TITLE_THRESHOLD) {
          bestScore = score
          bestRow   = candidate
        }
      }
      row = bestRow
    }
    if (!row) {
      // No FM match — this track exists in the spreadsheet but in none of
      // the three FM DBs. Surface it so the user can see the gap.
      row = {
        key:           isrc || `meta:seq:${m.seq ?? '?'}:${_normTitle(m.track_name || '')}`,
        isrc:          null,
        title:         null,
        artist:        null,
        sequence_no:   null,
        filename:      null,
        in_gallo:      false,
        in_cms2024:    false,
        in_streamer:   false,
        in_metadata:   false,
        gallo_id:      null,
        cms2024_id:    null,
        streamer_id:   null,
        metadata_isrc: null,
      }
      allRows.push(row)
    }
    if (isrc) byIsrc.set(isrc, row)
    row.in_metadata    = true
    row.metadata_isrc  = isrc || null
    // Backfill — ISRC is the most valuable since the matrix's ISRC column
    // often blank when Gallo records lack one.
    row.isrc        ||= isrc
    row.title       ||= m.track_name  || null
    row.artist      ||= m.track_artist || m.album_artist || null
    row.sequence_no  ??= m.seq ?? null
  }

  const matrixArr = allRows.sort((a, b) =>
    (a.sequence_no ?? 999) - (b.sequence_no ?? 999)
  )

  res.json({
    catalogue_no: catalogueNo,
    counts:       {
      gallo:    gallo.count,
      cms2024:  cms2024.count,
      streamer: streamer.count,
      metadata: metadata.count,
    },
    gallo,
    cms2024,
    streamer,
    metadata,
    matrix:       matrixArr,
  })
})

/**
 * POST /api/ingest/cms2024/pull-catalogue-to-gallo
 * Body: { catalogue_no, fields?, layout? }
 *
 * For every CMS 2024 track on this catalogue:
 *   • Look up the matching Gallo Catalogue record (by ISRC, then cat+seq).
 *   • If found → PATCH the listed Gallo fields with values from CMS 2024.
 *   • If not found → CREATE a new Gallo record (createGalloRecord) using the
 *     CMS 2024 values.
 *
 * Returns per-track results with action ∈ { 'updated', 'created', 'skipped' }.
 */
/**
 * Core pull-catalogue-to-gallo logic, shared by POST + SSE endpoints.
 */
async function _runPullCatalogueToGallo({ catalogue_no, fields, layout, log, warn }) {
  if (!catalogue_no) throw Object.assign(new Error('catalogue_no required'), { status: 400 })

  log(`Looking up CMS 2024 tracks for ${catalogue_no}…`)
  const cmsTracks = await findCms2024RecordsByCatalogue(catalogue_no, { layout })
  if (!cmsTracks.length) {
    throw Object.assign(new Error(`No CMS 2024 tracks for catalogue ${catalogue_no}`), { status: 404 })
  }
  log(`Found ${cmsTracks.length} tracks on CMS 2024`)

  const galloExisting = await findGalloRecordsByCatalogue(catalogue_no)
  log(`Gallo Catalogue has ${galloExisting.length} matching records (will UPDATE; missing tracks will be CREATED)`)
  const byIsrc = new Map(galloExisting.filter(t => t.isrc).map(t => [t.isrc, t]))
  const bySeq  = new Map(galloExisting.filter(t => t.sequence_no != null).map(t => [t.sequence_no, t]))

  let succeeded = 0, failed = 0
  const results = []
  for (const c of cmsTracks) {
    const label = `seq ${c.sequence_no ?? '?'} "${c.title || '(no title)'}"`
    try {
      const fullMap = {
        'Track Name':              c.title,
        'Track Artist':            c.artist_name,
        'Album Artist':            c.album_artist,
        'Album Title':             c.album_title,
        'ISRC':                    c.isrc,
        'Barcode':                 c.barcode,
        'Sequence Number':         c.sequence_no != null ? String(c.sequence_no) : null,
        'Year of Release':         c.year,
        'Release Date':            c.release_date,
        'Genre':                   c.genre,
        'Language':                c.language,
        'Duration':                _durationForFm(c.duration_sec ?? c.duration),
        'Composers':               _flatten(c.composers),
        'Producers':               _flatten(c.producers),
        'Publishers':              _flatten(c.publishers),
        'Label':                   c.label,
        'pLine':                   c.p_line,
        'cLine':                   c.c_line,
      }
      const writePayload = {}
      const allow = Array.isArray(fields) && fields.length ? new Set(fields) : null
      for (const [k, v] of Object.entries(fullMap)) {
        if (v == null || v === '') continue
        if (allow && !allow.has(k)) continue
        writePayload[k] = v
      }

      const galloMatch = (c.isrc && byIsrc.get(c.isrc))
                      || (c.sequence_no != null && bySeq.get(c.sequence_no))
                      || null

      if (galloMatch) {
        if (!Object.keys(writePayload).length) {
          log(`  ↷ ${label}: nothing-to-write (already up to date)`)
          results.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: 'skipped',
                         gallo_record_id: galloMatch.fm_record_id, reason: 'nothing-to-write' })
          succeeded++
          continue
        }
        await updateGalloRecord(galloMatch.fm_record_id, writePayload)
        succeeded++
        log(`  ✓ ${label}: updated Gallo rec ${galloMatch.fm_record_id} (${Object.keys(writePayload).length} fields)`)
        results.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: 'updated',
                       gallo_record_id: galloMatch.fm_record_id,
                       fields_written: Object.keys(writePayload) })
      } else {
        const created = await createGalloRecord(_galloMetadataFromCms(c, catalogue_no))
        succeeded++
        log(`  ✓ ${label}: created Gallo rec ${created.fmRecordId}`)
        results.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: 'created',
                       gallo_record_id: created.fmRecordId })
      }
    } catch (err) {
      failed++
      warn(`${label}: ${err.message}`)
      results.push({ ok: false, isrc: c.isrc, sequence_no: c.sequence_no, error: err.message })
    }
  }

  let tape = null
  if (galloExisting.length === 0 && cmsTracks.length) {
    try {
      tape = await createTapeFileRecord(_galloTapeMetadataFromCms(cmsTracks[0], catalogue_no))
      log(`  ✓ Gallo Tape Files Master record created (album was new)`)
    } catch (err) {
      warn(`Gallo Tape Files create failed: ${err.message}`)
      tape = { error: err.message }
    }
  }
  log(`✓ Pull complete — ${succeeded}/${cmsTracks.length} succeeded${failed ? `, ${failed} failed` : ''}`)
  return { ok: true, catalogue_no, total: cmsTracks.length, succeeded, failed, tape, results }
}

router.post('/cms2024/pull-catalogue-to-gallo', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, fields, layout } = req.body || {}
  const noop = () => {}
  try {
    const result = await _runPullCatalogueToGallo({ catalogue_no, fields, layout, log: noop, warn: noop })
    res.json(result)
  } catch (err) {
    console.error('[CMS 2024 pull-catalogue-to-gallo]', err)
    res.status(err.status || 502).json({ error: err.message })
  }
})

router.get('/cms2024/pull-catalogue-to-gallo-stream', (req, res) => {
  const catalogue_no = (req.query.catalogue_no || '').toString().trim()
  const layout = req.query.layout
  let fields
  if (req.query.fields) { try { fields = JSON.parse(req.query.fields) } catch { /* ignore */ } }
  if (!catalogue_no) return res.status(400).end('catalogue_no required')
  _sseStreamRunner({ req, res, runner: ({ log, warn }) =>
    _runPullCatalogueToGallo({ catalogue_no, fields, layout, log, warn })
  })
})

/**
 * POST /api/ingest/cms2024/push-catalogue-to-streamer
 * Body: { catalogue_no, layout? }
 *
 * Metadata-only sync from CMS 2024 → MadStreamer for every track on the
 * catalogue. Mirrors the existing /madstreamer/sync-metadata-by-catalogue
 * but uses CMS 2024 as the source instead of Gallo.
 *
 * No audio transcoding / S3 work — that path is owned by the Gallo→Streamer
 * push because Gallo has the WAV URLs. For audio, route via Gallo.
 */
/**
 * Core push-catalogue-to-streamer logic, shared by POST + SSE endpoints.
 */
async function _runPushCatalogueToStreamer({ catalogue_no, layout, log, warn }) {
  if (!catalogue_no) throw Object.assign(new Error('catalogue_no required'), { status: 400 })

  log(`Looking up CMS 2024 tracks for ${catalogue_no}…`)
  const cmsTracks = await findCms2024RecordsByCatalogue(catalogue_no, { layout })
  if (!cmsTracks.length) {
    throw Object.assign(new Error(`No CMS 2024 tracks for catalogue ${catalogue_no}`), { status: 404 })
  }
  log(`Pushing ${cmsTracks.length} tracks to MadStreamer (metadata only)…`)

  let succeeded = 0, failed = 0
  const results = []
  for (const c of cmsTracks) {
    const label = `seq ${c.sequence_no ?? '?'} "${c.title || '(no title)'}"`
    try {
      const fm = await upsertMp3Record(_streamerMetadataFromCms(c, catalogue_no))
      succeeded++
      log(`  ✓ ${label}: ${fm.action} streamer rec ${fm.recordId}`)
      results.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: fm.action,
                     streamer_record_id: fm.recordId, dropped: fm.dropped })
    } catch (err) {
      failed++
      warn(`${label}: ${err.message}`)
      results.push({ ok: false, isrc: c.isrc, sequence_no: c.sequence_no, error: err.message })
    }
  }

  let tape = null
  if (cmsTracks.length) {
    try {
      tape = await upsertTapeFileRecord(_streamerTapeMetadataFromCms(cmsTracks[0], catalogue_no))
      log(`  ✓ MadStreamer Tape Files Master ${tape.action || 'upserted'}`)
    } catch (err) {
      warn(`MadStreamer Tape Files upsert failed: ${err.message}`)
      tape = { error: err.message }
    }
  }
  log(`✓ Push complete — ${succeeded}/${cmsTracks.length} succeeded${failed ? `, ${failed} failed` : ''}`)
  return { ok: true, catalogue_no, total: cmsTracks.length, succeeded, failed, tape, results }
}

router.post('/cms2024/push-catalogue-to-streamer', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, layout } = req.body || {}
  const noop = () => {}
  try {
    const result = await _runPushCatalogueToStreamer({ catalogue_no, layout, log: noop, warn: noop })
    res.json(result)
  } catch (err) {
    console.error('[CMS 2024 push-catalogue-to-streamer]', err)
    res.status(err.status || 502).json({ error: err.message })
  }
})

router.get('/cms2024/push-catalogue-to-streamer-stream', (req, res) => {
  const catalogue_no = (req.query.catalogue_no || '').toString().trim()
  const layout = req.query.layout
  if (!catalogue_no) return res.status(400).end('catalogue_no required')
  _sseStreamRunner({ req, res, runner: ({ log, warn }) =>
    _runPushCatalogueToStreamer({ catalogue_no, layout, log, warn })
  })
})

/**
 * POST /api/ingest/cms2024/ensure-catalogue-replicated
 * Body: { catalogue_no, replicate_to?: ['gallo','streamer'], force?: false }
 *
 * High-level wrapper: makes sure the catalogue exists on whichever of Gallo
 * Catalogue / MadStreamer is missing, using CMS 2024 as the source. Used by
 * the Generate-DDEX-from-2024 flow so we never generate a DDEX for a
 * catalogue that the other DBs don't know about.
 *
 *   • If `force=false` (default), each DB is only replicated to when it
 *     currently has ZERO tracks for the catalogue. Existing tracks are left
 *     alone (use /pull-catalogue-to-gallo or /push-catalogue-to-streamer
 *     directly for incremental sync).
 *   • `replicate_to` lets the caller restrict the operation, e.g. `['gallo']`.
 *
 * Returns a per-DB summary: { gallo: {action,...}, streamer: {action,...} }.
 */
/**
 * Core ensure-catalogue-replicated logic, shared by POST + SSE endpoints.
 * Per-track progress and album-level summaries are emitted via log/warn so
 * the SSE caller can stream them to the admin UI in real time.
 */
async function _runEnsureReplicated({ catalogue_no, replicate_to, force = false, layout, log, warn }) {
  if (!catalogue_no) {
    throw Object.assign(new Error('catalogue_no required'), { status: 400 })
  }
  const targets = new Set(
    (Array.isArray(replicate_to) && replicate_to.length ? replicate_to : ['gallo', 'streamer'])
      .map(s => String(s).toLowerCase())
  )

  log(`Looking up CMS 2024 tracks for ${catalogue_no}…`)
  const cmsTracks = await findCms2024RecordsByCatalogue(catalogue_no, { layout })
  if (!cmsTracks.length) {
    throw Object.assign(new Error(`No CMS 2024 tracks for catalogue ${catalogue_no}`), { status: 404 })
  }
  log(`Source: ${cmsTracks.length} tracks on CMS 2024`)
  const first = cmsTracks[0]

  const [galloExisting, streamerExisting] = await Promise.all([
    targets.has('gallo')    ? findGalloRecordsByCatalogue(catalogue_no).catch(e => { throw new Error('Gallo lookup: ' + e.message) })    : Promise.resolve([]),
    targets.has('streamer') ? findStreamerRecordsByCatalogue(catalogue_no).catch(e => { throw new Error('Streamer lookup: ' + e.message) }) : Promise.resolve([]),
  ])
  if (targets.has('gallo'))    log(`Gallo Catalogue currently has ${galloExisting.length} records for ${catalogue_no}`)
  if (targets.has('streamer')) log(`MadStreamer currently has ${streamerExisting.length} records for ${catalogue_no}`)

  const result = { catalogue_no, source: 'cms2024', cms2024: { count: cmsTracks.length }, gallo: null, streamer: null }

  // Gallo Catalogue replication
  if (targets.has('gallo')) {
    if (galloExisting.length && !force) {
      log(`Gallo: skipping (already present — ${galloExisting.length} tracks)`)
      result.gallo = { action: 'skipped', reason: 'already_present', count: galloExisting.length }
    } else {
      log(`Gallo: replicating ${cmsTracks.length} tracks…`)
      const trackResults = []
      let succeeded = 0, failed = 0
      for (const c of cmsTracks) {
        const label = `seq ${c.sequence_no ?? '?'} "${c.title || '(no title)'}"`
        try {
          const created = await createGalloRecord(_galloMetadataFromCms(c, catalogue_no))
          succeeded++
          log(`  ✓ Gallo ${label} → rec ${created.fmRecordId}`)
          trackResults.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: 'created', gallo_record_id: created.fmRecordId })
        } catch (err) {
          failed++
          warn(`Gallo ${label} failed: ${err.message}`)
          trackResults.push({ ok: false, isrc: c.isrc, sequence_no: c.sequence_no, error: err.message })
        }
      }
      let tape = null
      try {
        tape = await createTapeFileRecord(_galloTapeMetadataFromCms(first, catalogue_no))
        log(`  ✓ Gallo Tape Files Master record created`)
      } catch (err) {
        warn(`Gallo Tape Files create failed: ${err.message}`)
        tape = { error: err.message }
      }
      result.gallo = { action: 'replicated', total: cmsTracks.length, succeeded, failed, tape, results: trackResults }
    }
  }

  // MadStreamer replication (metadata-only)
  if (targets.has('streamer')) {
    if (streamerExisting.length && !force) {
      log(`MadStreamer: skipping (already present — ${streamerExisting.length} tracks)`)
      result.streamer = { action: 'skipped', reason: 'already_present', count: streamerExisting.length }
    } else {
      log(`MadStreamer: replicating ${cmsTracks.length} tracks…`)
      const trackResults = []
      let succeeded = 0, failed = 0
      for (const c of cmsTracks) {
        const label = `seq ${c.sequence_no ?? '?'} "${c.title || '(no title)'}"`
        try {
          const fm = await upsertMp3Record(_streamerMetadataFromCms(c, catalogue_no))
          succeeded++
          log(`  ✓ Streamer ${label} → ${fm.action} rec ${fm.recordId}`)
          trackResults.push({ ok: true, isrc: c.isrc, sequence_no: c.sequence_no, action: fm.action, streamer_record_id: fm.recordId, dropped: fm.dropped })
        } catch (err) {
          failed++
          warn(`Streamer ${label} failed: ${err.message}`)
          trackResults.push({ ok: false, isrc: c.isrc, sequence_no: c.sequence_no, error: err.message })
        }
      }
      let tape = null
      try {
        tape = await upsertTapeFileRecord(_streamerTapeMetadataFromCms(first, catalogue_no))
        log(`  ✓ MadStreamer Tape Files Master ${tape.action || 'upserted'}`)
      } catch (err) {
        warn(`MadStreamer Tape Files upsert failed: ${err.message}`)
        tape = { error: err.message }
      }
      result.streamer = { action: 'replicated', total: cmsTracks.length, succeeded, failed, tape, results: trackResults }
    }
  }
  log('✓ Replication complete')
  return { ok: true, ...result }
}

// JSON wrapper (preserves existing API for non-streaming clients)
router.post('/cms2024/ensure-catalogue-replicated', adminAuth, express.json(), async (req, res) => {
  const { catalogue_no, replicate_to, force, layout } = req.body || {}
  const noop = () => {}
  try {
    const result = await _runEnsureReplicated({
      catalogue_no, replicate_to, force, layout, log: noop, warn: noop,
    })
    res.json(result)
  } catch (err) {
    console.error('[CMS 2024 ensure-catalogue-replicated]', err)
    res.status(err.status || 502).json({ error: err.message })
  }
})

// Server-Sent Events wrapper — streams progress to the admin UI live.
router.get('/cms2024/ensure-catalogue-replicated-stream', (req, res) => {
  const catalogue_no = (req.query.catalogue_no || '').toString().trim()
  const force        = req.query.force === 'true' || req.query.force === '1'
  const layout       = req.query.layout
  const replicate_to = req.query.replicate_to ? req.query.replicate_to.split(',') : undefined
  if (!catalogue_no) return res.status(400).end('catalogue_no required')

  _sseStreamRunner({ req, res, runner: ({ log, warn }) =>
    _runEnsureReplicated({ catalogue_no, replicate_to, force, layout, log, warn })
  })
})

/**
 * Merge file references (audio container / S3 URL / artwork container / artwork URL)
 * from Gallo Catalogue onto a list of CMS-2024 tracks for the same catalogue.
 *
 * Why: when DDEX is generated from CMS 2024 we still rely on Gallo for the
 * actual binary files. Filenames are identical across all three databases
 * (Gallo was derived from CMS 2024), so ISRC / Filename / sequence are
 * reliable join keys.
 *
 * CMS 2024's own containers are tried first (via mapCms2024Record); this only
 * fills gaps. Returns a NEW array; the input is not mutated.
 */
async function _hydrateFromGallo(cmsTracks, catalogueNo) {
  let galloTracks = []
  try {
    galloTracks = await findGalloRecordsByCatalogue(catalogueNo)
  } catch (e) {
    console.warn(`[hydrate] Gallo lookup failed for ${catalogueNo}: ${e.message} — proceeding without hydration`)
    return cmsTracks
  }
  if (!galloTracks.length) {
    console.warn(`[hydrate] No Gallo records for ${catalogueNo} — file references can't be hydrated`)
    return cmsTracks
  }

  // Index Gallo by ISRC / filename / sequence_no for cheap lookup
  const byIsrc     = new Map()
  const byFilename = new Map()
  const bySeq      = new Map()
  for (const g of galloTracks) {
    if (g.isrc)           byIsrc.set(String(g.isrc).trim().toUpperCase(),     g)
    const f = g.wav_filename || g.asset_number
    if (f)                byFilename.set(_stripExt(String(f).trim()),         g)
    if (g.sequence_no != null) bySeq.set(g.sequence_no, g)
  }

  // Album-level artwork on Gallo — first Gallo record that has one wins.
  // Used to backfill any CMS 2024 track that doesn't have artwork on its own
  // record (common because artwork is usually attached at the album level).
  const albumArtContainer = galloTracks.find(g => g.artwork_container_url)?.artwork_container_url || null
  const albumArtUrl       = galloTracks.find(g => g.artwork_url)?.artwork_url                     || null

  let hits = 0, misses = 0, audioFilled = 0, artFilled = 0
  const hydrated = cmsTracks.map(c => {
    const key = c.isrc ? String(c.isrc).trim().toUpperCase() : null
    const fnk = c.filename ? _stripExt(String(c.filename).trim()) : null
    const g   = (key && byIsrc.get(key))
             || (fnk && byFilename.get(fnk))
             || (c.sequence_no != null && bySeq.get(c.sequence_no))
             || null
    if (!g) { misses++; return c }
    hits++

    const newAudio = !c.audio_container_url && !c.s3_url
                     && !!(g.audio_container_url || g.s3_url)
    const newArt   = !c.artwork_container_url && !c.artwork_url
                     && !!(g.artwork_container_url || g.artwork_url || albumArtContainer || albumArtUrl)
    if (newAudio) audioFilled++
    if (newArt)   artFilled++

    return {
      ...c,
      audio_container_url:   c.audio_container_url   || g.audio_container_url   || null,
      s3_url:                c.s3_url                || g.s3_url                || null,
      audio_url:             c.audio_url             || g.s3_url                || null,
      artwork_container_url: c.artwork_container_url || g.artwork_container_url || albumArtContainer || null,
      artwork_url:           c.artwork_url           || g.artwork_url           || albumArtUrl       || null,
      asset_number:          c.asset_number          || g.asset_number          || null,
      wav_filename:          c.wav_filename          || g.wav_filename          || null,
      image_asset_number:    c.image_asset_number    || g.image_asset_number    || null,
      _hydrated_from_gallo:  true,
      _gallo_record_id:      g.fm_record_id || null,
    }
  })
  console.log(
    `[hydrate ${catalogueNo}] matched ${hits}/${cmsTracks.length} Gallo records ` +
    `(${misses} miss). Filled audio refs on ${audioFilled}, artwork refs on ${artFilled}.`
  )
  return hydrated
}

function _stripExt(s) {
  return String(s || '').replace(/\.[^.]+$/, '')
}

export default router
