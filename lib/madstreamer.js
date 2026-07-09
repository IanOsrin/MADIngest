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
        limit: 1,
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`Artwork lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return {
    recordId:  String(rec.recordId),
    gmvi:      String(rec.fieldData?.[MADSTREAMER_FM_GMVI_FIELD] || '').trim() || null,
    fieldData: rec.fieldData || {},
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
  if (metadata.release_date)    fd['Original Release date']        = metadata.release_date
  if (metadata.genre) {         fd['Local Genre']                  = metadata.genre
                                fd['Genre']                        = metadata.genre }
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

  if (existing) {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records/${existing.recordId}`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer track record update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: existing.recordId, action: 'updated', dropped }
  } else {
    const res = await msFetch(
      `/layouts/${encodeURIComponent(MADSTREAMER_FM_LAYOUT)}/records`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fieldData })
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`MadStreamer track record create failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
    return { recordId: String(json?.response?.recordId || ''), action: 'created', dropped }
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
  if (album.release_date)       fd['Original Release date']      = album.release_date
  if (album.genre) {            fd['Local Genre']                = album.genre
                                fd['Genre']                      = album.genre }
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
        limit: '1'
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`MadStreamer Tape Files lookup failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return { recordId: String(rec.recordId), fieldData: rec.fieldData }
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

function buildPlaylistArtFieldData({ playlistName, imageUrl }) {
  const fd = {}
  if (playlistName)     fd['Playlist_Name'] = playlistName
  if (imageUrl != null) fd['Image_S3_URL']  = imageUrl
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

export async function upsertPlaylistArt({ playlistName, imageUrl }) {
  if (!playlistName) throw new Error('Playlist name is required to save playlist art')

  const existing = await findPlaylistArt(playlistName)
  const rawFieldData = buildPlaylistArtFieldData({ playlistName, imageUrl })

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
