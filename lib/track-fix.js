/**
 * lib/track-fix.js — one track, side by side in every database, fixed by hand.
 *
 * The 3-DB status matrix says WHERE a track is missing; this says WHAT each
 * database holds for it and lets a person write exactly the values they chose
 * into exactly one database at a time. Nothing here decides on its own:
 *
 *   readTrack()  — the same track in Gallo, CMS 2024, MadStreamer, MAM and the
 *                  metadata extract, located by the record ids the matrix already
 *                  matched, else ISRC, else Filename (never title or sequence —
 *                  two tracks on one album can share a title; SSCD 507 does).
 *   applyFix()   — create or update ONE record in Gallo, MadStreamer or MAM with
 *                  the values sent. CMS 2024 and the metadata extract are read-only.
 *
 * Safety: a create is refused when the database already holds this ISRC or
 * Filename in the catalogue; an update is refused when the record changed since
 * it was shown; an MP3 link must point at the track's own Filename and exist in
 * S3. Every write is appended to tmp/track-fix-journal.jsonl with the old values.
 */
import fs from 'node:fs'
import path from 'node:path'
import { findGalloRawByCatalogue, updateGalloRecord, createGalloRawRecord } from './fm-gallo.js'
import { findRecordsByCatalogue as findStreamerByCatalogue, writeSongRaw } from './madstreamer.js'
import { findMamTracksByCatalogue, updateMamSong } from './fm-mam.js'
import { mamSession, makeIdAllocator } from './fm-mam-write.js'
import { findRecordsByCatalogue as findCmsByCatalogue } from './fm-cms2024.js'
import { lookupAlbumTracks, getStatus as metadataStatus } from './metadata-cache.js'
import { mamComposerFields } from './credits.js'

export const DBS = ['gallo', 'cms2024', 'streamer', 'mam', 'metadata']
export const WRITABLE = new Set(['gallo', 'streamer', 'mam'])

// Track-level fields. Per database: the field names it uses (first = the one
// written). `meta` is the metadata-extract key; `cms` the mapped CMS 2024 key.
const F = (key, label, names, extra = {}) => ({ key, label, gallo: names, streamer: names, mam: names, ...extra })
export const FIELDS = [
  F('title',     'Title',          ['Track Name'], { gallo: ['Track Name', 'Song Title'], cms: 'title', meta: 'track_name' }),
  F('version',   'Version',        ['Version'],    { cms: 'version_title' }),
  F('artist',    'Track artist',   ['Track Artist'], { cms: 'artist_name', meta: 'track_artist' }),
  F('isrc',      'ISRC',           ['ISRC'],       { cms: 'isrc', meta: 'isrc' }),
  F('seq',       'Track number',   ['Sequence Number'], { mam: ['Sequence Number', 'Track Number'], cms: 'sequence_no', meta: 'seq' }),
  F('duration',  'Duration',       ['Duration'],   { cms: 'duration', meta: 'duration', kind: 'duration' }),
  F('filename',  'Filename (GCAT)', ['Filename'],  { cms: 'wav_filename', kind: 'audio' }),
  F('mp3',       'MP3 link (S3)',  null,           { streamer: ['S3_URL'], mam: ['Audio_S3_URL'], kind: 'audio' }),
  F('vision',    'Vision WAV path', null,          { gallo: ['Audio_URL'], mam: ['Audio_Vision_URL'], kind: 'audio' }),
  F('hash',      'Audio hash',     ['AudioHashSum'], { cms: 'audio_hash_md5', kind: 'audio' }),
  F('composers', 'Composers',      ['Composers'],  { meta: 'composer' }),
  F('publishers','Publishers',     ['Publishers'], { meta: 'publisher' }),
  F('genre',     'Genre',          ['Genre'],      { cms: 'genre', meta: 'genre' }),
  F('local_genre','Local genre',   ['Local Genre']),
  F('language',  'Language',       ['Language'],   { meta: 'language' }),
  F('language_code','Language code', ['Language Code']),
  F('parental',  'Explicit rating', ['Lyrical Content Rating'], { meta: 'parental' }),
  F('pline',     '℗ line',          ['pLine'],      { meta: 'p_line' }),
  F('cline',     '© line',          ['cLine'],      { meta: 'c_line' }),
  F('orig_date', 'Original release', ['Original Release date'], { mam: ['Original Release Date'], meta: 'original_release_date' }),
  F('resource_ref', 'Resource reference', ['Resource Reference'], { mam: null }),
  F('technical', 'Technical resource', ['Technical Resource'], { mam: null }),
]

// Album-level fields a NEW song record copies from another track of the same
// album in the same database, so it lands on the right album with its label etc.
const ALBUM_FIELDS = {
  gallo:    ['Album Catalogue Number', 'Reference Catalogue Number', 'Album Artist', 'Album Title', 'Barcode',
             'Year of Release', 'Release Date', 'Label'],
  streamer: ['Album Catalogue Number', 'Reference Catalogue Number', 'Album Artist', 'Album Title', 'UPC',
             'Year of Release', 'Release Date', 'Label', 'Country', 'Download_Price', 'Visibility'],
  mam:      ['AlbumID', 'Album Catalogue'],
}

const str = v => (v == null ? '' : String(v).trim())
const normFile = v => str(v).replace(/\.[a-z0-9]+$/i, '').toUpperCase()
const durSec = v => {
  const s = str(v); if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s))
  const p = s.split(':').map(Number); if (p.some(isNaN)) return null
  return p.reduce((a, n) => a * 60 + n, 0)
}
/** Same value for comparison purposes: durations by seconds, the rest trimmed. */
export function sameValue(key, a, b) {
  if (key === 'duration') return durSec(a) === durSec(b)
  if (key === 'seq') return (parseInt(a, 10) || null) === (parseInt(b, 10) || null)
  if (key === 'filename') return normFile(a) === normFile(b)
  if (key === 'isrc') return str(a).toUpperCase() === str(b).toUpperCase()
  return str(a) === str(b)
}

function valuesFrom(db, fd) {
  const out = {}
  for (const f of FIELDS) {
    const names = f[db]; if (!names) continue
    for (const n of names) { const v = str(fd[n]); if (v) { out[f.key] = v; break } }
  }
  return out
}
const summary = (db, r) => ({ recordId: r.recordId, ...valuesFrom(db, r.fieldData) })

/** All records of a catalogue in one writable DB, as {recordId, fieldData}. */
async function loadDb(db, cat) {
  if (db === 'gallo') return findGalloRawByCatalogue(cat)
  if (db === 'streamer') return (await findStreamerByCatalogue(cat, { includeFieldData: true }))
    .map(r => ({ recordId: r.recordId, fieldData: r.fieldData }))
  if (db === 'mam') {
    const m = await findMamTracksByCatalogue(cat)
    return Object.assign((m?.tracks || []).map(t => ({ recordId: String(t.recordId), fieldData: t.fieldData })), { album: m?.album || null })
  }
  throw new Error('not a writable database: ' + db)
}

/** Which record in `records` is this track: the given id, else ISRC, else Filename. */
function locate(records, { pick, isrc, filename }) {
  if (pick) {
    const r = records.find(x => String(x.recordId) === String(pick))
    if (r) return { record: r, by: 'record id' }
  }
  const I = str(isrc).toUpperCase()
  if (I) {
    const hits = records.filter(x => str(x.fieldData['ISRC']).toUpperCase() === I)
    if (hits.length) return { record: hits[0], by: 'ISRC', also: hits.slice(1).map(x => x.recordId) }
  }
  const fn = normFile(filename)
  if (fn) {
    const hits = records.filter(x => normFile(x.fieldData['Filename']) === fn)
    if (hits.length) return { record: hits[0], by: 'Filename', also: hits.slice(1).map(x => x.recordId) }
  }
  return null
}

/**
 * The track as each database holds it.
 * key = { isrc, filename, picks: { gallo, streamer, mam, cms2024 } } — picks are record ids.
 */
export async function readTrack(cat, key) {
  const out = { catalogue: cat, key, fields: FIELDS.map(f => ({ key: f.key, label: f.label, kind: f.kind || null,
    in: Object.fromEntries(DBS.map(d => [d, d === 'cms2024' ? !!f.cms : d === 'metadata' ? !!f.meta : !!f[d]])) })), dbs: {} }
  const picks = key.picks || {}
  await Promise.all(['gallo', 'streamer', 'mam'].map(async db => {
    try {
      const records = await loadDb(db, cat)
      const hit = locate(records, { pick: picks[db], isrc: key.isrc, filename: key.filename })
      out.dbs[db] = {
        ok: true, writable: true, present: !!hit,
        recordId: hit?.record.recordId || null, matchedBy: hit?.by || null, alsoMatched: hit?.also || [],
        values: hit ? valuesFrom(db, hit.record.fieldData) : {},
        // the album's other tracks here — to pick the right one by hand when ISRC/Filename don't find it
        tracks: records.map(r => summary(db, r)).sort((a, b) => (parseInt(a.seq) || 999) - (parseInt(b.seq) || 999)),
        albumMissing: db === 'mam' ? !records.album : records.length === 0,
      }
    } catch (e) { out.dbs[db] = { ok: false, error: e.message, writable: true, present: false, values: {}, tracks: [] } }
  }))
  try {
    const tracks = await findCmsByCatalogue(cat)
    const I = str(key.isrc).toUpperCase(), fn = normFile(key.filename)
    const hit = tracks.find(t => picks.cms2024 && String(t.fm_record_id) === String(picks.cms2024))
      || (I && tracks.find(t => str(t.isrc).toUpperCase() === I))
      || (fn && tracks.find(t => normFile(t.wav_filename || t.asset_number) === fn))
    const values = {}
    if (hit) for (const f of FIELDS) if (f.cms && str(hit[f.cms])) values[f.key] = str(hit[f.cms])
    out.dbs.cms2024 = { ok: true, writable: false, present: !!hit, recordId: hit?.fm_record_id || null, values, tracks: [] }
  } catch (e) { out.dbs.cms2024 = { ok: false, error: e.message, writable: false, present: false, values: {}, tracks: [] } }
  if (!metadataStatus().loaded) {
    out.dbs.metadata = { ok: false, error: 'metadata extract still loading — try again in a couple of minutes', writable: false, present: false, values: {}, tracks: [] }
  } else {
    const I = str(key.isrc).toUpperCase()
    const row = I ? lookupAlbumTracks(cat).find(r => str(r.isrc).toUpperCase() === I) : null
    const values = {}
    if (row) for (const f of FIELDS) if (f.meta && str(row[f.meta])) values[f.key] = str(row[f.meta])
    out.dbs.metadata = { ok: true, writable: false, present: !!row, values, tracks: [] }
  }
  return out
}

/** Duration written in the shape that database already uses (MAM: 0:02:53, others: 00:02:53). */
function fmtDuration(db, v) {
  const s = durSec(v); if (s == null) return str(v)
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return db === 'mam' ? `${h}:${mmss}` : `${String(h).padStart(2, '0')}:${mmss}`
}

/** values {key: value} → raw field names for one database. */
function toFieldData(db, values) {
  const fd = {}
  for (const f of FIELDS) {
    if (!(f.key in values) || !f[db]) continue
    let v = values[f.key]
    if (f.key === 'duration') v = fmtDuration(db, v)
    if (f.key === 'isrc') v = str(v).toUpperCase()
    if (f.key === 'filename') v = normFile(v)
    if (f.key === 'seq') { for (const n of f[db]) fd[n] = str(v); continue }   // MAM keeps both
    fd[f[db][0]] = str(v)
    if (db === 'mam' && f.key === 'composers') Object.assign(fd, mamComposerFields(str(v)))
  }
  return fd
}

async function s3Exists(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok } catch { return false }
}

const JOURNAL = path.join(process.cwd(), 'tmp', 'track-fix-journal.jsonl')
function journal(entry) {
  try { fs.mkdirSync(path.dirname(JOURNAL), { recursive: true }); fs.appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n') }
  catch (e) { console.warn('[track-fix] journal write failed:', e.message) }
}

/**
 * Write one record. body = { db, recordId|null, values: {key: value}, seen: {key: value} }
 * `seen` is what the panel showed for those fields; an update is refused if the
 * record no longer holds it (someone else edited it meanwhile).
 */
export async function applyFix(cat, body) {
  const { db, recordId = null, values = {}, seen = {} } = body || {}
  if (!WRITABLE.has(db)) throw Object.assign(new Error(`${db} is read-only here`), { status: 400 })
  const keys = Object.keys(values).filter(k => FIELDS.some(f => f.key === k && f[db]))
  if (!keys.length) throw Object.assign(new Error('nothing to write'), { status: 400 })
  const records = await loadDb(db, cat)
  const v = Object.fromEntries(keys.map(k => [k, values[k]]))

  // MP3 links must play this track's own audio: same GCAT, and the file must exist.
  const fn = normFile(v.filename ?? (recordId ? valuesFrom(db, records.find(r => r.recordId === String(recordId))?.fieldData || {}).filename : ''))
  if (str(v.mp3)) {
    if (fn && !str(v.mp3).toUpperCase().includes(`/${fn}.`)) throw Object.assign(new Error(`MP3 link ${v.mp3} does not match Filename ${fn} — it would play another track's audio`), { status: 400 })
    if (!(await s3Exists(v.mp3))) throw Object.assign(new Error(`MP3 not found in S3: ${v.mp3}`), { status: 400 })
  }

  if (recordId) {
    const rec = records.find(r => r.recordId === String(recordId))
    if (!rec) throw Object.assign(new Error(`record ${recordId} is not on ${cat} in ${db}`), { status: 404 })
    const now = valuesFrom(db, rec.fieldData)
    const moved = keys.filter(k => k in seen && !sameValue(k, now[k], seen[k]))
    if (moved.length) throw Object.assign(new Error(`changed since you opened it: ${moved.join(', ')} — reopen the track and check again`), { status: 409 })
    const fd = toFieldData(db, v)
    const before = Object.fromEntries(Object.keys(fd).map(n => [n, rec.fieldData[n] ?? '']))
    let written
    if (db === 'gallo') { await updateGalloRecord(recordId, fd); written = Object.keys(fd) }
    else if (db === 'streamer') written = (await writeSongRaw(recordId, fd)).written
    else written = await updateMamSong(recordId, fd)
    journal({ catalogue: cat, db, action: 'update', recordId: String(recordId), before, after: fd })
    console.log(`[track-fix] ${db} ${recordId} (${cat}) updated: ${written.join(', ')}`)
    return { ok: true, action: 'updated', db, recordId: String(recordId), written }
  }

  // ── create ──
  const I = str(v.isrc).toUpperCase()
  const dupe = records.find(r => (I && str(r.fieldData['ISRC']).toUpperCase() === I) || (fn && normFile(r.fieldData['Filename']) === fn))
  if (dupe) throw Object.assign(new Error(`${db} already has this track on ${cat} (record ${dupe.recordId}, same ${I && str(dupe.fieldData['ISRC']).toUpperCase() === I ? 'ISRC' : 'Filename'}) — update that record instead`), { status: 409 })
  if (!I && !fn) throw Object.assign(new Error('a new record needs an ISRC or a Filename, or it can never be matched again'), { status: 400 })

  const sibling = records[0]?.fieldData || null
  const fd = {}
  if (db === 'mam') {
    if (!records.album) throw Object.assign(new Error(`${cat} has no album in MAM — create the album first`), { status: 400 })
    fd['AlbumID'] = records.album.fieldData['AlbumID']
    fd['Album Catalogue'] = sibling?.['Album Catalogue'] || cat
  } else {
    if (!sibling) throw Object.assign(new Error(`${cat} has no other tracks in ${db} to copy the album details from`), { status: 400 })
    for (const n of ALBUM_FIELDS[db]) if (str(sibling[n])) fd[n] = sibling[n]
  }
  // A new MadStreamer/MAM song without an MP3 link would be silent; offer the sibling's S3 folder + this GCAT.
  if ((db === 'streamer' || db === 'mam') && !str(v.mp3) && fn) {
    const sib = str(sibling?.[db === 'streamer' ? 'S3_URL' : 'Audio_S3_URL'])
    const guess = sib ? sib.replace(/[^/]+$/, `${fn}.mp3`) : ''
    if (guess && await s3Exists(guess)) v.mp3 = guess
    else throw Object.assign(new Error(`no MP3 link given and ${guess || `${fn}.mp3`} is not in S3 — push the audio first`), { status: 400 })
  }
  Object.assign(fd, toFieldData(db, v))

  let result
  if (db === 'gallo') result = await createGalloRawRecord(fd)
  else if (db === 'streamer') result = await writeSongRaw(null, fd)
  else {
    const mdb = await mamSession()
    try {
      const ids = await makeIdAllocator(mdb)
      fd['MasterID'] = ids.nextMaster(); fd['RecordingID'] = ids.nextRecording()
      fd['Sources'] = 'track-fix'; fd['MatchMethod'] = 'manual (track-fix)'
      if (fd['Audio_Vision_URL']) fd['Audio_Truth'] = 'Vision'
      result = { recordId: String(await mdb.create(process.env.MAM_FM_SONGS_LAYOUT || 'Songs', fd)), written: Object.keys(fd), dropped: [] }
    } finally { await mdb.logout() }
  }
  journal({ catalogue: cat, db, action: 'create', recordId: result.recordId, after: fd })
  console.log(`[track-fix] ${db} created ${result.recordId} on ${cat}: ${result.written.join(', ')}`)
  return { ok: true, action: 'created', db, recordId: result.recordId, written: result.written, dropped: result.dropped || [] }
}
