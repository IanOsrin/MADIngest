/**
 * lib/madstreamer.js
 * FileMaker Data API client for the MadStreamer database.
 *
 * MadStreamer mirrors Gallo's layout naming convention:
 *   - API_Album_Songs   → track / MP3 records
 *   - Artwork           → owns the GMVi assignment (lookup by Reference Catalogue Number)
 *
 * Credentials default to the same GALLO_FM_USER / GALLO_FM_PASS pair already
 * configured for the Gallo Catalogue, since both DBs share a login. Override
 * with MADSTREAMER_FM_USER / _PASS if they ever diverge.
 *
 * Drives the "Push to MadStreamer" admin action:
 *   1. lookupGmviByCatalogue(cat)  → reads GMVi from Artwork layout
 *   2. upsertMp3Record(metadata)   → creates / updates a record in API_Album_Songs
 */

import { languageNameToCode } from './language-codes.js'
import { normalizeGenre } from './genre-taxonomy.js'

const {
  GALLO_FM_HOST,
  GALLO_FM_USER,
  GALLO_FM_PASS,

  MADSTREAMER_FM_HOST            = 'digitalcupboard.fmcloud.fm',
  MADSTREAMER_FM_DB              = 'MadStreamer',
  MADSTREAMER_FM_USER,
  MADSTREAMER_FM_PASS,
  MADSTREAMER_FM_LAYOUT          = 'API_Album_Songs',
  MADSTREAMER_FM_ARTWORK_LAYOUT  = 'Artwork',
  MADSTREAMER_FM_TAPE_LAYOUT     = 'Tape Files Master',
  MADSTREAMER_FM_BIO_LAYOUT      = 'API_Artist_Bio',
  // Measured from the live Artwork layout (2026-07-03): the GMVi lives in
  // "Resource reference" (values like "GMVi1912", used verbatim as the S3
  // artwork key) and the catalogue in "Catalogue Number". Singles may carry
  // theirs in "Single Catalogue Number" — lookups OR across both.
  MADSTREAMER_FM_GMVI_FIELD      = 'Resource reference',
  MADSTREAMER_FM_CATALOGUE_FIELD = 'Catalogue Number',
  MADSTREAMER_FM_SINGLE_CATALOGUE_FIELD = 'Single Catalogue Number',
} = process.env

const HOST = (MADSTREAMER_FM_HOST || GALLO_FM_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
const DB   = MADSTREAMER_FM_DB
const USER = MADSTREAMER_FM_USER || GALLO_FM_USER
const PASS = MADSTREAMER_FM_PASS || GALLO_FM_PASS

const base = HOST && DB
  ? `https://${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
  : null

let _token = null
let _tokenExpiry = 0
const FM_TIMEOUT_MS = 60_000

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  if (!base) throw new Error('MadStreamer FM not configured (need MADSTREAMER_FM_HOST/_DB)')
  if (!USER || !PASS) throw new Error('MadStreamer FM credentials not set (MADSTREAMER_FM_USER/_PASS or GALLO_FM_USER/_PASS)')

  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: {
      Authorization:  'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'),
      'Content-Type': 'application/json',
      Accept:         'application/json'
    },
    body: JSON.stringify({})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`MadStreamer FM login failed: ${msg}`)
  }
  _token = json?.response?.token
  if (!_token) throw new Error('MadStreamer FM login returned no token')
  _tokenExpiry = Date.now() + 14 * 60 * 1000
  return _token
}

function withTimeout(ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

async function msFetch(path, options = {}) {
  const token = await getToken()
  const url   = `${base}${path}`
  const { signal, clear } = withTimeout(FM_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...options,
      signal,
      headers: {
        Accept:        'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    })
    if (res.status === 401) {
      _token = null; _tokenExpiry = 0
      const fresh = await getToken()
      const { signal: s2, clear: c2 } = withTimeout(FM_TIMEOUT_MS)
      try {
        return await fetch(url, {
          ...options,
          signal: s2,
          headers: { Accept: 'application/json', Authorization: `Bearer ${fresh}`, ...(options.headers || {}) }
        })
      } finally { c2() }
    }
    return res
  } finally {
    clear()
  }
}

/**
 * Find the GMVi for a given catalogue number on the MadStreamer Artwork layout.
 * Returns { gmvi, recordId } or null if not found.
 */
export async function lookupGmviByCatalogue(catalogueNumber) {
  if (!catalogueNumber) throw new Error('Catalogue number required for GMVi lookup')

  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_ARTWORK_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { [MADSTREAMER_FM_CATALOGUE_FIELD]:        `==${catalogueNumber}` },
          { [MADSTREAMER_FM_SINGLE_CATALOGUE_FIELD]: `==${catalogueNumber}` },
        ],
        limit: '1'
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  // FM error 401 from _find = no records match
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer GMVi lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  const gmvi = rec.fieldData?.[MADSTREAMER_FM_GMVI_FIELD]
  if (!gmvi) return null
  return { gmvi: String(gmvi).trim(), artworkRecordId: String(rec.recordId) }
}

// ── Album artwork records (Artwork layout) ──────────────────────────────────
// GMVi allocation happens INSIDE FileMaker (auto-enter on record creation) —
// never in our code. This mirrors AlbumArtworkTool's proven ensure flow:
// find by catalogue, else create with ONLY the catalogue field, then poll the
// new record until the FM-assigned GMVi appears.

/** Full Artwork-layout record for a catalogue, or null. */
export async function findArtworkByCatalogue(catalogueNo) {
  if (!catalogueNo) return null
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_ARTWORK_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { [MADSTREAMER_FM_CATALOGUE_FIELD]:        `==${catalogueNo}` },
          { [MADSTREAMER_FM_SINGLE_CATALOGUE_FIELD]: `==${catalogueNo}` },
        ],
        limit: 5,   // one is normal; more is a fault worth naming — see below
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`Artwork lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rows = json?.response?.data || []
  if (!rows.length) return null
  // Same reasoning as findTapeFileByCatalogue: prefer a record that actually
  // carries a GMVi, and name any duplicates rather than silently taking the
  // first. Note this only catches duplicates under the SAME catalogue string —
  // CDGMP40296 also has a 2025 Artwork record under the spaced "CDGMP 40296"
  // pointing at a different image, and an == find can never return both. That
  // one needs the spellings reconciled, not a bigger limit.
  const rec = rows.find(r => String(r.fieldData?.[MADSTREAMER_FM_GMVI_FIELD] || '').trim()) || rows[0]
  if (rows.length > 1) {
    console.warn(`[madstreamer] ${rows.length} Artwork records for catalogue "${catalogueNo}" ` +
      `(recordIds ${rows.map(r => r.recordId).join(', ')}) — using ${rec.recordId}. Delete the duplicates.`)
  }
  return {
    recordId:  String(rec.recordId),
    gmvi:      String(rec.fieldData?.[MADSTREAMER_FM_GMVI_FIELD] || '').trim() || null,
    fieldData: rec.fieldData || {},
    duplicates: rows.length > 1 ? rows.map(r => String(r.recordId)) : null,
  }
}

/**
 * Create an Artwork record carrying only the catalogue number, then poll
 * until FileMaker's auto-enter fills in the GMVi (up to ~4s). Returns
 * { recordId, gmvi } — gmvi may be null if FM never assigned one, which the
 * caller must surface rather than invent a number.
 */
export async function createArtworkRecord(catalogueNo) {
  const cat = String(catalogueNo || '').trim()
  if (!cat) throw new Error('catalogue number required')
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_ARTWORK_LAYOUT)}/records`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: { [MADSTREAMER_FM_CATALOGUE_FIELD]: cat } })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Artwork create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  const recordId = String(json?.response?.recordId || '')
  if (!recordId) throw new Error('Artwork create returned no recordId')

  let gmvi = null
  const until = Date.now() + 4000
  while (!gmvi && Date.now() < until) {
    const r = await msFetch(`/layouts/${encodeURIComponent(MADSTREAMER_FM_ARTWORK_LAYOUT)}/records/${recordId}`)
    const j = await r.json().catch(() => ({}))
    gmvi = String(j?.response?.data?.[0]?.fieldData?.[MADSTREAMER_FM_GMVI_FIELD] || '').trim() || null
    if (!gmvi) await new Promise(resolve => setTimeout(resolve, 300))
  }
  return { recordId, gmvi }
}

/**
 * Find an existing record on the API_Album_Songs layout by a *track-unique*
 * key. Tries ISRC first (globally unique per recording), then Filename
 * (per-asset unique). NEVER uses GMVi alone, because GMVi is album-level
 * (artwork) and would collide across every track on the same album.
 *
 * Returns { recordId, fieldData } or null when no match.
 */
export async function findMp3Record({ isrc, filename, gmvi }) {
  // Build OR-find: ISRC || Filename. (FM Data API uses an array of
  // {field:value} objects to express OR.) "Filename" holds the asset
  // filename like "GCAT00001.wav" on this layout.
  const queries = []
  if (isrc)     queries.push({ ISRC: `==${isrc}` })
  if (filename) queries.push({ Filename: `==${filename}` })
  // GMVi is intentionally not used as a track-uniqueness key — it's the
  // album's artwork ID. Including it here would cause cross-track collisions.
  if (!queries.length) {
    if (gmvi) console.warn(`[MadStreamer] findMp3Record called with only GMVi (${gmvi}) — refusing to use it as a track key`)
    return null
  }

  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: queries, limit: '1' })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer track lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return { recordId: String(rec.recordId), fieldData: rec.fieldData }
}

/**
 * Build the field payload sent to API_Album_Songs in MadStreamer.
 * Field names mirror the Gallo Catalogue layout — same naming convention is
 * used on both DBs. If a field doesn't exist on your MadStreamer layout it
 * will be silently ignored by FileMaker.
 */
// Field map for MadStreamer's API_Album_Songs layout. Aligned with the actual
// schema (verified via /api/ingest/madstreamer/layout-fields). Fields that
// don't exist on the layout (Explicit, BPM, Publishers, etc.) are simply not
// sent. The layout has no container fields and no GMVi field — Web Viewer
// constructs S3 URLs from "Audio File" (filename) and from the related
// Artwork layout where GMVi lives.
// "Duration" on the streamer is a FileMaker TIME field: a bare number like
// "275" is parsed as 275 HOURS (→ "275:00:00") and "4:35" as 4h35m. Every
// write must be a full zero-padded HH:MM:SS. Accepts seconds (number or
// numeric string), "M:SS", "H:MM:SS", or ISO-8601 "PT4M35S"; null if unparseable.
function durationToFmTime(v) {
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
        sec = Math.round((+iso[1] || 0) * 3600 + (+iso[2] || 0) * 60 + (+iso[3] || 0))
      } else {
        const parts = s.split(':').map(p => parseFloat(p))
        if (parts.length && parts.every(n => !isNaN(n))) {
          if (parts.length === 3)      sec = Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
          else if (parts.length === 2) sec = Math.round(parts[0] * 60 + parts[1])
        }
      }
    }
  }
  if (sec == null) return null
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`
}

// Dates are written ISO, YYYY-MM-DD. Gallo is inconsistent at source —
// release_date comes US-style ("1/1/2021"), original_release_date already ISO
// ("2021-01-01") — so normalise both rather than passing through whatever
// happens to arrive. Unrecognised formats are left alone rather than guessed
// at: a wrong date is worse than an unconverted one.
function toFmDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)   // M/D/YYYY
  if (!m) return s
  const pad = n => String(n).padStart(2, '0')
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}`
}

// DDEX ParentalWarningType, matching what lib/ddex-*.js already emits. Gallo
// gives a boolean; FileMaker will not accept one.
function toParentalRating(v) {
  if (v === true  || v === 'true'  || v === 1 || v === '1' || /^(yes|explicit)$/i.test(String(v))) return 'Explicit'
  if (v === false || v === 'false' || v === 0 || v === '0' || /^(no|notexplicit)$/i.test(String(v))) return 'NotExplicit'
  return ''
}

function buildFieldData(metadata) {
  const fd = {}

  // Audio asset filename → "Filename" text field (e.g. "GCAT00001.wav").
  // We deliberately do NOT write to "Audio File" on streamer.
  if (metadata.filename)        fd['Filename']                     = metadata.filename

  // Track identity
  if (metadata.title)           fd['Track Name']                   = metadata.title
  if (metadata.artist)          fd['Track Artist']                 = metadata.artist
  if (metadata.album_artist)    fd['Album Artist']                 = metadata.album_artist
  if (metadata.album)           fd['Album Title']                  = metadata.album
  // Send to BOTH 'Album Catalogue Number' and 'Reference Catalogue Number'.
  // Introspection filter drops whichever doesn't exist on this layout.
  if (metadata.catalogue_no) {  fd['Album Catalogue Number']      = metadata.catalogue_no
                                fd['Reference Catalogue Number']  = metadata.catalogue_no }
  if (metadata.isrc)            fd['ISRC']                         = metadata.isrc
  if (metadata.barcode)         fd['UPC']                          = String(metadata.barcode)
  if (metadata.sequence_no)     fd['Sequence Number']              = String(metadata.sequence_no)

  // Release details
  if (metadata.year)            fd['Year of Release']              = String(metadata.year)
  // Original Release date must come from the ORIGINAL date, not the release
  // date — a 1975 recording reissued in 1999 should read 1975. Deliberately no
  // fallback to release_date: writing the reissue date here is the bug being
  // fixed, and a blank field is honest where a wrong date is not.
  {
    const d = toFmDate(metadata.original_release_date)
    if (d)                      fd['Original Release date']        = d
  }
  if (metadata.label)           fd['Label']                        = metadata.label
  // These live in the Songs table and are visible on the FileMaker "Songs"
  // layout, but the Data API only sees fields placed on API_Album_Songs.
  // 'Filename.wav' is deliberately NOT written: the dot in the field name is
  // rejected by the Data API ("Parameter is invalid"), and the field is being
  // retired. 'Filename' already carries the bare GCAT.
  // upsertSong filters against the live layout, so any not yet placed are
  // dropped harmlessly — they start populating the moment they are added,
  // with no further code change.
  if (metadata.technical_resource)
                                fd['Technical Resource']           = metadata.technical_resource
  if (metadata.audio_hash)      fd['AudioHashSum']                 = metadata.audio_hash
  if (metadata.resource_reference)
                                fd['Resource Reference']           = metadata.resource_reference
  if (metadata.country)         fd['Country']                      = metadata.country
  // The FM field is called 'Lyrical Content Rating', not 'Parental' — the
  // layout label reads Parental but the underlying field name differs, and the
  // Data API keys on the field name.
  {
    const r = toParentalRating(metadata.explicit)
    if (r)                      fd['Lyrical Content Rating']       = r
  }
  if (metadata.p_line)          fd['pLine']                        = metadata.p_line
  if (metadata.c_line)          fd['cLine']                        = metadata.c_line
  // Genre goes through the agreed 45-value vocabulary. MadStreamer's Local
  // Genre was normalised from 175 values to 45 (11,193 records); writing a raw
  // upstream value here would undo that one record at a time. An unrecognised
  // genre is SKIPPED, not guessed — the track keeps whatever Streamer already
  // has, or stays blank and lands in the repair queue.
  {
    const g = normalizeGenre(metadata.genre)
    if (g) {                    fd['Local Genre']                  = g
                                fd['Genre']                        = g }
    else if (metadata.genre)    console.warn(`[madstreamer] unrecognised genre ${JSON.stringify(metadata.genre)} — not written (add it to lib/genre-taxonomy.js if it is real)`)
  }
  if (metadata.language) {
    fd['Language'] = metadata.language
    const iso = metadata.language.length <= 3
      ? metadata.language
      : languageNameToCode(metadata.language)
    if (iso) fd['Language Code'] = iso
  }
  if (metadata.duration) {
    const fmTime = durationToFmTime(metadata.duration)
    if (fmTime) fd['Duration'] = fmTime
  }

  // Credits
  if (metadata.composers)       fd['Composers']                    = metadata.composers
  if (metadata.producers)       fd['Producers']                    = metadata.producers

  // Audio S3 URL — populated by the audio push (Web Viewer pulls from here)
  if (metadata.audio_url)       fd['S3_URL']                       = metadata.audio_url

  // Note: GMVi, Explicit, BPM, Publishers, MP3 URL, WAV URL, Artwork URL,
  // File URL, Release Date, Filename, Barcode are intentionally NOT sent —
  // they don't exist on this layout. Field introspection will silently drop
  // any that slip through anyway.
  return fd
}

/**
 * Find existing MP3 record (by GMVi, falling back to ISRC) and update it,
 * or create a new one if none exists.
 *
 * @param {object} metadata — track + URL metadata
 * @returns {{ recordId: string, action: 'created'|'updated' }}
 */
// Fields added later than the original sync. Any of these may turn out to be
// unwritable on a given deployment; the writer learns which and carries on.
const SONG_EXTRA_FIELDS = new Set([
  'Technical Resource', 'AudioHashSum', 'Resource Reference', 'Country',
  'Lyrical Content Rating', 'Label', 'pLine', 'cLine', 'Original Release date'
])
const _rejectedSongFields = new Set()

export async function upsertMp3Record(metadata) {
  // Look up the track by ISRC (preferred) or Filename — both unique per track.
  // GMVi is album-level and would collide across tracks on the same album.
  const existing = await findMp3Record({
    isrc:     metadata.isrc,
    filename: metadata.filename,
  })
  const rawFieldData = buildFieldData(metadata)

  // Filter to fields that actually exist on the layout. FileMaker rejects
  // the whole request if any unknown field is present.
  const known = await getLayoutFields(MADSTREAMER_FM_LAYOUT)
  const { kept: fieldData, dropped } = filterToKnownFields(rawFieldData, known)
  if (dropped.length) {
    console.warn(`[MadStreamer] Dropped ${dropped.length} unknown field(s): ${dropped.join(', ')}`)
  }
  if (Object.keys(fieldData).length === 0) {
    throw new Error(`No matching fields on MadStreamer ${MADSTREAMER_FM_LAYOUT} — none of [${Object.keys(rawFieldData).join(', ')}] exist on the layout. Check field names or layout config.`)
  }

  // A field can exist on the layout and still be unwritable — calculations,
  // summaries, auto-enter-only fields — and FileMaker reports that as a flat
  // "Parameter is invalid" naming nothing. Rather than have the whole sync die
  // on one bad field, write the core first, then add the optional extras and
  // learn which ones the server refuses. Refusals are remembered for the rest
  // of the process, so the cost is paid once, not per track.
  const extrasPresent = Object.keys(fieldData).filter(k => SONG_EXTRA_FIELDS.has(k))
  for (const k of _rejectedSongFields) delete fieldData[k]

  const send = async (recordId, body) => {
    const res = recordId
      ? await msFetch(`/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${recordId}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData: body }) })
      : await msFetch(`/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records`,
          { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData: body }) })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, json, msg: json?.messages?.[0]?.message || `HTTP ${res.status}` }
  }

  const verb = existing ? 'update' : 'create'
  let r = await send(existing?.recordId || null, fieldData)

  if (!r.ok && extrasPresent.some(k => k in fieldData)) {
    // Retry with only the fields we have always written. If that works, the
    // fault is in one of the extras and we can name it.
    const core = { ...fieldData }
    for (const k of extrasPresent) delete core[k]
    const bare = await send(existing?.recordId || null, core)
    if (bare.ok) {
      const recordId = existing?.recordId || String(bare.json?.response?.recordId || '')
      for (const k of extrasPresent) {
        const probe = await send(recordId, { [k]: fieldData[k] })
        if (!probe.ok) {
          _rejectedSongFields.add(k)
          console.warn(`[MadStreamer] Field "${k}" refused by FileMaker (${probe.msg}) — skipping it from here on. ` +
                       `Usually means the field is a calculation, a summary, or otherwise not modifiable.`)
        }
      }
      return { recordId, action: existing ? 'updated' : 'created', dropped,
               rejected: [..._rejectedSongFields] }
    }
    r = bare   // core alone also failed — report that, it is the real problem
  }

  if (!r.ok) throw new Error(`MadStreamer track record ${verb} failed: ${r.msg}`)
  return {
    recordId: existing?.recordId || String(r.json?.response?.recordId || ''),
    action:   existing ? 'updated' : 'created',
    dropped,
    rejected: [..._rejectedSongFields]
  }
}

// ── Tape Files Master (album-level) ──────────────────────────────────────
// One record per catalogue, keyed by Reference Catalogue Number. Mirrors
// Gallo's createTapeFileRecord pattern. Album-level fields only — no track
// data. The introspection filter handles whatever extra fields exist on the
// MadStreamer layout (Featured, New_Release, Artwork_S3_URL, etc.).

function buildTapeFieldData(album) {
  const fd = {}
  if (album.album_artist || album.artist)
                                fd['Album Artist']               = album.album_artist || album.artist
  if (album.album)              fd['Album Title']                = album.album
  if (album.catalogue_no)    {  fd['Album Catalogue Number']     = album.catalogue_no
                                fd['Reference Catalogue Number'] = album.catalogue_no }
  // Optional extras — included only when known. Filtered by introspection
  // if the layout doesn't have them.
  if (album.barcode)            fd['UPC']                        = String(album.barcode)
  if (album.year)               fd['Year of Release']            = String(album.year)
  {
    const d = toFmDate(album.original_release_date)
    if (d)                      fd['Original Release date']      = d
  }
  // Same vocabulary guard as toSongFieldData — see lib/genre-taxonomy.js.
  {
    const g = normalizeGenre(album.genre)
    if (g) {                    fd['Local Genre']                = g
                                fd['Genre']                      = g }
    else if (album.genre)       console.warn(`[madstreamer] unrecognised album genre ${JSON.stringify(album.genre)} — not written`)
  }
  return fd
}

export async function findTapeFileByCatalogue(catalogueNo) {
  if (!catalogueNo) return null
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_TAPE_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Album Catalogue Number':     `==${catalogueNo}` },
          { 'Reference Catalogue Number': `==${catalogueNo}` },
        ],
        limit: '5'   // see below — one is normal, more is a fault worth naming
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer Tape Files lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rows = json?.response?.data || []
  if (!rows.length) return null
  // This used to ask for one record and take it. Duplicate album records do
  // happen (an import run twice), and the blank one silently won the lookup —
  // hiding a perfectly good cover on CDGMP40296 while FileMaker showed it fine,
  // because the operator was looking at the OTHER record (2026-08-06). Prefer
  // the populated record and say plainly that the duplicate is there.
  const rec = rows.find(r => String(r.fieldData?.['Artwork_S3_URL'] || '').trim()) || rows[0]
  if (rows.length > 1) {
    console.warn(`[madstreamer] ${rows.length} Tape Files Master records for catalogue "${catalogueNo}" ` +
      `(recordIds ${rows.map(r => r.recordId).join(', ')}) — using ${rec.recordId}, which has the artwork URL. ` +
      `Delete the duplicates.`)
  }
  return {
    recordId:  String(rec.recordId),
    fieldData: rec.fieldData,
    duplicates: rows.length > 1 ? rows.map(r => String(r.recordId)) : null,
  }
}

export async function upsertTapeFileRecord(album) {
  if (!album.catalogue_no) {
    throw new Error('Cannot upsert Tape Files Master without a catalogue number')
  }

  const existing = await findTapeFileByCatalogue(album.catalogue_no)
  const rawFieldData = buildTapeFieldData(album)

  // Filter to fields that exist on the Tape Files Master layout.
  const known = await getLayoutFields(MADSTREAMER_FM_TAPE_LAYOUT)
  const { kept: fieldData, dropped } = filterToKnownFields(rawFieldData, known)
  if (dropped.length) {
    console.warn(`[MadStreamer Tape Files] Dropped ${dropped.length} unknown field(s): ${dropped.join(', ')}`)
  }
  if (Object.keys(fieldData).length === 0) {
    throw new Error(`No matching fields on MadStreamer ${MADSTREAMER_FM_TAPE_LAYOUT} — none of [${Object.keys(rawFieldData).join(', ')}] exist on the layout.`)
  }

  if (existing) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_TAPE_LAYOUT)}/records/${existing.recordId}`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Tape Files update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: existing.recordId, action: 'updated', dropped }
  } else {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_TAPE_LAYOUT)}/records`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Tape Files create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: String(json?.response?.recordId || ''), action: 'created', dropped }
  }
}

// ── Artist Bio (API_Artist_Bio) ──────────────────────────────────────────
// One record per artist. Fields are sent under a couple of common name
// spellings ("Artist Name"/"Artist", "Bio"/"Biography") — layout
// introspection drops whichever doesn't actually exist, same as the
// catalogue-number trick used above. "Active" is always forced to 1 the
// moment a record is committed (created or updated) from this tool.

function buildBioFieldData({ artistName, bio }) {
  const fd = {}
  if (artistName) fd['Artist_Name'] = artistName
  if (bio != null) fd['Bio'] = bio
  // Always mark active on commit — FM Data API accepts numbers as strings.
  fd['Active'] = 1
  return fd
}

/**
 * Find an existing bio record by artist name (Artist_Name field).
 * Returns { recordId, fieldData } or null.
 */
export async function findArtistBio(artistName) {
  if (!artistName) return null
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_BIO_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Artist_Name': `==${artistName}` },
        ],
        limit: '1'
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer Artist Bio lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return { recordId: String(rec.recordId), fieldData: rec.fieldData }
}

/**
 * Create or update the bio record for an artist, forcing Active = 1 on the
 * record that gets committed.
 *
 * @param {object} data — { artistName, bio }
 * @returns {{ recordId: string, action: 'created'|'updated', dropped: string[] }}
 */
export async function upsertArtistBio({ artistName, bio }) {
  if (!artistName) throw new Error('Artist name is required to save a bio')

  const existing = await findArtistBio(artistName)
  const rawFieldData = buildBioFieldData({ artistName, bio })

  // Filter to fields that actually exist on the Artist Bio layout.
  const known = await getLayoutFields(MADSTREAMER_FM_BIO_LAYOUT)
  const { kept: fieldData, dropped } = filterToKnownFields(rawFieldData, known)
  if (dropped.length) {
    console.warn(`[MadStreamer Artist Bio] Dropped ${dropped.length} unknown field(s): ${dropped.join(', ')}`)
  }
  if (Object.keys(fieldData).length === 0) {
    throw new Error(`No matching fields on MadStreamer ${MADSTREAMER_FM_BIO_LAYOUT} — none of [${Object.keys(rawFieldData).join(', ')}] exist on the layout. Check field names or layout config.`)
  }

  if (existing) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_BIO_LAYOUT)}/records/${existing.recordId}`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Artist Bio update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: existing.recordId, action: 'updated', dropped }
  } else {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_BIO_LAYOUT)}/records`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Artist Bio create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: String(json?.response?.recordId || ''), action: 'created', dropped }
  }
}

/** All artist bio rows — for the admin list / edit lookup. */
export async function listArtistBios(limit = 1000) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_BIO_LAYOUT)}/records?_limit=${limit}`,
    { method: 'GET' }
  )
  const json = await res.json().catch(() => ({}))
  if (json?.response?.data) {
    return json.response.data.map(r => {
      const f = r.fieldData || {}
      return {
        recordId:   String(r.recordId || ''),
        artistName: f['Artist_Name'] || '',
        bio:        f['Bio'] || '',
        active:     f['Active'],
      }
    })
  }
  if (json?.messages?.[0]?.code === '401') return []
  throw new Error(`Artist Bio list failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
}

// ── Playlist Art (API_Playlist_Art) ──────────────────────────────────────
// One record per public playlist, keyed by Playlist_Name (matches the
// PublicPlaylist value the streamer groups on). Holds the cover's S3 URL.
// "Active" is forced to 1 on commit, same as bios. Mirrors upsertArtistBio.

const MADSTREAMER_FM_PLAYLIST_ART_LAYOUT =
  process.env.MADSTREAMER_FM_PLAYLIST_ART_LAYOUT || 'API_Playlist_Art'

/**
 * Category classifies the PLAYLIST, not its tracks — one value per playlist
 * rather than a tag on thousands of records. It drives which rail a playlist
 * appears on: Scene, Artist, Decade, Theme. A playlist with no Category simply
 * doesn't appear on a categorised rail, which is the safe default: a new
 * playlist stays invisible until someone deliberately files it.
 */
export const PLAYLIST_CATEGORIES = Object.freeze(['Scene', 'Artist', 'Decade', 'Theme'])

function buildPlaylistArtFieldData({ playlistName, imageUrl, category }) {
  const fd = {}
  if (playlistName)     fd['Playlist_Name'] = playlistName
  if (imageUrl != null) fd['Image_S3_URL']  = imageUrl
  // Only write Category when supplied — an omitted value must leave the
  // existing one alone, not blank it. Passing '' explicitly DOES clear it.
  if (category != null) fd['Category']      = String(category).trim()
  fd['Active'] = 1
  return fd
}

export async function findPlaylistArt(playlistName) {
  if (!playlistName) return null
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: [{ 'Playlist_Name': `==${playlistName}` }], limit: '1' })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer Playlist Art lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return { recordId: String(rec.recordId), fieldData: rec.fieldData }
}

export async function upsertPlaylistArt({ playlistName, imageUrl, category }) {
  if (!playlistName) throw new Error('Playlist name is required to save playlist art')

  const existing = await findPlaylistArt(playlistName)
  const rawFieldData = buildPlaylistArtFieldData({ playlistName, imageUrl, category })

  const known = await getLayoutFields(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)
  const { kept: fieldData, dropped } = filterToKnownFields(rawFieldData, known)
  if (dropped.length) {
    console.warn(`[MadStreamer Playlist Art] Dropped ${dropped.length} unknown field(s): ${dropped.join(', ')}`)
  }
  if (Object.keys(fieldData).length === 0) {
    throw new Error(`No matching fields on MadStreamer ${MADSTREAMER_FM_PLAYLIST_ART_LAYOUT} — none of [${Object.keys(rawFieldData).join(', ')}] exist on the layout. Check field names or layout config.`)
  }

  if (existing) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)}/records/${existing.recordId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData }) }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Playlist Art update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: existing.recordId, action: 'updated', dropped }
  } else {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)}/records`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData }) }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer Playlist Art create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: String(json?.response?.recordId || ''), action: 'created', dropped }
  }
}

/**
 * Delete a playlist-art record.
 *
 * Deletes the FileMaker record ONLY — the S3 object is deliberately left in
 * place. Upload keys are timestamped (see uploadPlaylistArt), so the object is
 * orphaned rather than reused, which is the point: a path the CDN has already
 * seen can never be trusted again. An orphaned image costs pennies; a wrongly
 * deleted cover costs a re-make. The usual reason for deleting is a record
 * created under a mistyped playlist name, where the image itself is fine and
 * about to be re-uploaded under the right one.
 */
export async function deletePlaylistArt(recordId) {
  const id = String(recordId || '').trim()
  if (!id) throw new Error('recordId required')
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)}/records/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Playlist Art delete failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return { recordId: id, deleted: true }
}

export async function listPlaylistArt(limit = 1000) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_PLAYLIST_ART_LAYOUT)}/records?_limit=${limit}`,
    { method: 'GET' }
  )
  const json = await res.json().catch(() => ({}))
  if (json?.response?.data) {
    return json.response.data.map(r => {
      const f = r.fieldData || {}
      return {
        recordId:     String(r.recordId || ''),
        playlistName: f['Playlist_Name'] || '',
        imageUrl:     f['Image_S3_URL'] || '',
        category:     String(f['Category'] ?? '').trim(),
        active:       f['Active'],
      }
    })
  }
  if (json?.messages?.[0]?.code === '401') return []
  throw new Error(`Playlist Art list failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
}

export async function pingMadStreamer() {
  try { await getToken(); return true } catch { return false }
}

/**
 * Distinct catalogue numbers on MadStreamer matching a wildcard, with a track
 * count each. Pages through — a prefix like "CCA_*" can match thousands of rows.
 * Used to compare coverage against Gallo Catalogue.
 */
export async function listStreamerCataloguesByPrefix(prefix, { field = 'Album Catalogue Number', pageSize = 500 } = {}) {
  const out = new Map()
  for (let offset = 1; ; offset += pageSize) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ [field]: prefix }], limit: pageSize, offset }) }
    )
    const json = await res.json().catch(() => ({}))
    if (json?.messages?.[0]?.code === '401') break          // no (more) matches
    if (!res.ok) throw new Error(`MadStreamer catalogue scan failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    const rows = json?.response?.data || []
    for (const r of rows) {
      const c = String(r.fieldData?.[field] || '').trim()
      if (c) out.set(c, (out.get(c) || 0) + 1)
    }
    if (rows.length < pageSize) break
  }
  return out
}

/**
 * Find every API_Album_Songs record on MadStreamer for a given catalogue.
 * Returns lightweight track summaries — enough for the 3-DB status check.
 * Uses OR-find across Reference Catalogue Number / Album Catalogue Number.
 */
export async function findRecordsByCatalogue(catalogueNo) {
  if (!catalogueNo) return []
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Album Catalogue Number':     `==${catalogueNo}` },
          { 'Reference Catalogue Number': `==${catalogueNo}` },
        ],
        limit: 500,
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return []
    throw new Error(`MadStreamer findRecordsByCatalogue failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const records = (json?.response?.data || []).map(r => {
    const f   = r.fieldData || {}
    const seq = parseInt(String(f['Sequence Number'] ?? f['Track Number'] ?? '').trim(), 10)
    return {
      recordId:     String(r.recordId || ''),
      isrc:         f['ISRC']                                                || null,
      filename:     f['Filename']                                            || null,
      title:        f['Track Name']                                          || null,
      artist:       f['Track Artist']                                        || null,
      catalogue_no: f['Reference Catalogue Number'] || f['Album Catalogue Number'] || null,
      sequence_no:  isNaN(seq) ? null : seq,
    }
  })
  return records.sort((a, b) => (a.sequence_no ?? 999) - (b.sequence_no ?? 999))
}

/**
 * Free-text search across the MadStreamer track layout — mirrors
 * searchGalloRecords. OR-find on whichever candidate fields actually exist
 * on the layout (FM rejects the whole query if one field name is unknown).
 */
export async function searchMadStreamerRecords(term, { limit = 50 } = {}) {
  if (!term || term.trim().length < 2) return { tracks: [], foundCount: 0 }
  const t = term.trim()

  const known = await getLayoutFields(MADSTREAMER_FM_LAYOUT)
  const candidates = [
    'Track Name', 'Track Artist', 'Album Artist', 'Album Title',
    'ISRC', 'Album Catalogue Number', 'Reference Catalogue Number', 'Filename',
  ]
  const queries = candidates.filter(f => known.has(f)).map(f => ({ [f]: `*${t}*` }))
  if (!queries.length) return { tracks: [], foundCount: 0 }

  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: queries, limit }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return { tracks: [], foundCount: 0 } // no matches
    throw new Error(`MadStreamer search failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }

  const foundCount = Number(json?.response?.dataInfo?.foundCount ?? 0)
  const tracks = (json?.response?.data || []).map(r => {
    const f   = r.fieldData || {}
    const seq = parseInt(String(f['Sequence Number'] ?? f['Track Number'] ?? '').trim(), 10)
    return {
      fm_record_id: String(r.recordId || ''),
      title:        f['Track Name']    || null,
      artist_name:  f['Track Artist']  || f['Album Artist'] || null,
      album_title:  f['Album Title']   || null,
      catalogue_no: f['Reference Catalogue Number'] || f['Album Catalogue Number'] || null,
      isrc:         f['ISRC']          || null,
      sequence_no:  isNaN(seq) ? null : seq,
    }
  })
  return { tracks, foundCount }
}

// ── Public playlists ────────────────────────────────────────────────────────
// A streamer track belongs to a public playlist when its PublicPlaylist field
// on API_Album_Songs holds the playlist name — the streamer's curated view
// groups records by that value, so a track can be in ONE public playlist at a
// time and "creating" a playlist is just tagging records. These helpers drive
// the admin Playlists tab.

function mapPlaylistSong(r) {
  const f   = r.fieldData || {}
  const seq = parseInt(String(f['Sequence Number'] ?? f['Track Number'] ?? '').trim(), 10)
  return {
    recordId:     String(r.recordId || ''),
    title:        f['Track Name']    || null,
    artist:       f['Track Artist']  || f['Album Artist'] || null,
    album_artist: f['Album Artist']  || null,
    album:        f['Album Title']   || null,
    catalogue_no: f['Reference Catalogue Number'] || f['Album Catalogue Number'] || null,
    isrc:         f['ISRC'] || null,
    sequence_no:  isNaN(seq) ? null : seq,
    playlist:     String(f['PublicPlaylist'] || '').trim() || null,
    has_audio:    !!String(f['S3_URL'] || '').trim(),
    local_genre:  String(f['Local Genre'] || '').trim() || null,
    sub_genre:    String(f['Sub Genre'] || '').trim() || null,
  }
}

function sortByAlbumSeq(songs) {
  return songs.sort((a, b) =>
    String(a.album || '').localeCompare(String(b.album || ''), undefined, { sensitivity: 'base' }) ||
    (a.sequence_no ?? 999) - (b.sequence_no ?? 999) ||
    String(a.title || '').localeCompare(String(b.title || ''))
  )
}

export async function findStreamerSongsByArtist(term, { limit = 500 } = {}) {
  if (!term || term.trim().length < 2) return []
  const t = term.trim()
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Track Artist': `*${t}*` },
          { 'Album Artist': `*${t}*` },
        ],
        limit,
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return [] // no matches
    throw new Error(`MadStreamer artist search failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return sortByAlbumSeq((json?.response?.data || []).map(mapPlaylistSong))
}

/**
 * All streamer tracks in a genre (exact match on the normalised 'Local Genre'
 * 45-value vocabulary), optionally narrowed by a Sub Genre substring. Pages
 * through the Data API so big genres come back whole.
 */
export async function findStreamerSongsByGenre(genre, { sub = '', maxRecords = 8000 } = {}) {
  const g = String(genre || '').trim()
  if (!g) return []
  const query = [{ 'Local Genre': `==${g}`, ...(String(sub).trim() ? { 'Sub Genre': `*${String(sub).trim()}*` } : {}) }]
  const pageSize = 1000
  const out = []
  for (let offset = 1; out.length < maxRecords; offset += pageSize) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query, limit: pageSize, offset })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (json?.messages?.[0]?.code === '401') break   // no (more) matches
      throw new Error(`MadStreamer genre search failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    }
    const rows = json?.response?.data || []
    out.push(...rows.map(mapPlaylistSong))
    const found = Number(json?.response?.dataInfo?.foundCount ?? rows.length)
    if (offset - 1 + rows.length >= found || rows.length === 0) break
  }
  return sortByAlbumSeq(out)
}

export async function listPublicPlaylists() {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: [{ 'PublicPlaylist': '*' }], limit: 2000 })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return [] // none tagged yet
    throw new Error(`MadStreamer playlist list failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const byName = new Map()
  for (const r of json?.response?.data || []) {
    const name = String(r.fieldData?.PublicPlaylist || '').trim()
    if (!name) continue
    byName.set(name, (byName.get(name) || 0) + 1)
  }
  return [...byName.entries()]
    .map(([name, trackCount]) => ({ name, trackCount }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export async function findSongsByPlaylist(name) {
  if (!name) return []
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: [{ 'PublicPlaylist': `==${name}` }], limit: 2000 })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return []
    throw new Error(`MadStreamer playlist fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return sortByAlbumSeq((json?.response?.data || []).map(mapPlaylistSong))
}

/** Tag one record into a public playlist. Empty name clears the tag. */
export async function setPublicPlaylist(recordId, playlistName) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: { 'PublicPlaylist': playlistName } })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`PublicPlaylist update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
}

/** S3 audio URL for one streamer record (audition), or null if none. */
export async function getStreamerSongAudioUrl(recordId) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '101') return null // record missing
    throw new Error(`MadStreamer record fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const url = String(json?.response?.data?.[0]?.fieldData?.S3_URL || '').trim()
  return url || null
}

// ── YouTube asset generation (admin YouTube tab) ────────────────────────────
// The video generator renders from owned assets only: S3 audio + S3 artwork +
// FM metadata. These two helpers give it a search (pick tracks) and a full
// per-record pull (render inputs). Records missing audio or artwork are
// surfaced as ineligible rather than hidden, so the operator can see why a
// track can't be rendered.

function mapVideoSong(r) {
  const f = r.fieldData || {}
  const pick = (...names) => names.map(n => String(f[n] ?? '').trim()).find(Boolean) || ''
  // Some FM records hold a truncated artwork URL like "…/artwork/.jpg" (no
  // filename) — non-empty but useless (S3 403s). Treat those as no artwork
  // so the picker shows them ineligible instead of failing mid-render.
  const validUrl = u => (/\/\.\w+$/.test(u) || u.endsWith('/')) ? '' : u
  return {
    recordId:  String(r.recordId || ''),
    title:     pick('Track Name', 'Tape Files::Track Name'),
    artist:    pick('Track Artist', 'Tape Files::Track Artist', 'Album Artist'),
    album:     pick('Album Title', 'Tape Files::Album Title'),
    year:      pick('Year of Release'),
    genre:     pick('Genre', 'Local Genre'),
    pLine:     pick('pLine'),
    catalogue: pick('Album Catalogue Number', 'Reference Catalogue Number'),
    audioUrl:  validUrl(pick('S3_URL')),
    // Artwork lives on the related Tape Files record on API_Album_Songs
    artUrl:    validUrl(pick('Artwork_S3_URL', 'Tape Files::Artwork_S3_URL')),
  }
}

/** Search API_Album_Songs for the YouTube tab track picker. */
export async function searchSongsForVideo(term, { limit = 100 } = {}) {
  if (!term || term.trim().length < 2) return []
  const t = term.trim()
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Track Artist': `*${t}*` },
          { 'Album Artist': `*${t}*` },
          { 'Track Name':   `*${t}*` },
          { 'Album Title':  `*${t}*` },
        ],
        limit,
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return [] // no matches
    throw new Error(`MadStreamer video search failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return (json?.response?.data || []).map(mapVideoSong)
}

/** Full render inputs for one track. Returns null when the record is missing. */
export async function getSongForVideo(recordId) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '101') return null // record missing
    throw new Error(`MadStreamer record fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  return rec ? mapVideoSong(rec) : null
}

// ── Layout introspection ─────────────────────────────────────────────────
// FileMaker rejects a create/update when even ONE field name in the payload
// doesn't exist on the layout. So we fetch the layout's actual field list
// and filter buildFieldData output to only the fields it has. Cached for the
// life of the process; bust the cache via reloadLayoutFields().

const _layoutFieldCache = new Map() // layoutName → Set<string>

export async function getLayoutFields(layoutName = MADSTREAMER_FM_LAYOUT) {
  if (_layoutFieldCache.has(layoutName)) return _layoutFieldCache.get(layoutName)

  const res = await msFetch(`/layouts/${encodeURIComponent(layoutName)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`MadStreamer layout metadata fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const fields = new Set()
  // Field metadata is on response.fieldMetaData (camelCase varies by FM version).
  const meta = json?.response?.fieldMetaData || json?.response?.FieldMetaData || []
  for (const m of meta) {
    if (m?.name) fields.add(String(m.name))
  }
  // Portal/related fields (TableName::Field). Capture them too.
  const portals = json?.response?.portalMetaData || {}
  for (const p of Object.values(portals)) {
    for (const m of p || []) if (m?.name) fields.add(String(m.name))
  }

  _layoutFieldCache.set(layoutName, fields)
  return fields
}

export function reloadLayoutFields(layoutName) {
  if (layoutName) _layoutFieldCache.delete(layoutName)
  else _layoutFieldCache.clear()
}

/** Filter a fieldData payload down to fields that actually exist on the layout. */
export function filterToKnownFields(fieldData, knownFieldSet) {
  const kept = {}
  const dropped = []
  for (const [k, v] of Object.entries(fieldData)) {
    if (knownFieldSet.has(k)) kept[k] = v
    else dropped.push(k)
  }
  return { kept, dropped }
}

// Exposed for diagnostics / /madstreamer/ping
export const _config = {
  HOST, DB,
  USER_PRESENT:    !!USER,
  LAYOUT:          MADSTREAMER_FM_LAYOUT,
  ARTWORK_LAYOUT:  MADSTREAMER_FM_ARTWORK_LAYOUT,
  TAPE_LAYOUT:     MADSTREAMER_FM_TAPE_LAYOUT,
  BIO_LAYOUT:      MADSTREAMER_FM_BIO_LAYOUT,
  GMVI_FIELD:      MADSTREAMER_FM_GMVI_FIELD,
  CATALOGUE_FIELD: MADSTREAMER_FM_CATALOGUE_FIELD,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Podcasts (API_Podcasts layout, added 2026-06-11)
//
//  The MadStreamer app serves a Podcasts section from a single-table layout:
//  one row per EPISODE with the show's fields denormalised onto every row.
//  The ingest tool creates those rows; the streamer only ever reads them.
// ─────────────────────────────────────────────────────────────────────────────

const MADSTREAMER_FM_PODCASTS_LAYOUT =
  process.env.MADSTREAMER_FM_PODCASTS_LAYOUT || 'API_Podcasts'

/**
 * All podcast episode rows (one per episode). Returns [] when the table is
 * empty (FM reports "no records match" as error 401 on the GET).
 */
export async function listPodcastEpisodes(limit = 1000) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_PODCASTS_LAYOUT)}/records?_limit=${limit}`,
    { method: 'GET' }
  )
  const json = await res.json().catch(() => ({}))
  if (json?.response?.data) return json.response.data
  if (json?.messages?.[0]?.code === '401') return []
  throw new Error(`Podcasts list failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
}

/** Create one episode row. Returns { recordId, modId }. */
export async function createPodcastRecord(fieldData) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_PODCASTS_LAYOUT)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldData })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.response?.recordId) {
    throw new Error(`Podcast record create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return { recordId: json.response.recordId, modId: json.response.modId }
}

// ── Genre Fix (admin Genre Fix tab) ─────────────────────────────────────────
// Bulk re-classification workflow: list every track carrying a Local Genre,
// grouped by artist client-side, then re-tag an artist's tracks in one click.

/**
 * Every streamer track by an artist, whatever genre it currently carries.
 *
 * Backs the Genre Fix tab's "all tracks by this artist" option. Matches as a
 * SUBSTRING across both artist fields, because names fragment badly — "Mahotella
 * Queens", "Mahlathini and the Mahotella Queens" and "Peggy And Mahotella
 * Queens" are one act to a listener but three strings here.
 *
 * Returns the same shape as findSongsByLocalGenre so the tab can treat them
 * interchangeably. The CALLER decides which genres to actually move: sweeping
 * every track by an artist is usually wrong, since artists cross genres
 * legitimately (Ladysmith Black Mambazo have 106 gospel tracks that should stay
 * gospel).
 */
export async function findSongsByArtist(term, { maxRecords = 5000, pageSize = 500 } = {}) {
  const t = String(term || '').trim()
  if (t.length < 2) return []
  const seen = new Map()
  for (const field of ['Album Artist', 'Track Artist']) {
    let offset = 1
    while (seen.size < maxRecords) {
      const res = await msFetch(
        `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ query: [{ [field]: `*${t}*` }], limit: pageSize, offset })
        }
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (json?.messages?.[0]?.code === '401') break // no (more) matches
        throw new Error(`Artist find failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
      }
      const page = json?.response?.data || []
      for (const r of page) {
        const f = r.fieldData || {}
        seen.set(String(r.recordId), {
          recordId: String(r.recordId || ''),
          title:    f['Track Name']   || null,
          artist:   String(f['Track Artist'] || f['Album Artist'] || '').trim() || '(unknown artist)',
          album:    f['Album Title']  || null,
          year:     String(f['Year of Release'] || '').trim() || null,
          s3url:    String(f['S3_URL'] || '').trim() || null,
          localGenre: String(f['Local Genre'] || '').trim(),
        })
      }
      if (page.length < pageSize) break
      offset += page.length
    }
  }
  return [...seen.values()]
}

/** All streamer tracks whose Local Genre exactly matches `genre` (paged). */
export async function findSongsByLocalGenre(genre, { maxRecords = 15000, pageSize = 1000 } = {}) {
  const out = []
  let offset = 1
  while (out.length < maxRecords) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          query: [{ 'Local Genre': `==${genre}` }],
          limit: pageSize,
          offset,
        })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (json?.messages?.[0]?.code === '401') break // no (more) matches
      throw new Error(`Genre find failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    }
    const page = json?.response?.data || []
    for (const r of page) {
      const f = r.fieldData || {}
      out.push({
        recordId: String(r.recordId || ''),
        title:    f['Track Name']   || null,
        artist:   String(f['Track Artist'] || f['Album Artist'] || '').trim() || '(unknown artist)',
        album:    f['Album Title']  || null,
        year:     String(f['Year of Release'] || '').trim() || null,
        s3url:    String(f['S3_URL'] || '').trim() || null,
        localGenre: String(f['Local Genre'] || '').trim(),
        badAudio: String(f['Bad_Audio'] || '').trim(),
        faultyAudio: String(f['Faulty_Audio'] || '').trim(),
      })
    }
    if (page.length < pageSize) break
    offset += page.length
  }
  return out
}

/** Re-tag one record's Local Genre — and optionally its Sub Genre.
 *  subGenre semantics: undefined/null = leave the field untouched;
 *  a string (including '') = write it, so operators can also clear one. */
export async function setLocalGenre(recordId, genre, subGenre) {
  const fieldData = { 'Local Genre': genre }
  if (typeof subGenre === 'string') fieldData['Sub Genre'] = subGenre
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = json?.messages?.[0]?.code
    const hint = code === '102' && typeof subGenre === 'string'
      ? ' — is the Sub Genre field on the API_Album_Songs layout?' : ''
    throw new Error(`Local Genre update failed (record ${recordId}): ${json?.messages?.[0]?.message || `HTTP ${res.status}`}${hint}`)
  }
}

/** Audio problem flags the Genre Fix operators can set — two categories, each
 *  its own FM text field. The stored value is the flag date. Both fields must
 *  be ON the API_Album_Songs layout. */
export const AUDIO_FLAG_FIELDS = { bad: 'Bad_Audio', faulty: 'Faulty_Audio' }

/** Flag (or clear) a record's audio problem. kind: 'bad' | 'faulty'. */
export async function setAudioFlag(recordId, kind, flag) {
  const field = AUDIO_FLAG_FIELDS[kind]
  if (!field) throw new Error(`Unknown audio flag kind "${kind}"`)
  const value = flag ? new Date().toISOString().slice(0, 10) : ''
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: { [field]: value } })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = json?.messages?.[0]?.code
    const hint = code === '102' ? ` — is the ${field} field on the API_Album_Songs layout?` : ''
    throw new Error(`${field} update failed (record ${recordId}): ${json?.messages?.[0]?.message || `HTTP ${res.status}`}${hint}`)
  }
  return value
}

/** Every record carrying either audio flag — the audio-repair worklist.
 *  The two query entries are OR'd by FileMaker, so one find covers both. */
export async function findAudioFlaggedSongs({ maxRecords = 5000, pageSize = 500 } = {}) {
  const out = []
  let offset = 1
  while (out.length < maxRecords) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          query: [{ 'Bad_Audio': '*' }, { 'Faulty_Audio': '*' }],
          limit: pageSize,
          offset
        })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (json?.messages?.[0]?.code === '401') break // no (more) matches
      const code = json?.messages?.[0]?.code
      const hint = code === '102' ? ' — are Bad_Audio AND Faulty_Audio both on the API_Album_Songs layout?' : ''
      throw new Error(`Audio-flag find failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}${hint}`)
    }
    const page = json?.response?.data || []
    for (const r of page) {
      const f = r.fieldData || {}
      out.push({
        recordId:  String(r.recordId || ''),
        title:     f['Track Name']   || null,
        artist:    String(f['Track Artist'] || f['Album Artist'] || '').trim() || '(unknown artist)',
        album:     f['Album Title']  || null,
        catalogue: f['Reference Catalogue Number'] || f['Album Catalogue Number'] || null,
        year:      String(f['Year of Release'] || '').trim() || null,
        s3url:     String(f['S3_URL'] || '').trim() || null,
        badAudio:    String(f['Bad_Audio'] || '').trim(),
        faultyAudio: String(f['Faulty_Audio'] || '').trim(),
      })
    }
    if (page.length < pageSize) break
    offset += page.length
  }
  return out
}

// ── Download Track tab ──────────────────────────────────────────────────────
// Operator searches by artist and/or track name, auditions, downloads the S3
// master through the server proxy (routes/download-track.js).

function mapDownloadRow(r) {
  const f = r.fieldData || {}
  return {
    recordId: String(r.recordId || ''),
    title:    f['Track Name']   || null,
    artist:   String(f['Track Artist'] || f['Album Artist'] || '').trim() || '(unknown artist)',
    album:    f['Album Title']  || null,
    catalogue: f['Reference Catalogue Number'] || f['Album Catalogue Number'] || null,
    year:     String(f['Year of Release'] || '').trim() || null,
    s3url:    String(f['S3_URL'] || '').trim() || null,
  }
}

/** Streamer tracks matching artist and/or track name (Download Track tab).
 *  Artist matches Track Artist OR Album Artist; when both terms are given
 *  they AND inside each query object (FM ORs across objects). */
export async function findStreamerTracks({ artist = '', track = '' } = {}, { limit = 300 } = {}) {
  const a = String(artist).trim()
  const t = String(track).trim()
  if (a.length < 2 && t.length < 2) return []
  let query
  if (a && t) {
    query = [
      { 'Track Artist': `*${a}*`, 'Track Name': `*${t}*` },
      { 'Album Artist': `*${a}*`, 'Track Name': `*${t}*` },
    ]
  } else if (a) {
    query = [{ 'Track Artist': `*${a}*` }, { 'Album Artist': `*${a}*` }]
  } else {
    query = [{ 'Track Name': `*${t}*` }]
  }
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, limit }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return [] // no matches
    throw new Error(`Track search failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return (json?.response?.data || []).map(mapDownloadRow).sort((x, y) =>
    String(x.artist).localeCompare(String(y.artist), undefined, { sensitivity: 'base' }) ||
    String(x.album || '').localeCompare(String(y.album || ''), undefined, { sensitivity: 'base' }) ||
    String(x.title || '').localeCompare(String(y.title || ''))
  )
}

/** One streamer record by FM recordId (download proxy resolves the S3 URL
 *  server-side so the route never proxies an arbitrary caller-supplied URL). */
export async function getStreamerTrackById(recordId) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${encodeURIComponent(recordId)}`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (String(json?.messages?.[0]?.code) === '101') return null // record missing
    throw new Error(`Track fetch failed (record ${recordId}): ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const data = json?.response?.data?.[0]
  return data ? mapDownloadRow(data) : null
}

// ── Hero banners (API_Hero_Featured) ────────────────────────────────────────
// The home carousel on musicafricadirect.com. The app reads this layout via
// routes/featured-editorial.js and renders whatever URL is stored — there is NO
// S3→CDN rewrite anywhere in it, so the URL written here is the one visitors
// fetch. See docs/banners.md in madmusicv2.1 for the image spec.
//
// A slide is DROPPED by the reader unless Title, Image_S3_URL and a recognised
// Target_Type are all present, so those are required here rather than letting a
// half-filled record look fine in FileMaker and vanish on the site.
const MADSTREAMER_FM_HERO_LAYOUT = process.env.MADSTREAMER_FM_HERO_LAYOUT || 'API_Hero_Featured'
export const HERO_TARGET_TYPES = ['track', 'album', 'playlist', 'external']

// Only these two do anything when clicked: the app plays a track or opens an
// external URL. album/playlist have no open-by-recordId path in v2.1 — a slide
// set to either renders but is inert.
export const HERO_TARGET_TYPES_LIVE = ['track', 'external']

// The hero date fields want MM/DD/YYYY. FileMaker rejects ISO outright —
// "Date value does not meet validation entry options" — and the tab's
// <input type="date"> hands over YYYY-MM-DD, so a banner with a Show-until
// date failed to save at all (Ian, 2026-08-07). Verified against the live
// layout: ISO and DD/MM/YYYY rejected, MM/DD/YYYY accepted and stored verbatim.
//
// Note this is the OPPOSITE of toFmDate() above, which writes ISO for the song
// layouts and is correct there — the two layouts genuinely differ, so they get
// their own converter rather than one being bent to fit both.
function toHeroDate(v) {
  const t = String(v ?? '').trim()
  if (!t) return ''
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`
  return t                                   // already MM/DD/YYYY, or unknown
}

function mapHero(rec) {
  const f = rec.fieldData || {}
  return {
    recordId:   String(rec.recordId),
    title:      String(f.Title || '').trim(),
    eyebrow:    String(f.Eyebrow || '').trim(),
    imageUrl:   String(f.Image_S3_URL || '').trim(),
    targetType: String(f.Target_Type || '').trim().toLowerCase(),
    targetId:   String(f.Target_ID || '').trim(),
    ctaLabel:   String(f.CTA_Label || '').trim(),
    sortOrder:  String(f.Sort_Order ?? '').trim(),
    active:     String(f.Active ?? '').trim() === '1',
    startDate:  String(f.Start_Date || '').trim(),
    endDate:    String(f.End_Date || '').trim(),
  }
}

/** Every hero banner, newest first by Sort_Order. */
export async function listHeroBanners() {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_HERO_LAYOUT)}/records?_limit=200`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return []      // no records yet
    throw new Error(`Hero list failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return (json?.response?.data || []).map(mapHero)
    .sort((a, b) => (parseInt(a.sortOrder, 10) || 999) - (parseInt(b.sortOrder, 10) || 999))
}

/** Create one banner. Returns its recordId. */
export async function createHeroBanner(b = {}) {
  const title = String(b.title || '').trim()
  const image = String(b.imageUrl || '').trim()
  const type  = String(b.targetType || '').trim().toLowerCase()
  if (!title) throw new Error('Title is required — the site drops a slide without one')
  if (!image) throw new Error('Image URL is required — the site drops a slide without one')
  if (!HERO_TARGET_TYPES.includes(type)) {
    throw new Error(`Target_Type must be one of: ${HERO_TARGET_TYPES.join(', ')}`)
  }

  const fieldData = {
    Title:        title,
    Image_S3_URL: image,
    Target_Type:  type,
    Target_ID:    String(b.targetId || '').trim(),
    Active:       b.active === false ? '0' : '1',
  }
  if (b.eyebrow)   fieldData.Eyebrow    = String(b.eyebrow).trim()
  if (b.ctaLabel)  fieldData.CTA_Label  = String(b.ctaLabel).trim()
  if (b.sortOrder !== undefined && b.sortOrder !== null && String(b.sortOrder).trim() !== '') {
    fieldData.Sort_Order = String(b.sortOrder).trim()
  }
  if (b.startDate) fieldData.Start_Date = toHeroDate(b.startDate)
  if (b.endDate)   fieldData.End_Date   = toHeroDate(b.endDate)

  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_HERO_LAYOUT)}/records`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData }) }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Hero create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  return { recordId: String(json?.response?.recordId || '') }
}

/** Patch a banner — used for Active and Sort_Order from the list. */
export async function updateHeroBanner(recordId, patch = {}) {
  const allowed = {
    active:    'Active', sortOrder: 'Sort_Order', title: 'Title', eyebrow: 'Eyebrow',
    ctaLabel:  'CTA_Label', targetType: 'Target_Type', targetId: 'Target_ID',
    startDate: 'Start_Date', endDate: 'End_Date', imageUrl: 'Image_S3_URL',
  }
  const fieldData = {}
  for (const [k, fmField] of Object.entries(allowed)) {
    if (patch[k] === undefined) continue
    fieldData[fmField] = k === 'active' ? (patch[k] ? '1' : '0')
      : (k === 'startDate' || k === 'endDate') ? toHeroDate(patch[k])
      : String(patch[k])
  }
  if (!Object.keys(fieldData).length) throw new Error('nothing to update')

  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_HERO_LAYOUT)}/records/${encodeURIComponent(recordId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldData }) }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Hero update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  return { ok: true }
}

/** Delete a banner outright. Deactivating is usually what you want instead. */
export async function deleteHeroBanner(recordId) {
  const res = await msFetch(
    `/layouts/${encodeURIComponent(MADSTREAMER_FM_HERO_LAYOUT)}/records/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Hero delete failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  return { ok: true }
}
