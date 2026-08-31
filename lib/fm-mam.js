/**
 * lib/fm-mam.js — Music Arena Master as a DDEX source.
 *
 * MAM is the merge of Gallo Catalogue + CMS 2024 + MADStreamer, so its metadata
 * is the best of the three per field, and unlike them it carries BOTH pointers
 * a DDEX build needs on the record itself: Audio_Vision_URL (the 24-bit master)
 * and Artwork_S3_URL. The CMS source has to hydrate file references from Gallo
 * afterwards; this one does not.
 *
 * Returns the same flat track shape as findGalloRecordsByCatalogue, so the rest
 * of the build pipeline treats all three sources identically.
 */

const HOST = () => String(process.env.GALLO_FM_HOST || '').replace(/\/$/, '')
const DB   = () => process.env.MAM_FM_DB || 'Music Arena Master'
const SONGS_LAYOUT  = () => process.env.MAM_FM_SONGS_LAYOUT  || 'Songs'
const ALBUMS_LAYOUT = () => process.env.MAM_FM_ALBUMS_LAYOUT || 'Albums'

const JUNK = new Set(['', '?', '#N/A', 'N/A', 'NA', '-', '0', 'NONE', 'NULL'])
const val = v => {
  const s = String(v ?? '').trim()
  return JUNK.has(s.toUpperCase()) ? null : s
}

async function session() {
  const base = `${HOST()}/fmi/data/vLatest/databases/${encodeURIComponent(DB())}`
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const r = await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })
  const j = await r.json()
  const token = j?.response?.token
  if (!token) throw new Error(`Music Arena Master auth failed: ${j?.messages?.[0]?.message || r.status}`)
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  return {
    find: async (layout, query, limit = 200) => {
      const res = await fetch(`${base}/layouts/${encodeURIComponent(layout)}/_find`,
        { method: 'POST', headers: H, body: JSON.stringify({ query: [query], limit }) })
      const j2 = await res.json()
      if (j2?.messages?.[0]?.code === '401') return []      // no records found
      if (!j2?.response?.data) throw new Error(`${layout} find failed: ${j2?.messages?.[0]?.message}`)
      return j2.response.data.map(d => d.fieldData)
    },
    close: () => fetch(base + '/sessions/' + token, { method: 'DELETE', headers: H }).catch(() => {}),
  }
}

/** "00:04:30" / "270" / "PT4M30S" → seconds. */
function durationSec(v) {
  const s = val(v)
  if (!s) return null
  let m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/)
  if (m) return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2], 10) * 60) + Math.round(parseFloat(m[3]))
  m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i)
  if (m) return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + Math.round(parseFloat(m[3] || '0'))
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s))
  return null
}

/** Map one MAM song (+ its album) into the flat shape the DDEX builder wants. */
function mapMamRecord(s, a) {
  const visionAudio = val(s['Audio_Vision_URL'])
  // The WAV filename DDEX ships is the master's own basename where we have it;
  // planDdex falls back to <asset>.wav when it is absent.
  const wavFilename = visionAudio ? decodeURIComponent(visionAudio.split('?')[0].split('/').pop()) : null
  const artUrl = val(a['Artwork_S3_URL'])
  // artwork/GMVi3752.jpg → GMVi3752, which is the image asset id Ingrooves sees.
  const imageAsset = artUrl ? artUrl.split('/').pop().replace(/\.[^.]+$/, '') : null

  const composers = [s['Composer'], s['Composer 2'], s['Composer 3'], s['Composer 4']]
    .map(val).filter(Boolean)
  const producers = [s['Producer'], s['Producers']].map(val).filter(Boolean)

  return {
    fm_record_id:          null,
    master_id:             val(s['MasterID']),
    title:                 val(s['Track Name']),
    version_title:         val(s['Version']),
    artist_name:           val(s['Track Artist']),
    album_artist:          val(a['Album Artist']) || val(s['Track Artist']),
    featured_artist:       val(s['Featured Artist']),
    album_title:           val(a['Album Title']),
    album_description:     null,
    catalogue_no:          val(a['Album Catalogue Number']) || val(a['Reference Catalogue Number']),
    asset_number:          val(s['Filename']),
    wav_filename:          wavFilename,
    image_asset_number:    imageAsset,
    resource_reference:    null,      // planDdex derives A<asset>
    technical_resource:    null,      // planDdex derives T<asset>
    audio_hash_md5:        val(s['AudioHashSum']),
    isrc:                  val(s['ISRC']),
    iswc:                  null,
    barcode:               val(a['UPC']),
    sequence_no:           parseInt(val(s['Sequence Number']) || val(s['Track Number']), 10) || null,
    year:                  val(a['Year of Release']),
    release_date:          val(a['Release Date']),
    original_release_date: val(s['Original Release Date']),
    // Genre feeds Ingrooves' controlled vocabulary — do not normalise, and do
    // not reorder this pick (same rule as the Gallo mapper).
    genre:                 val(s['Genre']) || val(a['Genre']),
    local_genre:           val(s['Local Genre']),
    sub_genre:             val(s['Sub Genre']),
    language:              val(s['Language Code']) || val(s['Language']),
    country:               val(a['Country']),
    duration_sec:          durationSec(s['Duration']),
    explicit:              /explicit/i.test(String(s['Lyrical Content Rating'] || '')) &&
                           !/not\s*explicit/i.test(String(s['Lyrical Content Rating'] || '')),
    label:                 val(a['Label']),
    pline_text:            val(s['pLine']),
    cline_text:            val(s['cLine']),
    s3_url:                val(s['Audio_S3_URL']),
    audio_container_url:   null,
    // The canonical Vision master — what DDEX ships. MAM holds it directly, so
    // there is no hydrate-from-Gallo step for this source.
    audio_url_ref:         visionAudio,
    artwork_container_url: null,
    artwork_url:           artUrl,
    artwork_vision_path:   val(a['Artwork_Vision_URL']),
    composers,
    producers,
    publishers:            val(s['Publishers']),
  }
}

/** Every track of one MAM album, by catalogue number. */
export async function findMamRecordsByCatalogue(catalogueNo) {
  const cat = String(catalogueNo || '').trim()
  if (!cat) throw new Error('catalogue number is required')
  const fm = await session()
  try {
    // Catalogue numbers are spelled inconsistently across the source databases
    // (BL 789 vs BL789), and MAM holds two of them per album.
    let albums = []
    for (const c of [...new Set([cat, cat.replace(/\s+/g, '')])]) {
      for (const field of ['Album Catalogue Number', 'Reference Catalogue Number']) {
        albums = await fm.find(ALBUMS_LAYOUT(), { [field]: '==' + c }, 5)
        if (albums.length) break
      }
      if (albums.length) break
    }
    if (!albums.length) return []
    const album = albums[0]
    const songs = await fm.find(SONGS_LAYOUT(), { AlbumID: '==' + album['AlbumID'] }, 500)
    return songs.map(s => mapMamRecord(s, album))
  } finally { await fm.close() }
}

/** Every track of one MAM album, by AlbumID — the unambiguous form. */
export async function findMamRecordsByAlbumId(albumID) {
  const id = String(albumID || '').trim()
  if (!id) throw new Error('albumID is required')
  const fm = await session()
  try {
    const albums = await fm.find(ALBUMS_LAYOUT(), { AlbumID: '==' + id }, 1)
    if (!albums.length) return []
    const songs = await fm.find(SONGS_LAYOUT(), { AlbumID: '==' + id }, 500)
    return songs.map(s => mapMamRecord(s, albums[0]))
  } finally { await fm.close() }
}
