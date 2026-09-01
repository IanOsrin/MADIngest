/**
 * lib/fm-mam-write.js — create Albums and Songs in Music Arena Master.
 *
 * MAM is now the canonical catalogue, so imports land here rather than in Gallo
 * Catalogue. Its shape differs from Gallo's in ways that matter:
 *
 *  - There is no Tape Files record. An album IS a row on the Albums layout,
 *    joined to Songs by AlbumID.
 *  - MasterID / RecordingID / AlbumID are NOT auto-enter (verified against the
 *    layout metadata) — this module has to allocate them. It reads the current
 *    maximum from the table rather than trusting a stored counter, the same
 *    doctrine the GMVin/GMVn artwork and audio series use: a FileMaker-held
 *    counter for the artwork series went stale three separate times.
 *  - AlbumID is derived, not sequential: "ZQBH 1179" -> "ALB-ZQBH1179". That
 *    makes it reproducible, and makes a duplicate import collide loudly rather
 *    than quietly creating a second album for the same catalogue.
 *
 * Fields must be physically ON the addressed layout or FileMaker discards them
 * silently — the same gotcha as everywhere else in this codebase.
 */

const HOST = () => String(process.env.GALLO_FM_HOST || '').replace(/\/$/, '')
const DB   = () => process.env.MAM_FM_DB || 'Music Arena Master'
const SONGS_LAYOUT  = () => process.env.MAM_FM_SONGS_LAYOUT  || 'Songs'
const ALBUMS_LAYOUT = () => process.env.MAM_FM_ALBUMS_LAYOUT || 'Albums'

const base = () => `${HOST()}/fmi/data/vLatest/databases/${encodeURIComponent(DB())}`

/** Drop nulls/blanks — sending an empty string overwrites, sending nothing does not. */
const clean = (o) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== ''))

export async function mamSession() {
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const r = await fetch(base() + '/sessions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })
  const j = await r.json()
  const token = j?.response?.token
  if (!token) throw Object.assign(new Error('Could not reach Music Arena Master'), { status: 502 })
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }

  const api = {
    async find(layout, query, limit = 200) {
      const res = await fetch(`${base()}/layouts/${encodeURIComponent(layout)}/_find`,
        { method: 'POST', headers: H, body: JSON.stringify({ query, limit }) })
      const jj = await res.json()
      if (jj?.messages?.[0]?.code === '401') return []   // "no records match" is a normal empty result
      return jj?.response?.data || []
    },
    async create(layout, fieldData) {
      const res = await fetch(`${base()}/layouts/${encodeURIComponent(layout)}/records`,
        { method: 'POST', headers: H, body: JSON.stringify({ fieldData: clean(fieldData) }) })
      const jj = await res.json()
      const code = jj?.messages?.[0]?.code
      if (code !== '0') throw new Error(`${jj?.messages?.[0]?.message || 'create failed'} (code ${code})`)
      return jj.response.recordId
    },
    /** Highest existing value of a numbered ID field, e.g. MasterID -> 127532. */
    async maxSerial(layout, field) {
      const sort = encodeURIComponent(JSON.stringify([{ fieldName: field, sortOrder: 'descend' }]))
      const res = await fetch(`${base()}/layouts/${encodeURIComponent(layout)}/records?_limit=1&_sort=${sort}`, { headers: H })
      const jj = await res.json()
      const v = jj?.response?.data?.[0]?.fieldData?.[field]
      const m = String(v || '').match(/(\d+)\s*$/)
      return m ? Number(m[1]) : 0
    },
    logout: () => fetch(base() + '/sessions/' + token, { method: 'DELETE', headers: H }).catch(() => {}),
  }
  return api
}

/**
 * MAM's own AlbumID convention, measured against 3,996 existing albums rather
 * than assumed: "ALB-" + the catalogue's alphanumerics, uppercased, truncated
 * to 20 characters. 3,857 match exactly; the rest are side-split albums
 * carrying an A/B suffix, or long names that collided and got a hash suffix.
 *
 * Punctuation is STRIPPED, not just spaces — "CCA_022006" is "ALB-CCA022006".
 * Getting that wrong creates a second album for a catalogue that already has
 * one and orphans its songs, which is exactly what nearly happened here.
 */
export const albumIdFor = (catalogue) =>
  'ALB-' + String(catalogue || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20)

/**
 * Find an album by CATALOGUE NUMBER, not by derived ID.
 *
 * The derivation is lossy (truncation, side suffixes, collision hashes), so
 * asking "is ALB-XXX there?" answers a different question from "does this
 * catalogue already have an album?". The catalogue fields are authoritative.
 */
export async function findMamAlbum(db, catalogue) {
  const c = String(catalogue || '').trim()
  if (!c) return null
  const hit = await db.find(ALBUMS_LAYOUT(),
    [{ 'Album Catalogue Number': '==' + c }, { 'Reference Catalogue Number': '==' + c }], 2)
  return hit[0] || null
}

/** Is this AlbumID already used? A new album must never reuse one. */
export async function albumIdTaken(db, albumID) {
  const hit = await db.find(ALBUMS_LAYOUT(), [{ AlbumID: '==' + albumID }], 1)
  return hit.length > 0
}

/**
 * Allocates MasterID / RecordingID from the table's current maximum, once per
 * run, then counts up in memory. Reading the max per record would cost a round
 * trip each time and still race; reading once and holding the number is how the
 * GMVn series works.
 */
export async function makeIdAllocator(db) {
  let master = await db.maxSerial(SONGS_LAYOUT(), 'MasterID')
  let rec    = await db.maxSerial(SONGS_LAYOUT(), 'RecordingID')
  return {
    nextMaster: () => 'MAST' + String(++master).padStart(6, '0'),
    nextRecording: () => 'REC' + String(++rec).padStart(6, '0'),
    startedAt: { master, rec },
  }
}

export async function createMamAlbum(db, m) {
  return db.create(ALBUMS_LAYOUT(), {
    'AlbumID': albumIdFor(m.catalogue_no),
    'Album Catalogue Number': m.catalogue_no,
    'Reference Catalogue Number': m.catalogue_no,
    'Album Title': m.album,
    'Album Artist': m.album_artist,
    'Year of Release': m.year,
    'Release Date': m.release_date,
    'UPC': m.barcode,
    'Label': m.label,
    'Genre': m.genre,
    'Country': m.country,
    'Track Count': m.track_count,
    'Artwork_Vision_URL': m.artwork_url,
    'DDEX Status': m.ddex_status,
  })
}

export async function createMamSong(db, m) {
  return db.create(SONGS_LAYOUT(), {
    'MasterID': m.master_id,
    'RecordingID': m.recording_id,
    'AlbumID': m.album_id,
    'Sources': m.sources,
    'MatchMethod': m.match_method,
    'Album Catalogue': m.catalogue_no,
    'Filename': m.wav_filename,
    'ISRC': m.isrc,
    'Track Name': m.title,
    'Track Artist': m.artist,
    'Sequence Number': m.sequence_no,
    'Duration': m.duration,
    'Genre': m.genre,
    'Sub Genre': m.sub_genre,
    'Language': m.language,
    'Composers': m.composers,
    'Composer': m.composers,
    'Producers': m.producers,
    'Producer': m.producers,
    'Publishers': m.publishers,
    'Lyrical Content Rating': m.parental,
    'cLine': m.c_line,
    'pLine': m.p_line,
    'Rights Territories': m.rights_territories,
    'Original Release Date': m.original_release_date,
    'Audio_Truth': m.audio_url ? 'Vision' : null,
    'Audio_Vision_URL': m.audio_url,
    'AudioHashSum': m.audio_hash_md5,
  })
}

/**
 * Which of these catalogues already exist in MAM — one request per chunk rather
 * than a round trip per release (a batch is 85-141 releases).
 *
 * Asks the Albums layout, not Songs: 16k albums against 127k songs, and an
 * album row is exactly the thing an import would duplicate. Returns a Map of
 * catalogue -> track count already recorded, so the caller can show what is
 * there rather than just "exists".
 */
export async function findMamCataloguesPresent(catalogues, db = null) {
  const own = !db
  if (own) db = await mamSession()
  try {
    const wanted = [...new Set((catalogues || []).map(c => String(c || '').trim()).filter(Boolean))]
    const out = new Map()
    for (let i = 0; i < wanted.length; i += 100) {
      const chunk = wanted.slice(i, i + 100)
      const rows = await db.find(ALBUMS_LAYOUT(),
        chunk.flatMap(c => [{ 'Album Catalogue Number': '==' + c }, { 'Reference Catalogue Number': '==' + c }]), 400)
      for (const r of rows) {
        const cat = r.fieldData['Album Catalogue Number'] || r.fieldData['Reference Catalogue Number']
        if (cat) out.set(String(cat).trim(), Number(r.fieldData['Track Count']) || 1)
      }
    }
    // Match on the caller's spelling too: MAM may store "ZQBH 1179" where the
    // ERN said "ZQBH1179". Compare on alphanumerics so spacing cannot hide a
    // catalogue that is already there.
    const key = x => String(x || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    for (const c of wanted) {
      if (out.has(c)) continue
      for (const [k, v] of out) if (key(k) === key(c)) { out.set(c, v); break }
    }
    return out
  } finally { if (own) await db.logout() }
}
