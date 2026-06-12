/**
 * lib/fm-cms2024.js
 * FileMaker Data API client for the Gallo CMS 2024 database.
 *
 * Third sibling alongside Gallo Catalogue (lib/fm-gallo.js) and MadStreamer
 * (lib/madstreamer.js). All three live at digitalcupboard.* and share the
 * same login, so credentials fall back to GALLO_FM_USER / GALLO_FM_PASS unless
 * CMS2024_FM_USER / CMS2024_FM_PASS are set explicitly.
 *
 * Env:
 *   CMS2024_FM_HOST    https://digitalcupboard.app   (falls back to GALLO_FM_HOST)
 *   CMS2024_FM_DB      Gallo CMS 2024
 *   CMS2024_FM_USER    (falls back to GALLO_FM_USER)
 *   CMS2024_FM_PASS    (falls back to GALLO_FM_PASS)
 *   CMS2024_FM_LAYOUT  Song Files
 *
 * Designed to support full cross-DB integration — read, write, search, run
 * scripts, and introspect layouts. The routes layer composes these primitives
 * to push records between Gallo Catalogue ↔ CMS 2024.
 */

const {
  GALLO_FM_HOST,
  GALLO_FM_USER,
  GALLO_FM_PASS,

  CMS2024_FM_HOST,
  CMS2024_FM_DB     = 'Gallo CMS 2024',
  CMS2024_FM_USER,
  CMS2024_FM_PASS,
  CMS2024_FM_LAYOUT = 'Song Files',
} = process.env

// Normalise host: keep protocol if present, otherwise default to https://
function _normaliseHost(raw) {
  if (!raw) return ''
  const trimmed = raw.trim().replace(/\/$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

const HOST   = _normaliseHost(CMS2024_FM_HOST || GALLO_FM_HOST)
const DB     = CMS2024_FM_DB
const USER   = CMS2024_FM_USER || GALLO_FM_USER
const PASS   = CMS2024_FM_PASS || GALLO_FM_PASS
const LAYOUT = CMS2024_FM_LAYOUT

const base = HOST && DB
  ? `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
  : null

const FM_TIMEOUT_MS = 60_000  // 60s — matches the Gallo client; FM can be slow

let _token       = null
let _tokenExpiry = 0

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  if (!base) throw new Error('CMS 2024 FM not configured (need CMS2024_FM_HOST/_DB)')
  if (!USER || !PASS) {
    throw new Error('CMS 2024 FM credentials not set (CMS2024_FM_USER/_PASS or GALLO_FM_USER/_PASS)')
  }

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
    throw new Error(`CMS 2024 FM login failed: ${msg}`)
  }
  _token = json?.response?.token
  if (!_token) throw new Error('CMS 2024 FM login returned no token')
  _tokenExpiry = Date.now() + 14 * 60 * 1000
  return _token
}

function withTimeout(ms) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

/**
 * Internal: authenticated fetch against the CMS 2024 Data API.
 * Auto-retries once on 401 by re-logging-in.
 */
async function cmsFetch(path, options = {}) {
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
          headers: {
            Accept:        'application/json',
            Authorization: `Bearer ${fresh}`,
            ...(options.headers || {})
          }
        })
      } finally { c2() }
    }
    return res
  } finally {
    clear()
  }
}

// ── Layout introspection (cached) ────────────────────────────────────────
// FileMaker rejects a create / update payload if even ONE field name doesn't
// exist on the layout, so we look up the live field set and filter buildField
// output against it. Cache lives for the process lifetime; bust with reloadLayoutFields.

const _layoutFieldCache = new Map()  // layoutName → Set<string>

export async function getLayoutFields(layoutName = LAYOUT) {
  if (_layoutFieldCache.has(layoutName)) return _layoutFieldCache.get(layoutName)

  const res  = await cmsFetch(`/layouts/${encodeURIComponent(layoutName)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 layout metadata fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const fields = new Set()
  const meta   = json?.response?.fieldMetaData || json?.response?.FieldMetaData || []
  for (const m of meta) if (m?.name) fields.add(String(m.name))

  // Portal / related fields look like "Table::Field" — capture those too
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
  const kept    = {}
  const dropped = []
  for (const [k, v] of Object.entries(fieldData)) {
    if (knownFieldSet.has(k)) kept[k] = v
    else dropped.push(k)
  }
  return { kept, dropped }
}

/**
 * Detailed field metadata (name, type, autoEnter, notEmpty, …) — mirrors
 * getGalloLayoutFields. Useful for the admin `/cms2024/layout-fields`
 * diagnostic endpoint.
 */
export async function getLayoutFieldMeta(layoutName = LAYOUT) {
  if (!base) throw new Error('CMS 2024 FM not configured')
  if (!layoutName) throw new Error('layout name required')

  const res  = await cmsFetch(`/layouts/${encodeURIComponent(layoutName)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`CMS 2024 layout metadata fetch failed: ${msg}`)
  }
  const meta = json?.response?.fieldMetaData || []
  return meta.map(m => ({
    name:        m.name,
    type:        m.result,
    auto_enter:  !!m.autoEnter,
    not_empty:   !!m.notEmpty,
    global:      !!m.global,
    repetitions: m.maxRepeat || 1,
  }))
}

// ── Records: read / find / write ─────────────────────────────────────────

/**
 * Find records on a CMS 2024 layout matching an FM-style query.
 *
 * @param {object|object[]} query — FM Data API query. Pass an object for AND-find,
 *                                  an array of objects for OR-find.
 * @param {object} [opts]
 * @param {string} [opts.layout=LAYOUT]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]            0-based
 * @param {object[]} [opts.sort]              FM sort spec (e.g. [{ fieldName, sortOrder }])
 * @returns {{ records: object[], foundCount: number, layout: string }}
 */
export async function findRecords(query, opts = {}) {
  const {
    layout = LAYOUT,
    limit  = 50,
    offset = 0,
    sort,
  } = opts
  if (!base) throw new Error('CMS 2024 FM not configured')
  if (!layout) throw new Error('CMS 2024 layout not set')
  if (!query)  throw new Error('findRecords: query required')

  const body = {
    query: Array.isArray(query) ? query : [query],
    limit,
    // FM Data API uses 1-based offset; omit on first page so FM defaults to 1
    ...(offset > 0 ? { offset: offset + 1 } : {}),
    ...(sort ? { sort } : {}),
  }

  const res  = await cmsFetch(
    `/layouts/${encodeURIComponent(layout)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // FM code 401 from _find means "no records match" — return empty rather than throwing
    if (json?.messages?.[0]?.code === '401') {
      return { records: [], foundCount: 0, layout }
    }
    throw new Error(`CMS 2024 find failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }

  const records    = (json?.response?.data || []).map(r => ({
    recordId:  String(r.recordId || ''),
    modId:     String(r.modId || ''),
    fieldData: r.fieldData || {},
    portalData: r.portalData || {},
  }))
  const foundCount = Number(json?.response?.dataInfo?.foundCount ?? records.length)
  return { records, foundCount, layout }
}

/** Convenience: first matching record only, or null. */
export async function findRecord(query, opts = {}) {
  const { records } = await findRecords(query, { ...opts, limit: 1 })
  return records[0] || null
}

/**
 * Fetch a single record by its internal FM recordId.
 * Returns null if not found (FM 101).
 */
export async function getRecord(recordId, layout = LAYOUT) {
  if (!base)     throw new Error('CMS 2024 FM not configured')
  if (!recordId) throw new Error('getRecord: recordId required')

  const res = await cmsFetch(`/layouts/${encodeURIComponent(layout)}/records/${recordId}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '101') return null  // Record is missing
    throw new Error(`CMS 2024 getRecord failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  return {
    recordId:   String(rec.recordId || ''),
    modId:      String(rec.modId || ''),
    fieldData:  rec.fieldData || {},
    portalData: rec.portalData || {},
  }
}

/**
 * Page through every record on a layout. Use sparingly — CMS 2024 may be huge.
 * @param {object} [opts]
 * @param {string} [opts.layout=LAYOUT]
 * @param {number} [opts.batchSize=100]   FM max is 100 without server override
 * @param {number} [opts.maxRecords]      stop early after this many (safety guard)
 */
export async function getAllRecords(opts = {}) {
  const { layout = LAYOUT, batchSize = 100, maxRecords = Infinity } = opts
  if (!base)   throw new Error('CMS 2024 FM not configured')
  if (!layout) throw new Error('CMS 2024 layout not set')

  const all = []
  let offset = 0

  while (all.length < maxRecords) {
    const url  = `/layouts/${encodeURIComponent(layout)}/records?_limit=${batchSize}&_offset=${offset + 1}`
    const res  = await cmsFetch(url)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
      throw new Error(`CMS 2024 getAllRecords failed: ${msg}`)
    }
    const batch = json?.response?.data || []
    if (!batch.length) break
    for (const r of batch) {
      all.push({ recordId: String(r.recordId), modId: String(r.modId || ''), fieldData: r.fieldData || {} })
      if (all.length >= maxRecords) break
    }
    if (batch.length < batchSize) break  // last page
    offset += batch.length
  }
  return all
}

/**
 * Create a record on a CMS 2024 layout. Field names are filtered against the
 * live layout metadata so unknown fields are dropped (FM otherwise rejects the
 * whole request when any field is unknown).
 *
 * @param {object} fieldData
 * @param {object} [opts]
 * @param {string} [opts.layout=LAYOUT]
 * @returns {{ recordId: string, dropped: string[] }}
 */
export async function createRecord(fieldData, opts = {}) {
  const { layout = LAYOUT } = opts
  if (!base)   throw new Error('CMS 2024 FM not configured')
  if (!layout) throw new Error('CMS 2024 layout not set')

  const known = await getLayoutFields(layout)
  const { kept, dropped } = filterToKnownFields(fieldData, known)
  if (Object.keys(kept).length === 0) {
    throw new Error(
      `No matching fields on CMS 2024 ${layout} — none of [${Object.keys(fieldData).join(', ')}] exist on the layout. ` +
      `Check field names or layout config (call /cms2024/layout-fields to see what's there).`
    )
  }

  const res  = await cmsFetch(
    `/layouts/${encodeURIComponent(layout)}/records`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: kept }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 createRecord failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const recordId = String(json?.response?.recordId || '')
  if (!recordId) throw new Error('CMS 2024 createRecord returned no recordId')
  return { recordId, dropped }
}

/**
 * Update fields on an existing CMS 2024 record (PATCH). Unknown fields are
 * filtered out before sending — mirrors createRecord behaviour.
 */
export async function updateRecord(recordId, fieldData, opts = {}) {
  const { layout = LAYOUT } = opts
  if (!base)     throw new Error('CMS 2024 FM not configured')
  if (!recordId) throw new Error('updateRecord: recordId required')

  const known = await getLayoutFields(layout)
  const { kept, dropped } = filterToKnownFields(fieldData, known)
  if (Object.keys(kept).length === 0) {
    throw new Error(
      `No matching fields on CMS 2024 ${layout} — none of [${Object.keys(fieldData).join(', ')}] exist on the layout.`
    )
  }

  const res = await cmsFetch(
    `/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: kept }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 updateRecord failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return { recordId, dropped }
}

/**
 * Delete a single record by its internal FM recordId.
 */
export async function deleteRecord(recordId, opts = {}) {
  const { layout = LAYOUT } = opts
  if (!recordId) throw new Error('deleteRecord: recordId required')

  const res  = await cmsFetch(
    `/layouts/${encodeURIComponent(layout)}/records/${recordId}`,
    { method: 'DELETE' }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 deleteRecord failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return true
}

/**
 * Upsert: find an existing record by a uniqueness key (e.g. ISRC, Filename,
 * or a composite of fields) and PATCH it; otherwise create. Mirrors the
 * MadStreamer upsertMp3Record pattern.
 *
 * @param {object} fieldData                       — payload to write
 * @param {object|object[]} uniquenessQuery        — FM query that identifies the record
 * @param {object} [opts]
 * @param {string} [opts.layout=LAYOUT]
 * @returns {{ recordId: string, action: 'created'|'updated', dropped: string[] }}
 */
export async function upsertRecord(fieldData, uniquenessQuery, opts = {}) {
  const { layout = LAYOUT } = opts
  const existing = await findRecord(uniquenessQuery, { layout })
  if (existing) {
    const { dropped } = await updateRecord(existing.recordId, fieldData, { layout })
    return { recordId: existing.recordId, action: 'updated', dropped }
  } else {
    const { recordId, dropped } = await createRecord(fieldData, { layout })
    return { recordId, action: 'created', dropped }
  }
}

// ── Scripts ──────────────────────────────────────────────────────────────

/**
 * Trigger a FileMaker script attached to a specific record. The script runs
 * server-side; scriptParam is available as Get(ScriptParameter).
 */
export async function runScriptOnRecord(recordId, scriptName, scriptParam, opts = {}) {
  const { layout = LAYOUT } = opts
  let url = `/layouts/${encodeURIComponent(layout)}/records/${recordId}?script=${encodeURIComponent(scriptName)}`
  if (scriptParam) url += `&script.param=${encodeURIComponent(scriptParam)}`
  const res  = await cmsFetch(url)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 script "${scriptName}" failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const scriptError = json?.response?.scriptError
  if (scriptError && scriptError !== '0') {
    throw new Error(`CMS 2024 script "${scriptName}" FM error code: ${scriptError}`)
  }
  return {
    scriptResult: json?.response?.scriptResult ?? null,
    scriptError:  scriptError || '0',
  }
}

/**
 * Trigger a FileMaker script via _find (script runs on the found set).
 * Mirrors runGalloScript in fm-gallo.js.
 */
export async function runScript(scriptName, findField, findValue, opts = {}) {
  const { layout = LAYOUT } = opts
  const res = await cmsFetch(
    `/layouts/${encodeURIComponent(layout)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query:  [{ [findField]: `==${findValue}` }],
        script: scriptName,
      }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`CMS 2024 script "${scriptName}" failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const scriptError = json?.response?.scriptError
  if (scriptError && scriptError !== '0') {
    throw new Error(`CMS 2024 script "${scriptName}" FM error code: ${scriptError}`)
  }
  return {
    scriptResult: json?.response?.scriptResult ?? null,
    scriptError:  scriptError || '0',
  }
}

// ── Value lists ──────────────────────────────────────────────────────────

/**
 * Fetch a named FileMaker value list off a layout. Returns [] when absent.
 */
export async function getValueList(listName, layout = LAYOUT) {
  if (!base || !layout) return []
  const res  = await cmsFetch(`/layouts/${encodeURIComponent(layout)}/metadata`)
  if (!res.ok) throw new Error(`CMS 2024 metadata fetch failed: HTTP ${res.status}`)
  const json = await res.json().catch(() => ({}))
  const list = (json.response?.valueLists || []).find(vl => vl.name === listName)
  return (list?.values || []).map(v => v.displayValue).filter(Boolean)
}

// ── Health / config ──────────────────────────────────────────────────────

export async function pingCms2024() {
  try { await getToken(); return true }
  catch (_) { return false }
}

/**
 * Surface configuration for diagnostics (no secrets — passwords are masked).
 * Hooked into the /api/ingest/cms2024/ping endpoint.
 */
export const _config = Object.freeze({
  HOST,
  DB,
  LAYOUT,
  USER_PRESENT:   !!USER,
  PASS_PRESENT:   !!PASS,
  CREDS_INHERITED_FROM_GALLO: (!CMS2024_FM_USER || !CMS2024_FM_PASS),
})

// ── Cross-DB search / mapping helpers ────────────────────────────────────
// These let the rest of the app treat CMS 2024 records in a consistent shape
// regardless of the layout's exact field naming. The same defensive picker
// pattern used by fm-gallo.js, so we tolerate field renames without crashing.

function _pick(fieldData, candidates) {
  for (const name of candidates) {
    const v = fieldData[name]
    if (v != null && String(v).trim() !== '') return v
  }
  return null
}

/**
 * Normalise a CMS 2024 record into the same flat track shape the rest of the
 * codebase uses (matches fm-gallo.js mapGalloRecord). When the CMS 2024 layout
 * uses different field names, add aliases to the `_pick` candidate lists below
 * — that's the only place that needs to know the schema details.
 */
export function mapCms2024Record(record) {
  const f = record.fieldData || {}

  const durationRaw = _pick(f, ['Duration'])
  const durationSec = _parseDurationSec(durationRaw)
  // Normalised duration string — derived from the corrected seconds value so
  // downstream code (e.g. DDEX <Duration> elements) doesn't carry FM's
  // h:mm:ss misinterpretation forward.
  const duration    = durationSec != null ? _secondsToIso(durationSec) : durationRaw
  const audioUrl   = _pick(f, ['File URL', 'S3_URL', 'Audio URL', 'S3 URL'])
  const filename   = _pick(f, ['Filename', 'File Name', 'Audio Filename', 'Filename.wav'])
  const sequenceNo = (() => {
    const v = _pick(f, ['Track Number', 'Sequence Number'])
    const n = parseInt(String(v ?? '').trim(), 10)
    return isNaN(n) ? null : n
  })()

  // Composer / Producer can be split across multiple slots on Song Files
  // (Composer + Composer 2 + Composer 3; Producer + Producer 2 + Producer 3).
  // Concatenate them into a single deduped list — splitNames handles the rest.
  const composerNames = [
    _pick(f, ['Composer', 'Composer 1']),
    _pick(f, ['Composer 2', 'Composer2']),
    _pick(f, ['Composer 3', 'Composer3']),
    _pick(f, ['Composer 4', 'Composer4']),
    _pick(f, ['Composers']),
  ].filter(Boolean).join(';')
  const producerNames = [
    _pick(f, ['Producer', 'Producer 1']),
    _pick(f, ['Producer 2', 'Producer2']),
    _pick(f, ['Producer 3', 'Producer3']),
    _pick(f, ['Producer 4', 'Producer4']),
    _pick(f, ['Producers']),
  ].filter(Boolean).join(';')

  return {
    fm_record_id:   String(record.recordId || ''),
    title:          _pick(f, ['Song Title', 'Track Name', 'Track Title', 'Title']),
    artist_name:    _pick(f, ['Track Artist', 'Artist']),
    album_artist:   _pick(f, ['Album Artist']),
    featured_artist:_pick(f, ['Featured Artist', 'Main Artist 2']),
    album_title:    _pick(f, ['Album Title', 'Album']),
    album_description: _pick(f, ['Album Description']),
    catalogue_no:   _pick(f, ['Album Catalogue Number', 'Album Cat: Number', 'Reference Catalogue Number', 'Catalogue Number']),
    isrc:           _pick(f, ['ISRC']),
    iswc:           _pick(f, ['ISWC']),
    barcode:        _pick(f, ['UPC', 'Barcode', 'ICPN']),
    sequence_no:    sequenceNo,
    track_number:   sequenceNo, // alias for FM 'Track Number' field
    // Filename aliases — DDEX pipeline reads wav_filename / asset_number
    filename:       filename,
    wav_filename:   filename,
    asset_number:   filename ? String(filename).replace(/\.[^.]+$/, '') : null,
    year:           _pick(f, ['Year of Release', 'Year']),
    release_date:   _pick(f, ['Release Date']),
    original_release_date: _pick(f, ['Original Release date', 'Original Release Date']),
    genre:          _pick(f, ['Genre']),
    local_genre:    _pick(f, ['Local Genre']),
    sub_genre:      _pick(f, ['Sub Genre', 'SubGenre']),
    // Prefer Language Code (ISO 639) over Language (display name) — the DDEX
    // builder needs a code, not a name. Ingrooves rejects "Tsonga"; wants "tso".
    language:       _pick(f, ['Language Code', 'Language']),
    country:        _pick(f, ['Country']),
    rights_territories: _pick(f, ['Rights Territories']),
    duration:       duration,
    duration_sec:   durationSec,
    explicit:       _pick(f, ['Explicit']) === 'Yes' || _pick(f, ['Parental']) === 'Explicit',
    parental:       _pick(f, ['Parental']),
    // composers/producers MUST be arrays — Gallo's mapper returns them that
    // way and the DDEX builder calls .map() on them. Split semicolon / comma
    // separated strings; keep strings/arrays as-is otherwise.
    composers:      _splitNames(composerNames),
    producers:      _splitNames(producerNames),
    publishers:     _pick(f, ['Publishers', 'Publisher']),
    label:          _pick(f, ['Label']),
    p_line:         _pick(f, ['pLine', 'PLine']),
    c_line:         _pick(f, ['cLine', 'CLine']),
    // Audio URL aliases — Gallo's downstream code reads s3_url
    audio_url:      audioUrl,
    s3_url:         audioUrl,
    // FileMaker container references. Gallo uses "Audio File" / "artwork::picture";
    // Song Files may use different names — env overrides take precedence, otherwise
    // we try a generous list of common names.
    audio_container_url:   _pick(f, [
      process.env.CMS2024_AUDIO_CONTAINER_FIELD,
      'Audio File', 'Audio', 'WAV', 'Sound', 'Audio Container', 'Sound File',
    ].filter(Boolean)),
    artwork_container_url: _pick(f, [
      process.env.CMS2024_ARTWORK_CONTAINER_FIELD,
      'Artwork', 'Picture', 'Image',
      'artwork::picture', 'Artwork::picture', 'Artwork::Picture', 'artwork::Picture',
      'artwork::image',   'Artwork::image',   'Artwork::Image',
      'Album Artwork',
    ].filter(Boolean)),
    // CMS 2024's Song Files layout stores the artwork S3 URL as Artwork_S3_URL
    // (with underscores). Older layouts may use 'Artwork URL' / 'Image URL'.
    artwork_url:    _pick(f, ['Artwork_S3_URL', 'Artwork URL', 'Artwork Url', 'Image URL', 'Artwork_URL']),
    technical_resource: _pick(f, ['Technical Resource']),
    sound_recording_id: _pick(f, ['SoundRecordingId']),
    resource_reference: _pick(f, ['Resource Reference']),
    audio_hash_md5: _pick(f, ['AudioHashSum', 'Audio Hash', 'MD5', 'Audio MD5']),
    raw:            f,
  }
}

/**
 * Normalise composer/producer-style values into a deduped array of trimmed
 * names. Accepts strings (semicolon / comma / pipe separated), arrays, or
 * null. Matches the shape Gallo's mapper produces so downstream .map() calls
 * (DDEX builder, ingest pipeline) don't care which DB the track came from.
 */
function _splitNames(val) {
  if (val == null) return []
  if (Array.isArray(val)) {
    return [...new Set(val.map(s => String(s).trim()).filter(Boolean))]
  }
  const s = String(val).trim()
  if (!s) return []
  const parts = s.split(/[;,|]/).map(p => p.trim()).filter(Boolean)
  return [...new Set(parts)]
}

/**
 * True when a value looks like a real FileMaker container reference (the kind
 * that fetchContainerData can resolve), false for empty / placeholder values
 * like "Untitled" that FM returns for empty container slots on multi-image
 * layouts. We require a URL-ish prefix because anything we'd actually fetch
 * starts with http(s) / movie / image / file.
 */
function _looksLikeContainerRef(v) {
  if (v == null) return false
  const s = String(v).trim()
  if (!s)                                return false
  if (s.toLowerCase() === 'untitled')    return false
  return /^(https?:|movie:|image:|file:|sound:)/i.test(s)
}

/**
 * Format a duration in seconds as an ISO 8601 duration string (e.g. "PT4M10S").
 * Used to write back a normalised duration after the h:mm:ss heuristic so
 * downstream DDEX builders that read the raw `duration` field still get a
 * consistent value.
 */
function _secondsToIso(totalSec) {
  if (totalSec == null || isNaN(totalSec)) return null
  let s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600); s %= 3600
  const m = Math.floor(s / 60);   s %= 60
  let out = 'PT'
  if (h) out += `${h}H`
  if (m) out += `${m}M`
  if (s || (!h && !m)) out += `${s}S`
  return out
}

/**
 * Parse "00:04:30", "00:04:30.900", "270", or "PT4M30S" into seconds.
 *
 * NOTE on the CMS 2024 Duration field: it's a FileMaker *time* type. When a
 * data-entry user types "04:10" meaning 4 min 10 sec, FM interprets it as
 * 4 h 10 min and stores 15,000 sec — then the Data API returns "04:10:00".
 *
 * Without correction we'd report a 4-min song as ~250 min. We detect that
 * exact pattern (3-part time, zero seconds, plausibly-music hours value) and
 * reinterpret as MM:SS. Disable via CMS2024_DURATION_AS_HHMM=true if a real
 * h:mm:ss field is ever used here (e.g. for long-form audio).
 */
function _parseDurationSec(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (iso) return Math.round((+iso[1]||0)*3600 + (+iso[2]||0)*60 + (+iso[3]||0))
  const parts = s.split(':').map(p => parseFloat(p))
  if (!parts.every(n => !isNaN(n))) return null

  if (parts.length === 2) return Math.round(parts[0]*60 + parts[1])

  if (parts.length === 3) {
    const [h, m, sec] = parts
    const reinterpretAsMmSs = process.env.CMS2024_DURATION_AS_HHMM !== 'true'
    const hhmmssValue = h*3600 + m*60 + sec
    // Heuristic: a 3-part time with seconds=0 + hours>0 + an implausibly
    // long result (> 1 hour) is almost certainly the FM time-field bug
    // where a user typed "MM:SS" and FM interpreted it as "HH:MM:00".
    //
    // Threshold = 3600s keeps legitimate ≤ 1h tracks safe (returns 3600 for
    // an actual 1h00m00s); tracks longer than 1 hour as a SINGLE recording
    // are vanishingly rare in a music catalogue. For long-form audio
    // (audiobooks, mixes, concert recordings), set CMS2024_DURATION_AS_HHMM=true
    // to disable the heuristic entirely.
    if (reinterpretAsMmSs && sec === 0 && h > 0 && hhmmssValue > 3600) {
      return Math.round(h*60 + m)
    }
    return Math.round(hhmmssValue)
  }
  return null
}

/**
 * Find all tracks for a given catalogue number on CMS 2024. Introspects the
 * layout to pick the right catalogue field name — Song Files has historically
 * used either "Album Catalogue Number" or "Reference Catalogue Number".
 *
 * Returns an array of normalised track objects (mapCms2024Record output)
 * sorted by sequence/track number ascending.
 */
export async function findRecordsByCatalogue(catalogueNo, opts = {}) {
  const { layout = LAYOUT } = opts
  if (!catalogueNo) return []

  const known = await getLayoutFields(layout)
  const catalogueFields = [
    'Album Catalogue Number',
    'Reference Catalogue Number',
    'Catalogue Number',
  ].filter(f => known.has(f))

  if (!catalogueFields.length) {
    throw new Error(
      `CMS 2024 layout ${layout} has no recognised catalogue-number field ` +
      `(tried Album Catalogue Number / Reference Catalogue Number / Catalogue Number).`
    )
  }

  // OR-find: ANY of the catalogue field names matching catalogueNo
  const query = catalogueFields.map(f => ({ [f]: `==${catalogueNo}` }))
  const { records } = await findRecords(query, { layout, limit: 500 })
  const tracks = records.map(mapCms2024Record)

  return tracks.sort((a, b) =>
    (a.sequence_no ?? 999) - (b.sequence_no ?? 999)
  )
}

/**
 * Look up the artwork record on CMS 2024 for a given catalogue. Artwork
 * lives in a separate layout ("Artwork" by default) — keyed by catalogue
 * number — not on the Song Files tracks themselves. Returns the container
 * reference + any S3 URL + the GMVi resource reference, or null when no
 * matching artwork exists.
 *
 * Override the layout via env `CMS2024_ARTWORK_LAYOUT` (default `Artwork`)
 * and the container field via `CMS2024_ARTWORK_CONTAINER_FIELD` if your
 * schema's names diverge from the common ones.
 */
export async function findArtworkByCatalogue(catalogueNo, opts = {}) {
  if (!catalogueNo) return null
  const layout = opts.layout || process.env.CMS2024_ARTWORK_LAYOUT || 'Artwork'

  // Introspect the layout once: this tells us both the catalogue field name
  // AND which fields are containers (so we don't have to guess "Artwork" /
  // "Picture" / "Image" / whatever the FM dev called them). Same approach the
  // Gallo path takes — read fieldMetaData.result to find type === 'container'.
  let catFields = ['Catalogue Number']
  let containerFieldNames = []
  try {
    const meta = await getLayoutFieldMeta(layout)
    const knownNames = new Set(meta.map(m => m.name))
    catFields = ['Catalogue Number', 'Album Catalogue Number', 'Reference Catalogue Number']
      .filter(f => knownNames.has(f))
    if (!catFields.length) {
      throw new Error(`Artwork layout "${layout}" has no recognised catalogue field`)
    }
    // Container field selection on the Artwork layout. Per Ian: ALWAYS use
    // "Picture" — never "Picture 2" (which is a transient resize-staging
    // slot). Env override stays available for layouts where the canonical
    // container is named differently. We explicitly filter out "Picture 2"
    // / "Picture2" variants so they can never be selected by accident.
    const discovered = meta.filter(m => m.type === 'container').map(m => m.name)
    const isTransient = (n) => /^picture\s*2$/i.test(n)
    containerFieldNames = [
      process.env.CMS2024_ARTWORK_CONTAINER_FIELD,
      'Picture',
      ...discovered,
    ].filter(Boolean).filter(n => !isTransient(n))
    // Dedupe while preserving order
    containerFieldNames = [...new Set(containerFieldNames)]
  } catch (e) {
    // Introspection failed — proceed with sensible defaults; the find below
    // either succeeds or returns null, which the caller handles.
    catFields = ['Catalogue Number']
    containerFieldNames = [
      process.env.CMS2024_ARTWORK_CONTAINER_FIELD,
      'Artwork', 'Picture', 'Image', 'Cover', 'Cover Art', 'Album Artwork',
    ].filter(Boolean)
  }

  const query = catFields.map(f => ({ [f]: `==${catalogueNo}` }))
  const { records } = await findRecords(query, { layout, limit: 1 })
  if (!records.length) return null

  const rec = records[0]
  const f   = rec.fieldData || {}

  // Pick the first container field whose value LOOKS like a real container
  // reference. FM sometimes returns a placeholder filename like "Untitled"
  // for an empty container on a multi-thumbnail layout — those would crash
  // the downstream URL fetch, so skip them and fall through to the next slot.
  let container = null
  let container_field = null
  for (const name of containerFieldNames) {
    const val = f[name]
    if (_looksLikeContainerRef(val)) { container = val; container_field = name; break }
  }

  return {
    recordId:           rec.recordId,
    container,
    container_field,
    s3_url:             _pick(f, [
      'Artwork_S3_URL', 'Artwork S3 URL', 'Artwork URL', 'S3_URL', 'S3 URL', 'Image URL',
    ]),
    resource_reference: _pick(f, [
      'Resource reference', 'Resource Reference', 'ResourceReference',
      'GMVi', 'GMVI', 'Image Asset Number',
    ]),
    catalogue_no:       _pick(f, ['Catalogue Number', 'Album Catalogue Number', 'Reference Catalogue Number']),
    raw: f,
  }
}

/**
 * Free-text search across the common track-identity fields. Mirrors
 * searchGalloRecords so the admin UI can present a uniform search box.
 * Uses OR-find across Track Name / Artist / Album / ISRC / Catalogue.
 *
 * @param {string} term
 * @param {object} [opts]
 * @param {string} [opts.layout=LAYOUT]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 */
export async function searchRecords(term, opts = {}) {
  const { layout = LAYOUT, limit = 50, offset = 0 } = opts
  if (!term || term.trim().length < 2) return { tracks: [], foundCount: 0 }
  const t = term.trim()

  // Introspect the layout once so we only OR-find across fields that actually
  // exist. FM rejects the entire query if a single field name is unknown.
  const known = await getLayoutFields(layout)
  const candidates = [
    'Track Name', 'Song Title',
    'Track Artist', 'Album Artist',
    'Album Title',
    'ISRC',
    'Album Catalogue Number', 'Reference Catalogue Number',
    'Filename',
  ]
  const queries = candidates
    .filter(f => known.has(f))
    .map(f => ({ [f]: `*${t}*` }))
  if (!queries.length) return { tracks: [], foundCount: 0 }

  const { records, foundCount } = await findRecords(queries, { layout, limit, offset })
  return { tracks: records.map(mapCms2024Record), foundCount }
}
