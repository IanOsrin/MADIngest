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
  MADSTREAMER_FM_GMVI_FIELD      = 'GMVi',
  // Match AlbumArtworkTool's default — that's the proven field name on the
  // Artwork layout. Override via env if your MadStreamer install differs.
  MADSTREAMER_FM_CATALOGUE_FIELD = 'album catalogue number',
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
        query: [{ [MADSTREAMER_FM_CATALOGUE_FIELD]: `==${catalogueNumber}` }],
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
  if (metadata.duration)        fd['Duration']                     = String(metadata.duration)

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
