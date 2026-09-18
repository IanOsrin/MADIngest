/**
 * lib/mam-db-fill.js — bring one MAM album up to date from the other three.
 *
 * Music Arena Master was merged once from Gallo Catalogue, CMS 2024 and
 * MadStreamer, and has drifted ever since: work done in those three (credits
 * typed into Gallo, a language set in CMS, audio linked to a Vision master)
 * never reaches MAM. This reads the same catalogue in all three and proposes
 * what MAM is missing — metadata, the audio links AND the cover.
 *
 * Ian's rules (2026-09-18):
 *   1. Gallo Catalogue wins, then CMS 2024, then MadStreamer. Every source's
 *      value is still shown, so a different one can be chosen per field.
 *   2. Empty MAM fields are FILLED. A field MAM already holds differently is a
 *      CONFLICT: reported old → new, applied only if ticked.
 *   3. Tracks a source has and MAM doesn't are offered, never created silently.
 *
 * Tracks are matched on ISRC first, then on normalised title, never on
 * position — MAM and the sources disagree about track order often enough that
 * position matching would write one song's credits onto another.
 *
 * The cover goes through lib/album-cover.js like every other cover in this
 * app (GMVi JPEG + derivatives + MAM and MADStreamer repointed); nothing here
 * writes an artwork URL by hand.
 */
import { mamSession, findMamAlbum, createMamSong, makeIdAllocator } from './fm-mam-write.js'
import { updateMamSong, updateMamAlbum, findMamAlbumByCatalogue } from './fm-mam.js'
import { findGalloRecordsByCatalogue } from './fm-gallo.js'
import { findRecordsByCatalogue as findCmsRecordsByCatalogue } from './fm-cms2024.js'
import { findRecordsByCatalogue as findStreamerRecordsByCatalogue } from './madstreamer.js'
import { artworkState, artworkImage } from './artwork-compare.js'
import { setAlbumCover } from './album-cover.js'
import { mamComposerFields } from './credits.js'

const SONGS_LAYOUT = process.env.MAM_FM_SONGS_LAYOUT || 'Songs'

export const SOURCES = [
  { key: 'gallo',    label: 'Gallo Catalogue' },
  { key: 'cms',      label: 'CMS 2024' },
  { key: 'streamer', label: 'MadStreamer' },
]
/** Ian's order of trust when the three disagree. */
export const DEFAULT_PRECEDENCE = ['gallo', 'cms', 'streamer']

const S = v => String(v ?? '').trim()
// Placeholders the databases use for "nothing". Copying "?" into MAM would be
// worse than leaving the field empty: it reads as an answer.
const JUNK = new Set(['?', '??', '-', '--', 'N/A', 'NA', '#N/A', 'NONE', 'NULL', 'UNKNOWN', '0', '00:00:00'])
// FileMaker's own streaming URLs are session-scoped: they 401 within the hour
// and are worthless once stored. They are never copied into MAM.
const isFmStreamingUrl = v => /RCType=RCFileProcessor|\/Streaming_/i.test(S(v))
const has = v => {
  const x = S(v)
  return x !== '' && !JUNK.has(x.toUpperCase()) && !isFmStreamingUrl(x)
}
const tn = s => S(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const hhmmss = sec => {
  const n = Math.round(Number(sec) || 0)
  if (!n) return null
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60].map(x => String(x).padStart(2, '0')).join(':')
}
const isoDate = v => {
  const s = S(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // CMS writes 2024/09/03, Gallo and the cache write 9/3/2024.
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  return mdy ? `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}` : s
}
const list = v => Array.isArray(v) ? v.filter(Boolean).join('; ') : S(v)

/** "0:09:23", "00:09:23", "9:23" and "563" all mean the same length. */
const durSec = v => {
  const s = S(v)
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) return null
  return parts.reduce((a, n) => a * 60 + n, 0)
}

/** The bare filename an audio path or filename field points at, lowercased. */
const audioKey = v => {
  const base = S(v).split('?')[0].split(/[\\/]/).pop()
  return base.replace(/\.[^.]+$/, '').toLowerCase()
}

// Credit strings carry role tags ("Hamilton Nzimande <Composer>") in some
// databases and not others; the same names in either form are not a conflict.
const creditNorm = v => S(v).replace(/<[^>]*>/g, '').split(/\s*[;,]\s*/)
  .map(x => x.trim().toLowerCase()).filter(Boolean).sort().join('|')

/** Do two values say the same thing? Field-aware, so formatting isn't a conflict. */
function sameValue(field, a, b) {
  const x = S(a), y = S(b)
  if (x === y) return true
  if (!x || !y) return false
  if (x.toLowerCase() === y.toLowerCase()) return true
  if (/Composer|Producer|Publisher/i.test(field)) return creditNorm(x) === creditNorm(y)
  if (/Date/i.test(field)) return isoDate(x) === isoDate(y)
  if (/Sequence|Track Number/i.test(field)) return parseInt(x, 10) === parseInt(y, 10)
  if (field === 'Duration') return durSec(x) === durSec(y) && durSec(x) !== null
  if (field === 'ISRC') return x.toUpperCase().replace(/[\s-]/g, '') === y.toUpperCase().replace(/[\s-]/g, '')
  return false
}

// ── what each database offers for one track, in MAM's field names ────────────

function fromGallo(g) {
  return {
    'ISRC': g.isrc, 'Track Name': g.title, 'Track Artist': g.artist_name,
    'Featured Artist': g.featured_artist, 'Version': g.version_title,
    'Sequence Number': g.sequence_no, 'Track Number': g.sequence_no,
    'Duration': hhmmss(g.duration_sec), 'Genre': g.genre, 'Local Genre': g.local_genre,
    'Sub Genre': g.sub_genre, 'Language': g.language,
    'Composers': list(g.composers), 'Producers': list(g.producers), 'Publishers': g.publishers,
    'pLine': g.pline_text, 'cLine': g.cline_text,
    'Original Release Date': isoDate(g.original_release_date),
    'Filename': g.wav_filename, 'AudioHashSum': g.audio_hash_md5,
    // Audio: the Vision master is MAM's truth; the S3 copy is the mp3 the site serves.
    'Audio_Vision_URL': g.audio_url_ref, 'Audio_S3_URL': g.s3_url,
    'Catalogue_recid': g.fm_record_id,
    _album: { 'Album Title': g.album_title, 'Album Artist': g.album_artist, 'UPC': g.barcode,
              'Label': g.label, 'Genre': g.genre, 'Year of Release': g.year,
              'Release Date': isoDate(g.release_date) },
  }
}

function fromCms(c) {
  return {
    'ISRC': c.isrc, 'Track Name': c.title, 'Track Artist': c.artist_name,
    'Featured Artist': c.featured_artist, 'Version': c.version_title,
    'Sequence Number': c.sequence_no, 'Track Number': c.sequence_no,
    'Duration': hhmmss(c.duration_sec), 'Genre': c.genre, 'Local Genre': c.local_genre,
    'Sub Genre': c.sub_genre, 'Language': c.language,
    'Composers': list(c.composers), 'Producers': list(c.producers), 'Publishers': c.publishers,
    'pLine': c.pline_text, 'cLine': c.cline_text,
    'Original Release Date': isoDate(c.original_release_date),
    'Filename': c.wav_filename || c.asset_number, 'AudioHashSum': c.audio_hash_md5,
    // The S3 copy only — CMS's container holds a FileMaker streaming URL.
    'CMS_Audio_File': c.s3_url,
    'CMS_recid': c.fm_record_id,
    _album: { 'Album Title': c.album_title, 'Album Artist': c.album_artist, 'UPC': c.barcode,
              'Label': c.label, 'Genre': c.genre, 'Year of Release': c.year,
              'Release Date': isoDate(c.release_date) },
  }
}

function fromStreamer(s) {
  const f = s.fieldData || {}
  return {
    'ISRC': f['ISRC'], 'Track Name': f['Track Name'], 'Track Artist': f['Track Artist'],
    'Featured Artist': f['Featured Artist'], 'Sequence Number': f['Sequence Number'],
    'Track Number': f['Track Number'] || f['Sequence Number'],
    'Duration': S(f['Duration']) || null, 'Genre': f['Genre'], 'Local Genre': f['Local Genre'],
    'Sub Genre': f['Sub Genre'], 'Language': f['Language'],
    'Composers': f['Composers'] || f['Composer'], 'Producers': f['Producers'] || f['Producer'],
    'Publishers': f['Publishers'], 'pLine': f['pLine'], 'cLine': f['cLine'],
    'Original Release Date': isoDate(f['Original Release Date']),
    'Filename': f['Filename'], 'Audio_S3_URL': f['S3_URL'],
    'Streamer_recid': s.recordId,
    _album: { 'Album Title': f['Album Title'], 'Album Artist': f['Album Artist'], 'UPC': f['UPC'],
              'Label': f['Label'], 'Genre': f['Genre'], 'Year of Release': f['Year of Release'],
              'Release Date': isoDate(f['Release Date']) },
  }
}

// Fields a fill may write. The recid/Sources columns are provenance and are
// maintained here too, so a filled album says where its values came from.
const TRACK_FIELDS = [
  'ISRC', 'Track Name', 'Track Artist', 'Featured Artist', 'Version',
  'Sequence Number', 'Track Number', 'Duration', 'Genre', 'Sub Genre', 'Local Genre',
  'Language', 'Composers', 'Producers', 'Publishers', 'pLine', 'cLine',
  'Original Release Date', 'Filename', 'AudioHashSum',
  'Audio_Vision_URL', 'Audio_S3_URL', 'CMS_Audio_File',
]
const AUDIO_FIELDS = new Set(['Audio_Vision_URL', 'Audio_S3_URL', 'CMS_Audio_File', 'AudioHashSum'])
const RECID_FIELDS = { gallo: 'Catalogue_recid', cms: 'CMS_recid', streamer: 'Streamer_recid' }
const ALBUM_FIELDS = ['Album Title', 'Album Artist', 'UPC', 'Label', 'Genre', 'Year of Release', 'Release Date']

async function readSources(cat) {
  const [gallo, cms, streamer] = await Promise.allSettled([
    findGalloRecordsByCatalogue(cat),
    findCmsRecordsByCatalogue(cat),
    findStreamerRecordsByCatalogue(cat, { includeFieldData: true }),
  ])
  const err = {}
  const take = (r, name) => { if (r.status === 'fulfilled') return r.value; err[name] = r.reason?.message || String(r.reason); return [] }
  return {
    gallo: take(gallo, 'gallo').map(fromGallo),
    // findRecordsByCatalogue already returns MAPPED records — mapping again
    // blanks every field (it reads fieldData, which a mapped record has not).
    cms: take(cms, 'cms').map(fromCms),
    streamer: take(streamer, 'streamer').map(fromStreamer),
    errors: err,
  }
}

/**
 * What MAM is missing for this catalogue.
 *
 * @returns {Promise<object>} album/track fills, conflicts, missing tracks and
 *   the artwork position — everything the UI needs to show, nothing written.
 */
export async function planMamFill(catalogue, { precedence = DEFAULT_PRECEDENCE } = {}) {
  const cat = S(catalogue)
  if (!cat) throw Object.assign(new Error('catalogue is required'), { status: 400 })
  const order = precedence.filter(p => RECID_FIELDS[p])
  if (!order.length) throw Object.assign(new Error('no sources selected'), { status: 400 })

  const src = await readSources(cat)
  const db = await mamSession()
  try {
    const album = await findMamAlbum(db, cat)
    if (!album) throw Object.assign(new Error(`No album ${cat} in Music Arena Master — create it on the MAM tab first`), { status: 404 })
    // Songs hang off the album by AlbumID; 'Album Catalogue' is a convenience
    // copy that some rows carry and some don't.
    const songs = await db.find(SONGS_LAYOUT, [{ AlbumID: '==' + S(album.fieldData?.['AlbumID']) }], 500)

    // Index MAM's tracks by ISRC and by title; a source track is looked up in
    // that order. Position is never used.
    const byIsrc = new Map(), byTitle = new Map(), byAudio = new Map()
    for (const s of songs) {
      const f = s.fieldData || {}
      const i = S(f['ISRC']).toUpperCase()
      if (i && !byIsrc.has(i)) byIsrc.set(i, s)
      const t = tn(f['Track Name'])
      if (t && !byTitle.has(t)) byTitle.set(t, s)
      // Gallo holds audio-only shells for some albums (SMCD 185: 16 records
      // with a Vision path and nothing else). The filename is the only thing
      // they can be recognised by, and the audio link is the point of them.
      for (const k of [audioKey(f['Filename']), audioKey(f['Audio_Vision_URL'])]) {
        if (k && !byAudio.has(k)) byAudio.set(k, s)
      }
    }
    const matchMam = row => {
      const i = S(row['ISRC']).toUpperCase()
      if (i && byIsrc.has(i)) return { song: byIsrc.get(i), how: 'ISRC' }
      const t = tn(row['Track Name'])
      if (t && byTitle.has(t)) return { song: byTitle.get(t), how: 'title' }
      for (const k of [audioKey(row['Filename']), audioKey(row['Audio_Vision_URL']), audioKey(row['Audio_S3_URL'])]) {
        if (k && byAudio.has(k)) return { song: byAudio.get(k), how: 'filename' }
      }
      return null
    }

    // source key → MAM recordId → that source's row for the same track
    const matched = new Map(order.map(k => [k, new Map()]))
    const missing = []
    const unusable = []
    for (const key of order) {
      for (const row of src[key] || []) {
        const m = matchMam(row)
        if (!m) {
          // A row with neither a title nor an ISRC is a shell, not a track —
          // creating it in MAM would add a nameless record. Reported instead.
          if (!has(row['Track Name']) && !has(row['ISRC'])) {
            unusable.push({ source: key, audio: S(row['Audio_Vision_URL'] || row['Audio_S3_URL'] || row['Filename']) || null })
            continue
          }
          missing.push({
            source: key, isrc: S(row['ISRC']) || null, title: S(row['Track Name']) || null,
            artist: S(row['Track Artist']) || null, seq: row['Sequence Number'] ?? null,
            audio: S(row['Audio_Vision_URL'] || row['Audio_S3_URL'] || row['CMS_Audio_File']) || null,
          })
          continue
        }
        if (!matched.get(key).has(m.song.recordId)) matched.get(key).set(m.song.recordId, { row, how: m.how })
      }
    }

    const tracks = []
    let fillCount = 0, conflictCount = 0
    for (const song of songs) {
      const f = song.fieldData || {}
      const fills = {}, conflicts = {}
      const offers = {}                   // field → [{ source, value }]
      for (const field of TRACK_FIELDS) {
        for (const key of order) {
          const hit = matched.get(key).get(song.recordId)
          const v = hit?.row?.[field]
          if (!has(v)) continue
          ;(offers[field] ||= []).push({ source: key, value: S(v) })
        }
        const all = offers[field]
        if (!all?.length) continue
        const best = all[0]               // precedence order
        if (!has(f[field])) {
          fills[field] = { value: best.value, source: best.source, audio: AUDIO_FIELDS.has(field) }
          fillCount++
        } else if (!all.some(o => sameValue(field, f[field], o.value))) {
          conflicts[field] = { mam: S(f[field]), value: best.value, source: best.source, others: all.slice(1) }
          conflictCount++
        }
      }
      // Provenance: point MAM at the record it was filled from, where it has no link yet.
      for (const key of order) {
        const hit = matched.get(key).get(song.recordId)
        const field = RECID_FIELDS[key]
        const rid = hit?.row?.[field]
        if (hit && has(rid) && !has(f[field])) {
          fills[field] = { value: S(rid), source: key, provenance: true }
        }
      }
      if (Object.keys(fills).length || Object.keys(conflicts).length) {
        tracks.push({
          recordId: song.recordId,
          seq: f['Sequence Number'] ?? null,
          title: S(f['Track Name']) || '(no title)',
          artist: S(f['Track Artist']) || '',
          isrc: S(f['ISRC']) || null,
          matchedBy: Object.fromEntries(order.map(k => [k, matched.get(k).get(song.recordId)?.how || null])),
          fills, conflicts, offers,
        })
      }
    }

    // ── album level ───────────────────────────────────────────────────────
    const albumFields = album.fieldData || {}
    const albumFills = {}, albumConflicts = {}
    for (const field of ALBUM_FIELDS) {
      for (const key of order) {
        const v = (src[key] || []).map(r => r._album?.[field]).find(has)
        if (!has(v)) continue
        if (!has(albumFields[field])) { albumFills[field] = { value: S(v), source: key }; fillCount++ }
        else if (!sameValue(field, albumFields[field], v)) { albumConflicts[field] ||= { mam: S(albumFields[field]), value: S(v), source: key }; conflictCount++ }
        break
      }
    }

    // ── artwork ───────────────────────────────────────────────────────────
    const art = await artworkState(cat).catch(e => ({ error: e.message }))
    const artworkSources = SOURCES.filter(s => art?.[s.key]?.hasImage).map(s => s.key)
    const artwork = {
      mamHas: has(albumFields['Artwork_S3_URL']),
      mamUrl: S(albumFields['Artwork_S3_URL']) || null,
      available: artworkSources,
      suggested: order.find(k => artworkSources.includes(k)) || null,
      state: art,
    }

    return {
      catalogue: cat, precedence: order,
      album: { recordId: album.recordId, fills: albumFills, conflicts: albumConflicts },
      tracks, artwork,
      missing, unusable,
      counts: {
        mamTracks: songs.length, fills: fillCount, conflicts: conflictCount,
        missing: missing.length, unusable: unusable.length,
        sources: Object.fromEntries(order.map(k => [k, (src[k] || []).length])),
      },
      sourceErrors: src.errors,
    }
  } finally {
    await db.logout?.().catch(() => {})
  }
}

/**
 * Write the ticked parts of a plan.
 *
 * @param {string} catalogue
 * @param {object} choices
 * @param {Record<string, Record<string,string>>} [choices.tracks]  MAM recordId → { field: value }
 * @param {Record<string,string>} [choices.album]                   field → value
 * @param {string} [choices.artworkFrom]                            'gallo' | 'cms' | 'streamer'
 * @param {Array} [choices.addTracks]                               entries from plan.missing
 */
export async function applyMamFill(catalogue, { tracks = {}, album = {}, artworkFrom = null, addTracks = [] } = {}) {
  const cat = S(catalogue)
  const result = { tracksUpdated: 0, fieldsWritten: 0, albumFields: 0, added: 0, artwork: null, failed: [] }

  for (const [recordId, patch] of Object.entries(tracks)) {
    const fields = { ...patch }
    // Composers must go in through the credits rule: the plural field keeps its
    // role tags, Composer…4 hold one plain name each (Ian, 2026-09-17).
    if (has(fields['Composers'])) Object.assign(fields, mamComposerFields(fields['Composers'], { clearUnused: false }))
    // An audio link is only true if it says where the audio is.
    if (has(fields['Audio_Vision_URL'])) fields['Audio_Truth'] = 'Vision'
    if (!Object.keys(fields).length) continue
    try {
      await updateMamSong(recordId, fields)
      result.tracksUpdated++
      result.fieldsWritten += Object.keys(patch).length
    } catch (err) {
      result.failed.push({ recordId, error: err.message })
    }
  }

  if (Object.keys(album).length) {
    try {
      const mamAlbum = await findMamAlbumByCatalogue(cat)
      if (!mamAlbum) throw new Error(`no MAM album record for ${cat}`)
      await updateMamAlbum(mamAlbum.recordId, album)
      result.albumFields = Object.keys(album).length
    } catch (err) {
      result.failed.push({ album: cat, error: err.message })
    }
  }

  if (addTracks.length) {
    const db = await mamSession()
    try {
      const mamAlbum = await findMamAlbum(db, cat)
      if (!mamAlbum) throw Object.assign(new Error(`No album ${cat} in Music Arena Master`), { status: 404 })
      const ids = await makeIdAllocator(db)
      for (const t of addTracks) {
        try {
          const f = t.fields || {}
          await createMamSong(db, {
            master_id:    ids.nextMaster(),
            recording_id: ids.nextRecording(),
            album_id:     mamAlbum.fieldData?.['AlbumID'],
            // Where the track came from, in the column MAM uses for provenance.
            sources:      SOURCES.find(s => s.key === t.source)?.label || t.source,
            match_method: 'DbFill',
            catalogue_no: cat,
            isrc:         t.isrc || null,
            title:        t.title,
            artist:       t.artist || null,
            sequence_no:  t.seq ?? null,
            wav_filename: f['Filename'] || null,
            duration:     f['Duration'] || null,
            genre:        f['Genre'] || null,
            sub_genre:    f['Sub Genre'] || null,
            language:     f['Language'] || null,
            composers:    f['Composers'] || null,
            producers:    f['Producers'] || null,
            publishers:   f['Publishers'] || null,
            c_line:       f['cLine'] || null,
            p_line:       f['pLine'] || null,
            original_release_date: f['Original Release Date'] || null,
            audio_hash_md5: f['AudioHashSum'] || null,
            // Only a Vision path is the master; an mp3 URL is not.
            audio_url:    /^\/|^image:/.test(S(t.audio)) ? t.audio : null,
          })
          result.added++
        } catch (err) {
          result.failed.push({ track: t.title, error: err.message })
        }
      }
    } finally {
      await db.logout?.().catch(() => {})
    }
  }

  if (artworkFrom) {
    try {
      const img = await artworkImage(artworkFrom, cat)
      if (!img?.buffer?.length) throw new Error(`no artwork image in ${artworkFrom}`)
      // Through the one cover pipeline: GMVi JPEG + derivatives, MAM and
      // MADStreamer repointed, original archived on Vision.
      const out = await setAlbumCover(cat, img.buffer, { label: `${cat} cover from ${artworkFrom}` })
      result.artwork = { from: artworkFrom, ...out }
    } catch (err) {
      result.failed.push({ artwork: artworkFrom, error: err.message })
    }
  }

  return result
}
