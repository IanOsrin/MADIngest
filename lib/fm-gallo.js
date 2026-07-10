/**
 * lib/fm-gallo.js
 * FileMaker Data API client for the Gallo Catalogue database.
 * Uses env: GALLO_FM_HOST, GALLO_FM_DB, GALLO_FM_USER, GALLO_FM_PASS, GALLO_FM_LAYOUT
 */

import { languageNameToCode } from './language-codes.js'

const {
  GALLO_FM_HOST,
  GALLO_FM_DB,
  GALLO_FM_USER,
  GALLO_FM_PASS,
  GALLO_FM_LAYOUT
} = process.env

const base = GALLO_FM_HOST && GALLO_FM_DB
  ? `${GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(GALLO_FM_DB)}`
  : null

let _token        = null
let _tokenExpiry  = 0
let _tokenPromise = null   // in-flight login — shared by concurrent callers

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  // If a login is already in progress, wait for it rather than creating a
  // second FM session (concurrent callers would otherwise each POST /sessions,
  // causing race conditions when many barcodes are fetched in parallel).
  if (_tokenPromise) return _tokenPromise

  if (!base) throw new Error('GALLO_FM_* env vars not configured')

  _tokenPromise = (async () => {
    try {
      const res = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: {
          Authorization:  'Basic ' + Buffer.from(`${GALLO_FM_USER}:${GALLO_FM_PASS}`).toString('base64'),
          'Content-Type': 'application/json',
          Accept:         'application/json'
        },
        body: JSON.stringify({})
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
        throw new Error(`Gallo FM login failed: ${msg}`)
      }
      _token = json?.response?.token
      if (!_token) throw new Error('Gallo FM login returned no token')
      _tokenExpiry = Date.now() + 14 * 60 * 1000
      return _token
    } finally {
      _tokenPromise = null
    }
  })()

  return _tokenPromise
}

const FM_TIMEOUT_MS = 60_000 // 60 s — FM can be slow under load

function withTimeout(ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) }
}

async function galloFetch(path, options = {}) {
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

// ── Layout introspection cache ─────────────────────────────────────────────
// FileMaker rejects a create/update payload when ANY field name in it doesn't
// exist on the target layout. Caching the layout's actual field set lets us
// pre-filter payloads so one stray name doesn't sink the whole write.
const _galloLayoutFieldCache = new Map() // layoutName → Set<string>
const _galloDropLogged       = new Set() // layoutName → already logged drop list?

// In-memory ring buffer of recent create attempts so the admin UI can fetch
// them on demand (terminal output scrolls too fast to read). Exposed via
// getRecentGalloCreates() — wired to a route by routes/ingest.js.
const _galloCreateLog = []
const GALLO_CREATE_LOG_MAX = 200
function _recordCreateEvent(event) {
  _galloCreateLog.push({ ...event, at: new Date().toISOString() })
  if (_galloCreateLog.length > GALLO_CREATE_LOG_MAX) {
    _galloCreateLog.splice(0, _galloCreateLog.length - GALLO_CREATE_LOG_MAX)
  }
}
export function getRecentGalloCreates(limit = 50) {
  return _galloCreateLog.slice(-limit)
}
export function clearRecentGalloCreates() {
  _galloCreateLog.length = 0
}

export async function getGalloLayoutFieldSet(layout = GALLO_FM_LAYOUT) {
  if (_galloLayoutFieldCache.has(layout)) return _galloLayoutFieldCache.get(layout)
  const res  = await galloFetch(`/layouts/${encodeURIComponent(layout)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Gallo FM layout metadata failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const set  = new Set()
  const meta = json?.response?.fieldMetaData || json?.response?.FieldMetaData || []
  for (const m of meta) if (m?.name) set.add(String(m.name))
  const portals = json?.response?.portalMetaData || {}
  for (const p of Object.values(portals)) {
    for (const m of p || []) if (m?.name) set.add(String(m.name))
  }
  _galloLayoutFieldCache.set(layout, set)
  return set
}

export function reloadGalloLayoutFields(layout) {
  if (layout) _galloLayoutFieldCache.delete(layout)
  else _galloLayoutFieldCache.clear()
}

/** Filter a fieldData payload to only fields present on the layout. */
function _filterToKnownGalloFields(fieldData, knownSet) {
  const kept = {}, dropped = []
  for (const [k, v] of Object.entries(fieldData)) {
    if (knownSet.has(k)) kept[k] = v
    else dropped.push(k)
  }
  return { kept, dropped }
}

/**
 * List the field names on a Gallo FM layout (defaults to GALLO_FM_LAYOUT,
 * which in this project resolves to API_Album_Songs). Useful for diagnosing
 * "field doesn't exist on layout" write errors from the Data API.
 */
export async function getGalloLayoutFields(layout = GALLO_FM_LAYOUT) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  if (!layout) throw new Error('layout name required')

  const res  = await galloFetch(`/layouts/${encodeURIComponent(layout)}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Gallo FM layout metadata failed: ${msg}`)
  }
  // FM Data API returns { response: { fieldMetaData: [{ name, type, ... }] } }
  const meta = json?.response?.fieldMetaData || []
  return meta.map(m => ({
    name:           m.name,
    type:           m.result,         // text, number, date, container, ...
    auto_enter:     !!m.autoEnter,
    not_empty:      !!m.notEmpty,
    global:         !!m.global,
    repetitions:    m.maxRepeat || 1,
  }))
}

// ── CCA business rules ────────────────────────────────────────────────────────
// Catalogue numbers starting "CCA_" belong to Content Connect Africa.
//  • Label is forced to the constant "Content Connect Africa" (the spreadsheet
//    label, e.g. "Bird Box Entertainment", appears only in the ℗/© lines).
//  • Empty ℗/© lines default to:
//      "℗ <current year> <spreadsheet label> under exclusive license to CCA"
//      "© <current year> <spreadsheet label> under exclusive license to CCA"
// Mirrors applyCcaRules in routes/ingest.js (used by the Enrich path).
function _applyCcaRules(fieldData, metadata) {
  if (!/^CCA_/i.test(String(metadata.catalogue_no || '').trim())) return
  fieldData['Label'] = 'Content Connect Africa'
  if (metadata.label) {
    const tail = `${new Date().getFullYear()} ${metadata.label} under exclusive license to CCA`
    if (!metadata.p_line) fieldData['pLine'] = `℗ ${tail}`
    if (!metadata.c_line) fieldData['cLine'] = `© ${tail}`
  }
}

/**
 * Create a record in the Gallo Catalogue.
 * Field names match the API_Album_Songs layout exactly.
 * @param {object} metadata — track metadata
 * @returns {{ fmRecordId: string }}
 */
export async function createGalloRecord(metadata) {
  if (!base)            throw new Error('GALLO_FM_* env vars not configured')
  if (!GALLO_FM_LAYOUT) throw new Error('GALLO_FM_LAYOUT not set')

  const fieldData = {}

  // Core track identity
  if (metadata.title)         fieldData['Track Name']              = metadata.title
  if (metadata.artist)        fieldData['Track Artist']             = metadata.artist
  if (metadata.album_artist)  fieldData['Album Artist']             = metadata.album_artist
  if (metadata.featured_artist) fieldData['Featured Artist']         = metadata.featured_artist
  if (metadata.album)         fieldData['Album Title']               = metadata.album
  if (metadata.album_description) fieldData['Album Description']      = metadata.album_description
  // Catalogue: send to BOTH 'Album Catalogue Number' and 'Reference Catalogue
  // Number'. Introspection drops whichever isn't on the layout (typically
  // Reference Catalogue Number on Songs is a calc/lookup — gets dropped — but
  // the write still goes through cleanly on Tape Files Master).
  if (metadata.catalogue_no) { fieldData['Album Catalogue Number']     = metadata.catalogue_no
                               fieldData['Reference Catalogue Number'] = metadata.catalogue_no }
  if (metadata.isrc)          fieldData['ISRC']                      = metadata.isrc
  if (metadata.iswc)          fieldData['ISWC']                      = metadata.iswc
  if (metadata.barcode)       fieldData['Barcode']                   = String(metadata.barcode)
  if (metadata.barcode)       fieldData['UPC']                       = String(metadata.barcode)
  // Sequence Number is the legacy field; Track Number is the modern numeric
  // one. Send both — introspection drops whichever isn't on the layout.
  if (metadata.sequence_no)   fieldData['Sequence Number']           = String(metadata.sequence_no)
  if (metadata.sequence_no)   fieldData['Track Number']              = Number(metadata.sequence_no)

  // Release details
  if (metadata.year)              fieldData['Year of Release']       = String(metadata.year)
  if (metadata.release_date)      fieldData['Release Date']          = metadata.release_date
  if (metadata.original_release)  fieldData['Original Release date'] = metadata.original_release
  if (metadata.original_release_date) fieldData['Original Release date'] = metadata.original_release_date

  // Genre, language, descriptors
  if (metadata.genre)         fieldData['Genre']                     = metadata.genre
  if (metadata.local_genre)   fieldData['Local Genre']               = metadata.local_genre
  if (metadata.sub_genre)     fieldData['Sub Genre']                 = metadata.sub_genre
  if (metadata.language) {
    fieldData['Language'] = metadata.language
    const iso = metadata.language.length <= 3
      ? metadata.language
      : languageNameToCode(metadata.language)
    if (iso) fieldData['Language Code'] = iso
  }
  if (metadata.country)       fieldData['Country']                   = metadata.country
  if (metadata.rights_territories) fieldData['Rights Territories']    = metadata.rights_territories
  if (metadata.bpm)           fieldData['BPM']                       = String(metadata.bpm)
  if (metadata.duration)      fieldData['Duration']                  = String(metadata.duration)
  if (metadata.explicit !== undefined)
                              fieldData['Explicit']                  = metadata.explicit ? 'Yes' : 'No'
  // FM field is "Lyrical Content rating"; send legacy "Parental" too —
  // the layout filter below keeps whichever exists.
  if (metadata.parental)    { fieldData['Lyrical Content rating']    = metadata.parental
                              fieldData['Parental']                  = metadata.parental }

  // Credits — write both singular and plural; introspection picks whichever exists.
  if (metadata.composers)     { fieldData['Composers']  = metadata.composers
                                fieldData['Composer']   = metadata.composers }
  if (metadata.producers)     { fieldData['Producers']  = metadata.producers
                                fieldData['Producer']   = metadata.producers }
  if (metadata.publishers)    { fieldData['Publishers'] = metadata.publishers
                                fieldData['Publisher']  = metadata.publishers }
  if (metadata.label)         fieldData['Label']                     = metadata.label
  if (metadata.p_line)        fieldData['pLine']                     = metadata.p_line
  if (metadata.c_line)        fieldData['cLine']                     = metadata.c_line
  _applyCcaRules(fieldData, metadata)

  // Asset identifiers & technical metadata.
  // 'Filename.wav' can NOT be written through the Data API — a dot in a field
  // name makes FM reject the WHOLE create with 960 "Parameter is invalid"
  // (reads of the field are fine). The asset name goes to 'Filename' only;
  // the legacy .wav field belongs to FM-side imports.
  const assetName = metadata.asset_number || metadata.wav_filename
  if (assetName)                  fieldData['Filename']               = assetName
  if (metadata.audio_hash_md5)    fieldData['AudioHashSum']           = metadata.audio_hash_md5
  if (metadata.technical_resource) fieldData['Technical Resource']    = metadata.technical_resource
  if (metadata.resource_reference) fieldData['Resource Reference']    = metadata.resource_reference
  if (metadata.sound_recording_id) fieldData['SoundRecordingId']      = metadata.sound_recording_id

  // Audio File is no longer populated by GalloIngest. The canonical audio
  // container is set by a direct CMS 2024 → Gallo Catalogue FileMaker import,
  // so anything we write here would overwrite the correct value.
  if (metadata.artwork_url) fieldData['Artwork URL'] = metadata.artwork_url

  // Pending audio path — stored in FileMaker reference format:
  //   movie:filename.wav¶moviemac:/full/mac/path/filename.wav
  // A FileMaker script reads the moviemac: line and calls Insert Audio/Video [Reference].
  if (metadata.fm_path) {
    const fname = metadata.fm_path.split('/').pop()
    fieldData['Pending Audio Path'] = 'movie:' + fname + '\n' + 'moviemac:' + metadata.fm_path
  }

  // Submission provenance
  if (metadata.submitter_name)  fieldData['Submitted By']    = metadata.submitter_name
  if (metadata.submitter_email) fieldData['Submitter Email'] = metadata.submitter_email
  if (metadata.org)             fieldData['Organisation']    = metadata.org

  // Drop any field names that don't exist on the layout — FM rejects the
  // entire payload if even one is unknown. Many of the dropped names are
  // related-table fields (Genre, Release Date, Label, pLine, cLine, etc.)
  // that show up in record reads via joins but aren't directly writable
  // from this layout. We swallow introspection errors and proceed.
  let payload = fieldData
  let dropped = []
  try {
    const known = await getGalloLayoutFieldSet(GALLO_FM_LAYOUT)
    const filt  = _filterToKnownGalloFields(fieldData, known)
    payload     = filt.kept
    dropped     = filt.dropped
    // Only log when we actually drop something. Logged once at startup is
    // fine; we don't want one drop log per track. Throttle via the cache.
    if (dropped.length && !_galloDropLogged.has(GALLO_FM_LAYOUT)) {
      console.warn(`[Gallo create] On ${GALLO_FM_LAYOUT}, dropping unknown fields (probably related-table): ${dropped.join(', ')}`)
      _galloDropLogged.add(GALLO_FM_LAYOUT)
    }
    // Always log whether the key CCA fields made it through the filter
    const ccaCheck = ['Language','Language Code','Original Release date','Rights Territories','Parental','Lyrical Content rating']
    const ccaKept    = ccaCheck.filter(f => f in payload)
    const ccaDropped = ccaCheck.filter(f => f in fieldData && !(f in payload))
    if (ccaDropped.length) console.warn('[Gallo create] CCA fields dropped by layout filter:', ccaDropped.join(', '))
    if (ccaKept.length)    console.log  ('[Gallo create] CCA fields kept:', ccaKept.join(', '))
  } catch (e) {
    console.warn(`[Gallo create] Layout introspection failed (${e.message}); proceeding with raw payload`)
  }

  // Pre-flight diagnostic so we can correlate every attempt with its result
  // in the server log. Title + ISRC keeps each line uniquely identifiable.
  const _logId = `${payload['ISRC'] || '-'}/${(payload['Track Name'] || '').slice(0, 32)}`
  console.log(`[Gallo create] → POST ${_logId} (${Object.keys(payload).length} fields)`)
  _recordCreateEvent({
    phase:      'post',
    isrc:       payload['ISRC'] || null,
    title:      payload['Track Name'] || null,
    catalogue:  payload['Album Catalogue Number'] || null,
    sent:       Object.keys(payload),
    dropped,
  })

  const res = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: payload })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    const sentFields = Object.keys(payload).join(', ')
    console.error(`[Gallo create] ✗ POST ${_logId} — HTTP ${res.status}: ${msg}`)
    _recordCreateEvent({
      phase: 'error', isrc: payload['ISRC'] || null, title: payload['Track Name'] || null,
      http_status: res.status, error: msg, sent: Object.keys(payload),
    })
    throw new Error(`Gallo FM create failed: ${msg} (sent fields: ${sentFields}${dropped.length ? `; dropped: ${dropped.join(', ')}` : ''})`)
  }
  const fmRecordId = String(json?.response?.recordId || '')
  if (!fmRecordId) {
    console.error(`[Gallo create] ✗ POST ${_logId} — 200 OK but no recordId in response: ${JSON.stringify(json).slice(0, 300)}`)
    _recordCreateEvent({
      phase: 'no_record_id', isrc: payload['ISRC'] || null, title: payload['Track Name'] || null,
      raw_response: JSON.stringify(json).slice(0, 500),
    })
    throw new Error('Gallo FM create returned no recordId')
  }
  console.log(`[Gallo create] ← ${_logId} → recordId ${fmRecordId}`)
  _recordCreateEvent({
    phase: 'recordId', isrc: payload['ISRC'] || null, title: payload['Track Name'] || null,
    recordId: fmRecordId,
  })

  // Verification read-back: fetch the record we just created and log a few key
  // fields. Surfaces silent failures where FM accepts the create but a script
  // trigger deletes the record, or where calculated fields swallow our values.
  if (process.env.GALLO_CREATE_VERIFY !== 'false') {
    try {
      const verifyRes  = await galloFetch(`/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${fmRecordId}`)
      const verifyJson = await verifyRes.json().catch(() => ({}))
      if (!verifyRes.ok) {
        const msg = verifyJson?.messages?.[0]?.message || ''
        console.warn(`[Gallo create verify] Record ${fmRecordId} not retrievable after create — HTTP ${verifyRes.status} ${msg}`)
        _recordCreateEvent({
          phase: 'verify_404', isrc: payload['ISRC'] || null, title: payload['Track Name'] || null,
          recordId: fmRecordId, http_status: verifyRes.status, error: msg,
        })
      } else {
        const f = verifyJson?.response?.data?.[0]?.fieldData || {}
        const wantCat   = payload['Album Catalogue Number']
        const gotCat    = f['Album Catalogue Number']
        const wantIsrc  = payload['ISRC']
        const gotIsrc   = f['ISRC']
        const wantTitle = payload['Track Name']
        const gotTitle  = f['Track Name']
        const ok = gotCat === wantCat && gotIsrc === wantIsrc && gotTitle === wantTitle
        if (ok) {
          console.log(`[Gallo create verify] ✓ rec ${fmRecordId} — cat="${gotCat}" isrc="${gotIsrc}" title="${gotTitle}"`)
          _recordCreateEvent({
            phase: 'verify_ok', recordId: fmRecordId,
            isrc: gotIsrc, title: gotTitle, catalogue: gotCat,
          })
        } else {
          console.warn(`[Gallo create verify] ✗ rec ${fmRecordId} — values didn't stick:`)
          console.warn(`    Album Catalogue Number  sent="${wantCat}"  stored="${gotCat}"`)
          console.warn(`    ISRC                    sent="${wantIsrc}" stored="${gotIsrc}"`)
          console.warn(`    Track Name              sent="${wantTitle}" stored="${gotTitle}"`)
          _recordCreateEvent({
            phase: 'verify_mismatch', recordId: fmRecordId,
            sent:   { catalogue: wantCat, isrc: wantIsrc, title: wantTitle },
            stored: { catalogue: gotCat,  isrc: gotIsrc,  title: gotTitle  },
          })
        }
      }
    } catch (e) {
      console.warn(`[Gallo create verify] Read-back failed for rec ${fmRecordId}: ${e.message}`)
      _recordCreateEvent({
        phase: 'verify_error', recordId: fmRecordId, error: e.message,
      })
    }
  }

  return { fmRecordId, dropped }
}

/**
 * Create a record in the Tape Files Master layout.
 *
 * GALLO_FM_TAPE_LAYOUT must be set in .env to the album-level layout name
 * (typically `API_Tape_Files`). If it's missing we throw rather than silently
 * fall back to GALLO_FM_LAYOUT — falling back would write Tape Files records
 * onto the Songs layout, which is unrecoverable without a manual cleanup.
 */
const TAPE_LAYOUT = process.env.GALLO_FM_TAPE_LAYOUT || ''

export async function createTapeFileRecord(metadata) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  if (!TAPE_LAYOUT) {
    throw new Error('GALLO_FM_TAPE_LAYOUT env var is not set — refusing to write Tape Files records (set it to e.g. "API_Tape_Files" in .env)')
  }

  const fieldData = {}
  // Tape Files uses 'Reference Catalogue Number' as the native catalogue
  // field. Other album-level fields (Genre, Label, pLine, cLine, Release Date,
  // Language, etc.) live here too and cascade onto Song records via the FM
  // relationship — that's why the corresponding fields on API_Album_Songs
  // are calculated/lookup fields. Send everything we have; the introspection
  // filter will drop any that aren't on this layout.
  const albumArtist = metadata.album_artist || metadata.artist || ''
  if (albumArtist)             fieldData['Album Artist']               = albumArtist
  if (metadata.album)          fieldData['Album Title']                = metadata.album
  if (metadata.album_description) fieldData['Album Description']        = metadata.album_description
  if (metadata.catalogue_no)   fieldData['Reference Catalogue Number'] = metadata.catalogue_no
  // Also write Album Catalogue Number in case the Tape Files layout has it
  // (introspection drops if not present). Belt-and-braces.
  if (metadata.catalogue_no)   fieldData['Album Catalogue Number']     = metadata.catalogue_no
  if (metadata.barcode)      { fieldData['Barcode']                    = String(metadata.barcode)
                               fieldData['UPC']                        = String(metadata.barcode) }
  if (metadata.year)           fieldData['Year of Release']            = String(metadata.year)
  if (metadata.release_date)   fieldData['Release Date']               = metadata.release_date
  if (metadata.original_release_date) fieldData['Original Release date'] = metadata.original_release_date
  if (metadata.genre)          fieldData['Genre']                      = metadata.genre
  if (metadata.local_genre)    fieldData['Local Genre']                = metadata.local_genre
  if (metadata.sub_genre)      fieldData['Sub Genre']                  = metadata.sub_genre
  if (metadata.language) {
    fieldData['Language'] = metadata.language
    const iso = metadata.language.length <= 3
      ? metadata.language
      : languageNameToCode(metadata.language)
    if (iso) fieldData['Language Code'] = iso
  }
  if (metadata.country)        fieldData['Country']                    = metadata.country
  if (metadata.rights_territories) fieldData['Rights Territories']      = metadata.rights_territories
  if (metadata.parental)     { fieldData['Lyrical Content rating']     = metadata.parental
                               fieldData['Parental']                   = metadata.parental }
  if (metadata.label)          fieldData['Label']                      = metadata.label
  if (metadata.p_line)         fieldData['pLine']                      = metadata.p_line
  if (metadata.c_line)         fieldData['cLine']                      = metadata.c_line
  _applyCcaRules(fieldData, metadata)
  if (metadata.publishers)   { fieldData['Publishers']                 = metadata.publishers
                               fieldData['Publisher']                  = metadata.publishers }

  // Drop unknown field names on the Tape Files layout, same as createGalloRecord.
  let payload = fieldData
  try {
    const known = await getGalloLayoutFieldSet(TAPE_LAYOUT)
    const filt  = _filterToKnownGalloFields(fieldData, known)
    payload     = filt.kept
    if (filt.dropped.length && !_galloDropLogged.has(TAPE_LAYOUT)) {
      console.warn(`[Gallo tape create] On ${TAPE_LAYOUT}, dropping unknown fields: ${filt.dropped.join(', ')}`)
      _galloDropLogged.add(TAPE_LAYOUT)
    }
    const ccaCheck = ['Language','Language Code','Original Release date','Rights Territories','Parental','Lyrical Content rating']
    const ccaKept    = ccaCheck.filter(f => f in payload)
    const ccaDropped = ccaCheck.filter(f => f in fieldData && !(f in payload))
    if (ccaDropped.length) console.warn('[Gallo tape create] CCA fields dropped by layout filter:', ccaDropped.join(', '))
    if (ccaKept.length)    console.log  ('[Gallo tape create] CCA fields kept:', ccaKept.join(', '))
  } catch (e) {
    console.warn(`[Gallo tape create] Layout introspection failed (${e.message}); proceeding with raw payload`)
  }

  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(TAPE_LAYOUT)}/records`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData: payload })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Tape Files Master create failed: ${msg}`)
  }
  return { tapeRecordId: String(json?.response?.recordId || '') }
}

/**
 * Update fields on an existing Gallo record.
 * @param {string} fmRecordId — FileMaker internal record ID
 * @param {object} fieldData  — { 'FM Field Name': value, ... }
 */
export async function updateGalloRecord(fmRecordId, fieldData) {
  const res = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${fmRecordId}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fieldData })
    }
  )
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error(`Gallo FM update failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return true
}

/**
 * Run a FileMaker script against an existing record.
 * Uses a GET on the record with ?script= which triggers the script server-side.
 */
// Run a script after isolating a single record via _find.
// findField / findValue: a field that uniquely identifies the record (e.g. 'File URL', s3_url).
/**
 * Run a FileMaker script directly on a known record by its internal FM record ID.
 * scriptParam is passed as Get(ScriptParameter) inside the script.
 */
export async function runScriptOnRecord(fmRecordId, scriptName, scriptParam) {
  let url = `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${fmRecordId}?script=${encodeURIComponent(scriptName)}`
  if (scriptParam) url += `&script.param=${encodeURIComponent(scriptParam)}`
  const res  = await galloFetch(url)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Script "${scriptName}" failed: ${msg}`)
  }
  const scriptError = json?.response?.scriptError
  if (scriptError && scriptError !== '0') {
    throw new Error(`Script "${scriptName}" FM error code: ${scriptError}`)
  }
  return true
}

export async function runGalloScript(scriptName, findField, findValue) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query:  [{ [findField]: `==${findValue}` }],
        script: scriptName
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    throw new Error(`Script "${scriptName}" failed: ${msg}`)
  }
  const scriptError = json?.response?.scriptError
  if (scriptError && scriptError !== '0') {
    throw new Error(`Script "${scriptName}" FM error code: ${scriptError}`)
  }
  return true
}

/**
 * Pick the first non-empty value from a list of FM field names.
 * Lets us tolerate variation in the layout's exact field naming.
 */
function pick(fieldData, candidates) {
  for (const name of candidates) {
    const v = fieldData[name]
    if (v != null && String(v).trim() !== '') return v
  }
  return null
}

/**
 * Collect a series of numbered fields into an array of trimmed, deduped names.
 * The first slot is the unsuffixed name (e.g. "Composer"); subsequent slots are
 * "Composer 2", "Composer 3", … up to `max`.
 */
function collectNumbered(fieldData, prefix, max = 4) {
  const out = []
  const slots = [prefix]
  for (let i = 2; i <= max; i++) {
    slots.push(`${prefix} ${i}`)
    slots.push(`${prefix}${i}`)
  }
  // Also tolerate `Composer 1`, `Producer 1` if someone numbered the first slot.
  slots.unshift(`${prefix} 1`, `${prefix}1`)
  const seen = new Set()
  for (const slot of slots) {
    const v = fieldData[slot]
    if (v == null) continue
    const s = String(v).trim()
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
  }
  return out
}

/**
 * Normalise an FM record into the shape the rest of the app uses.
 * Field names match what's visible on the Gallo Catalogue layout in FileMaker;
 * we tolerate a few legacy alternatives so a rename can't break the read.
 */
function mapGalloRecord(record) {
  const f = record.fieldData || {}

  // Collect numbered singular fields (Composer, Composer 2 …) then also check the
  // plural form (Composers / Producers) which may hold a semicolon-separated list.
  const splitPlural = (val) => val ? String(val).split(/[;,]/).map(s => s.trim()).filter(Boolean) : []
  const composers = collectNumbered(f, 'Composer', 4).length
    ? collectNumbered(f, 'Composer', 4)
    : splitPlural(f['Composers'])
  const producers = collectNumbered(f, 'Producer', 4).length
    ? collectNumbered(f, 'Producer', 4)
    : splitPlural(f['Producers'])



  const artworkUrl = pick(f, ['Artwork URL', 'Artwork Url', 'Image URL', 'Artwork_S3_URL', 'Artwork_URL'])

  // Filename.wav holds the audio filename ready to use, e.g. GCAT00001.wav.
  // Derive a bare asset number (no extension) from it for the XML's ProprietaryId.
  const wavFilename  = pick(f, ['Filename', 'Filename.wav', 'Audio Filename'])
  const assetFromWav = wavFilename ? String(wavFilename).trim().replace(/\.[^.]+$/, '') : null
  const assetNumber  = assetFromWav || pick(f, [
    'Asset Number', 'Track Asset Number', 'Asset No', 'Asset #',
    'Filename', 'File Name',
    'Track Catalogue Number', 'Reference Catalogue Number'
  ])

  const imageAssetNumber = pick(f, [
    'Artwork::Resource Reference', 'Artwork::Resource reference',
    'Artwork Asset Number', 'Image Asset Number',
    'Artwork::Asset Number', 'Image::Asset Number',
    'Artwork::Filename.jpg', 'Artwork::Filename',
    'Artwork File Name', 'Image File Name', 'Artwork::File Name'
  ]) || (artworkUrl ? artworkUrl.split('/').pop().replace(/\.[^.]+$/, '') : null)

  return {
    fm_record_id:          String(record.recordId || ''),
    title:                 pick(f, ['Song Title', 'Track Name', 'Track Title', 'Title']),
    version_title:         pick(f, ['Version']),
    artist_name:           pick(f, ['Track Artist', 'Artist']),
    album_artist:          pick(f, ['Album Artist']),
    featured_artist:       pick(f, ['Featured Artist']),
    album_title:           pick(f, ['Album Title']),
    album_description:     pick(f, ['Album Description']),
    catalogue_no:          pick(f, ['Album Cat: Number', 'Album Catalogue Number', 'Catalogue Number']),
    asset_number:          assetNumber ? String(assetNumber).trim() : null,
    wav_filename:          wavFilename ? String(wavFilename).trim() : null,
    image_asset_number:    imageAssetNumber ? String(imageAssetNumber).trim() : null,
    resource_reference:    pick(f, ['Resource Reference']),
    technical_resource:    pick(f, ['Technical Resource', 'Technical Resource Reference']),
    audio_hash_md5:        pick(f, ['AudioHashSum', 'Audio Hash', 'MD5', 'Audio MD5']),
    isrc:                  pick(f, ['ISRC']),
    iswc:                  pick(f, ['ISWC']),
    barcode:               pick(f, ['Barcode', 'UPC', 'ICPN']),
    sequence_no:           parseInt(pick(f, ['Sequence Number', 'Track Number']), 10) || null,
    year:                  pick(f, ['Year', 'Year of Release']),
    release_date:          pick(f, ['Release Date']),
    original_release_date: pick(f, ['Original Release date', 'Original Release Date']),
    genre:                 pick(f, ['Genre', 'Local Genre']),
    sub_genre:             pick(f, ['Sub Genre', 'SubGenre']),
    language:              pick(f, ['Language Code', 'Language']),
    country:               pick(f, ['Country']),
    duration_sec:          parseDurationSec(pick(f, ['Duration'])),
    explicit:              pick(f, ['Parental', 'Explicit']) === 'Explicit'
                           || pick(f, ['Explicit']) === 'Yes',
    label:                 pick(f, ['Label']),
    pline_text:            pick(f, ['pLine', 'PLine']),
    cline_text:            pick(f, ['cLine', 'CLine']),
    s3_url:                pick(f, ['File URL', 'Audio URL', 'S3 URL']),
    audio_container_url:   pick(f, ['Audio File', 'Audio', 'WAV', 'Audio Container']),
    artwork_container_url: pick(f, [
      'artwork::picture', 'Artwork::picture', 'Artwork::Picture', 'artwork::Picture',
      'artwork::image', 'Artwork::image', 'Artwork::Image',
      'Artwork', 'Picture'
    ]),
    artwork_url:           artworkUrl,
    composers,
    producers,
    publishers:            pick(f, ['Publishers', 'Publisher']),
  }
}

/**
 * Parse "00:04:30" or "00:04:30.900" or "270" or "PT4M30S" into seconds.
 * Returns null if it can't make sense of the input.
 */
function parseDurationSec(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  // Numeric seconds
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  // ISO-8601: PT#H#M#S
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (iso) return Math.round((+iso[1]||0)*3600 + (+iso[2]||0)*60 + (+iso[3]||0))
  // hh:mm:ss(.ms) or mm:ss
  const parts = s.split(':').map(p => parseFloat(p))
  if (parts.every(n => !isNaN(n))) {
    if (parts.length === 3) return Math.round(parts[0]*3600 + parts[1]*60 + parts[2])
    if (parts.length === 2) return Math.round(parts[0]*60 + parts[1])
  }
  return null
}

/**
 * Find all Gallo Catalogue records matching a catalogue number.
 * Returns an array of normalised track objects.
 */
export async function findGalloRecordsByCatalogue(catalogueNo) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')

  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: [{ 'Album Catalogue Number': `==${catalogueNo}` }], limit: 200 })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
    // Code 401 from _find means no records found
    if (json?.messages?.[0]?.code === '401') return []
    throw new Error(`Gallo FM find failed: ${msg}`)
  }

  return (json?.response?.data || []).map(mapGalloRecord)
}

/**
 * Find all Gallo Catalogue records whose Filename.wav starts with a given barcode.
 * e.g. barcode "198704266508" matches "198704266508_004_004.wav"
 * Searches Filename.wav with a wildcard because the Barcode field may not yet be populated.
 */
/**
 * Find all records whose Filename.wav starts with the given barcode.
 * e.g. barcode "198704266508" matches "198704266508_004_004.wav"
 */
/**
 * Find all records whose Filename.wav starts with the given barcode.
 * Tries searchable fields first; falls back to paging + filtering if needed.
 */
/**
 * Find all records whose Filename starts with the given barcode.
 * e.g. barcode "198704266508" matches "198704266508_004_004.wav"
 * (Field was previously called Filename.wav — renamed to Filename to allow _find queries.)
 */
export async function findGalloRecordsByBarcode(barcode) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: [{ 'Filename': `${barcode}*` }], limit: 500 })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return []
    throw new Error(`Gallo FM find by barcode failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  return (json?.response?.data || []).map(mapGalloRecord)
}

/**
 * Live search across Track Name, Track Artist, Album Title, ISRC and Catalogue Number.
 * Uses FileMaker OR-find (multiple query objects = OR logic).
 * @param {string} term — search string, minimum 2 chars
 * @param {number} [limit=50]
 */
/**
 * Search the Gallo Catalogue across key fields.
 * Returns { tracks, foundCount } where foundCount is the total FM match count
 * (which may be larger than tracks.length if offset/limit are used).
 * @param {string} term
 * @param {number} [limit=50]
 * @param {number} [offset=0]
 */
export async function searchGalloRecords(term, limit = 50, offset = 0) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  if (!GALLO_FM_LAYOUT) throw new Error('GALLO_FM_LAYOUT not set')
  if (!term || term.trim().length < 2) return { tracks: [], foundCount: 0 }

  const t = term.trim()
  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        query: [
          { 'Track Name':            `*${t}*` },
          { 'Track Artist':          `*${t}*` },
          { 'Album Title':           `*${t}*` },
          { 'ISRC':                  `*${t}*` },
          { 'Album Catalogue Number': `*${t}*` }
        ],
        limit,
        // FM Data API uses 1-based offset; omit entirely on first page (FM defaults to 1)
        ...(offset > 0 ? { offset: offset + 1 } : {})
      })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return { tracks: [], foundCount: 0 }
    throw new Error(json?.messages?.[0]?.message || `HTTP ${res.status}`)
  }

  const foundCount = Number(json?.response?.dataInfo?.foundCount ?? 0)

  function parseSeq(val) {
    if (val == null || val === '') return null
    const n = parseInt(String(val).trim(), 10)
    return isNaN(n) ? null : n
  }

  const tracks = (json?.response?.data || []).map(record => {
    const f = record.fieldData || {}
    return {
      fm_record_id: String(record.recordId || ''),
      title:        f['Track Name']             || null,
      artist_name:  f['Track Artist']           || null,
      album_title:  f['Album Title']            || null,
      catalogue_no: f['Album Catalogue Number'] || null,
      isrc:         f['ISRC']                   || null,
      barcode:      f['Barcode']                || null,
      sequence_no:  parseSeq(f['Sequence Number']),
      year:         f['Year of Release']                            || null,
      genre:        f['Genre']         || f['Local Genre']           || null,
      language:     f['Language']      || f['Language Code']         || null,
      duration_sec: parseFloat(f['Duration'])                        || null,
      explicit:     f['Explicit'] === 'Yes',
      s3_url:       f['File URL']                                    || null,
      artwork_url:  f['Artwork URL']                                 || null,
    }
  })

  return { tracks, foundCount }
}

/**
 * Fetch all records from the Gallo Catalogue layout, paging in batches.
 * Returns an array of normalised track objects (same shape as findGalloRecordsByCatalogue).
 * @param {number} [batchSize=100]  records per request (FM max is 100 without extra config)
 */
export async function getAllGalloRecords(batchSize = 100) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  if (!GALLO_FM_LAYOUT) throw new Error('GALLO_FM_LAYOUT not set')

  function mapRecord(record) {
    const f = record.fieldData || {}
    return {
      fm_record_id:  String(record.recordId || ''),
      title:         f['Track Name']            || null,
      artist_name:   f['Track Artist']          || null,
      album_title:   f['Album Title']           || null,
      catalogue_no:  f['Album Catalogue Number']|| null,
      isrc:          f['ISRC']                  || null,
      barcode:       f['Barcode']               || null,
      sequence_no:   parseInt(f['Sequence Number'], 10) || null,
      year:          f['Year of Release']                           || null,
      genre:         f['Genre']     || f['Local Genre']             || null,
      language:      f['Language']  || f['Language Code']           || null,
      duration_sec:  parseFloat(f['Duration'])                      || null,
      explicit:      f['Explicit'] === 'Yes',
      s3_url:        f['File URL']              || null,
      artwork_url:   f['Artwork URL']           || null,
    }
  }

  const all = []
  let offset = 0

  // First call — also tells us the total count
  const firstRes = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records?_limit=${batchSize}&_offset=${offset}`
  )
  const firstJson = await firstRes.json().catch(() => ({}))
  if (!firstRes.ok) {
    const msg = firstJson?.messages?.[0]?.message || `HTTP ${firstRes.status}`
    throw new Error(`Gallo FM getAllRecords failed: ${msg}`)
  }

  const totalCount = Number(firstJson?.response?.dataInfo?.totalRecordCount || 0)
  const firstBatch = firstJson?.response?.data || []
  firstBatch.forEach(r => all.push(mapRecord(r)))
  offset += firstBatch.length

  // Page through remaining records
  while (all.length < totalCount) {
    const res  = await galloFetch(
      `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records?_limit=${batchSize}&_offset=${offset}`
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`
      throw new Error(`Gallo FM getAllRecords (page) failed: ${msg}`)
    }
    const batch = json?.response?.data || []
    if (!batch.length) break  // safety guard
    batch.forEach(r => all.push(mapRecord(r)))
    offset += batch.length
  }

  return all
}

/**
 * Fetch a small sample of raw records and return their Filename-related field values.
 * Used by the debug endpoint to see exactly what FM is storing.
 */
export async function getRawGalloSample(limit = 3) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  const res  = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records?_limit=${limit}`
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`FM sample fetch failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  return (json?.response?.data || []).map(r => {
    const f = r.fieldData || {}
    return {
      recordId:       r.recordId,
      'Filename':     f['Filename']     ?? '(empty)',
      'Filename.wav': f['Filename.wav'] ?? '(empty)',
      'Barcode':      f['Barcode']      ?? '(empty)',
      'Track Name':   f['Track Name']   ?? '(empty)',
    }
  })
}

/**
 * Check FM connectivity — returns true if login succeeds.
 */
export async function pingGallo() {
  try { await getToken(); return true }
  catch (_) { return false }
}

/**
 * Find one Gallo Catalogue track by catalogue + sequence (preferred) or ISRC.
 * Returns a flat object with the canonical metadata + audio URL, or null.
 * Used by the MadStreamer push so MadStreamer can use Gallo as its source
 * of truth instead of relying on stale submission data.
 */
export async function getGalloTrack({ catalogue_no, sequence_no, isrc }) {
  if (!base) throw new Error('GALLO_FM_* env vars not configured')
  if (!GALLO_FM_LAYOUT) throw new Error('GALLO_FM_LAYOUT not set')

  const queries = []
  if (catalogue_no && sequence_no != null) {
    queries.push({ 'Album Catalogue Number': `==${catalogue_no}`, 'Sequence Number': `==${sequence_no}` })
  } else if (catalogue_no) {
    queries.push({ 'Album Catalogue Number': `==${catalogue_no}` })
  }
  if (isrc) queries.push({ 'ISRC': `==${isrc}` })
  if (!queries.length) return null

  const res = await galloFetch(
    `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: queries, limit: 1 })
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (json?.messages?.[0]?.code === '401') return null
    throw new Error(`Gallo getGalloTrack failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`)
  }
  const rec = json?.response?.data?.[0]
  if (!rec) return null
  const f = rec.fieldData || {}

  // Parse the FileMaker container reference if present:
  //   movie:filename.wav\nmoviemac:/abs/path/filename.wav
  function parseAudioFile(val) {
    if (!val) return { filename: null, mac_path: null }
    const lines = String(val).split(/\r?\n/)
    const filename = (lines.find(l => l.startsWith('movie:')) || '').replace(/^movie:/, '').trim() || null
    const macPath  = (lines.find(l => l.startsWith('moviemac:')) || '').replace(/^moviemac:/, '').trim() || null
    return { filename, mac_path: macPath }
  }
  const audioRef = parseAudioFile(f['Audio File'])

  // Audio asset filename. Prefer the canonical Filename field; fall back to the
  // legacy Filename.wav field, then to the parsed container reference.
  // The bare GCAT (no extension, no path) is what S3 paths use: mp3/<GCAT>.mp3.
  const rawFilename =
       (f['Filename']     && String(f['Filename']).trim())
    || (f['Filename.wav'] && String(f['Filename.wav']).trim())
    || audioRef.filename
    || null
  // Strip any moviemac:/path/components/, then strip extension.
  function _basename(p) {
    if (!p) return null
    const s = String(p).replace(/^moviemac:/, '').trim()
    const i = s.lastIndexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  }
  const filenameField = _basename(rawFilename)
  const gcat = filenameField ? filenameField.replace(/\.[^.]+$/, '') : null

  return {
    fm_record_id:      String(rec.recordId || ''),
    title:             f['Track Name']             || null,
    artist:            f['Track Artist']           || null,
    album_artist:      f['Album Artist']           || f['Track Artist'] || null,
    album:             f['Album Title']            || null,
    catalogue_no:      f['Album Catalogue Number'] || f['Reference Catalogue Number'] || null,
    isrc:              f['ISRC']                   || null,
    barcode:           f['Barcode']                || null,
    sequence_no:       f['Sequence Number']        ? parseInt(String(f['Sequence Number']).trim(), 10) : null,
    year:              f['Year of Release']        || null,
    release_date:      f['Release Date']                                   || null,
    genre:             f['Genre']           || f['Local Genre']             || null,
    language:          f['Language']        || f['Language Code']           || null,
    bpm:               f['BPM']                                             || null,
    duration:          f['Duration']                                        || null,
    explicit:          f['Explicit'] === 'Yes',
    composers:         f['Composers']                                       || null,
    producers:         f['Producers']                                       || null,
    publishers:        f['Publishers']                                      || null,
    label:             f['Label']                                           || null,
    p_line:            f['pLine']           || f['PLine']                   || null,
    c_line:            f['cLine']           || f['CLine']                   || null,
    audio_url:         f['File URL']               || null,    // S3 URL on the record
    filename:          filenameField,                          // e.g. "GCAT00001.wav"
    gcat,                                                      // e.g. "GCAT00001"
    audio_mac_path:    audioRef.mac_path,                      // local path on Vision
    artwork_url:       f['Artwork URL']            || null,
    raw:               f,
  }
}

/**
 * Fetch the values of a named FileMaker value list from layout metadata.
 * Returns an array of display value strings, or [] if not found.
 *
 * @param {string} listName   — exact name of the value list in FileMaker
 * @param {string} [layout]   — layout to fetch metadata from (defaults to GALLO_FM_LAYOUT)
 */
export async function getValueList(listName, layout = GALLO_FM_LAYOUT) {
  if (!base || !layout) return []
  const token = await getToken()
  const res = await fetch(
    `${base}/layouts/${encodeURIComponent(layout)}/metadata`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  )
  if (!res.ok) throw new Error(`FM metadata fetch failed: HTTP ${res.status}`)
  const json = await res.json()
  const list = (json.response?.valueLists || []).find(vl => vl.name === listName)
  return (list?.values || []).map(v => v.displayValue).filter(Boolean)
}

/**
 * Download the contents of a FileMaker container field.
 *
 * FM's Data API returns a temporary streaming URL inside `fieldData` for any
 * container field. The URL embeds a one-shot token: GET it once, FM responds
 * with a 302 + Set-Cookie, then the cookie must accompany the next GET that
 * actually delivers the bytes. Node's fetch doesn't carry cookies across
 * redirects on its own, so we walk the redirect chain manually.
 *
 * @param {string} url — the URL FM returned for the container field
 * @returns {Promise<Buffer>}
 */
export async function fetchContainerData(url) {
  if (!url) throw new Error('fetchContainerData: empty URL')
  // Make sure we have a live session — FM rejects container URLs once the
  // associated session token expires.
  await getToken()

  let current = url
  let cookies = ''
  const MAX_REDIRECTS = 5

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const { signal, clear } = withTimeout(FM_TIMEOUT_MS)
    let res
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: cookies ? { Cookie: cookies } : {},
      })
    } finally { clear() }

    // Capture/merge any new cookies before deciding what to do
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      // Keep just the name=value pair from each Set-Cookie line
      const fresh = setCookie.split(/,(?=[^ ]+=)/)
        .map(c => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ')
      cookies = cookies ? `${cookies}; ${fresh}` : fresh
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) throw new Error(`Container fetch: redirect with no Location (HTTP ${res.status})`)
      current = new URL(next, current).toString()
      continue
    }
    if (!res.ok) {
      throw new Error(`Container fetch failed: HTTP ${res.status} ${res.statusText}`)
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }
  throw new Error(`Container fetch: too many redirects (>${MAX_REDIRECTS})`)
}
