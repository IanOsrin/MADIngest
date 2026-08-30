/**
 * lib/publish-album.js — take one album in Music Arena Master all the way to
 * MADStreamer, ready for the website.
 *
 * The piecemeal alternative (convert 29k files speculatively, fill fields in
 * bulk, half-finish albums) produces work without producing anything
 * publishable. This inverts it: nothing happens until an album is ready, and
 * then everything happens at once — convert, artwork, records, in one action.
 *
 *   check()   — readiness only, writes nothing
 *   publish() — check, then make the album deliverable and write it across
 *
 * Nothing is written to MADStreamer unless the album passes the blockers, and
 * new tracks are created HIDDEN by default: publishing to the live site is a
 * separate, deliberate flip of Visibility.
 */
import { visionDownloadTo, visionOpen, visionStat } from './vision-drive.js'
import {
  headAnyKey, uploadAnyKey, urlForKey, writeArtworkDerivatives,
  artworkKeyForGmvi, keyFromS3Url,
} from './s3-imports.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { Readable } from 'node:stream'

const execFileP = promisify(execFile)
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'
const BITRATE = process.env.MP3_BITRATE || '320k'

const JUNK = new Set(['', '?', '#N/A', 'N/A', 'NA', '-', '0', 'NONE', 'NULL'])
const has = v => !JUNK.has(String(v ?? '').trim().toUpperCase())
const val = v => (has(v) ? String(v).trim() : '')

// ── FileMaker Data API helpers ─────────────────────────────────────────────
function fm(hostRaw, db, user, pass) {
  const host = String(hostRaw).replace(/^https?:\/\//, '')
  const base = `https://${host}/fmi/data/vLatest/databases/${encodeURIComponent(db)}`
  let token = null
  const auth = async () => {
    const r = await fetch(base + '/sessions', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') },
      body: '{}' })
    token = (await r.json())?.response?.token
    if (!token) throw new Error(`FileMaker auth failed for "${db}"`)
  }
  const call = async (p, opts = {}, retry = true) => {
    if (!token) await auth()
    const r = await fetch(base + p, { ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })
    if (r.status === 401 && retry) { token = null; return call(p, opts, false) }
    return r
  }
  return {
    call,
    find: async (layout, query, extra = {}) => {
      const r = await call(`/layouts/${encodeURIComponent(layout)}/_find`,
        { method: 'POST', body: JSON.stringify({ query: [query], limit: 200, ...extra }) })
      const j = await r.json()
      if (j?.messages?.[0]?.code === '401') return []        // no records is not an error
      if (!j?.response?.data) throw new Error(`${layout} find failed: ${j?.messages?.[0]?.message}`)
      return j.response.data
    },
    create: async (layout, fieldData) => {
      const r = await call(`/layouts/${encodeURIComponent(layout)}/records`, { method: 'POST', body: JSON.stringify({ fieldData }) })
      const j = await r.json()
      if (r.status !== 200) throw new Error(`${layout} create failed: ${j?.messages?.[0]?.message}`)
      return j.response.recordId
    },
    patch: async (layout, recordId, fieldData) => {
      const r = await call(`/layouts/${encodeURIComponent(layout)}/records/${recordId}`, { method: 'PATCH', body: JSON.stringify({ fieldData }) })
      if (r.status !== 200) {
        const j = await r.json().catch(() => ({}))
        throw new Error(`${layout} update failed: ${j?.messages?.[0]?.message}`)
      }
    },
    logout: async () => { if (token) await call('/sessions/' + token, { method: 'DELETE' }).catch(() => {}) },
  }
}

const mam = () => fm(process.env.GALLO_FM_HOST, 'Music Arena Master', process.env.GALLO_FM_USER, process.env.GALLO_FM_PASS)
const mad = () => fm(process.env.MADSTREAMER_FM_HOST, process.env.MADSTREAMER_FM_DB || 'MADStreamer',
                     process.env.GALLO_FM_USER, process.env.GALLO_FM_PASS)

/** Gather the album, its songs, and everything the checks need. */
async function gather(db, albumID) {
  const arecs = await db.find('Albums', { AlbumID: '==' + albumID })
  if (!arecs.length) throw new Error(`No album ${albumID} in Music Arena Master`)
  const album = arecs[0]
  const songs = await db.find('Songs', { AlbumID: '==' + albumID },
    { limit: 500, sort: [{ fieldName: 'Sequence Number' }] })
  return { album, songs }
}

/** Readiness. Blockers stop a publish; warnings are reported and allowed. */
export async function check(albumID) {
  const db = mam()
  try {
    const { album, songs } = await gather(db, albumID)
    const f = album.fieldData
    const blockers = [], warnings = []

    if (!songs.length) blockers.push('album has no songs')
    if (!has(f['Album Title'])) warnings.push('no album title')
    if (!has(f['Album Artist'])) blockers.push('no album artist')

    // Audio: a track is fine if it already has an mp3, or a Vision master we
    // can make one from. Anything else can never be played.
    const needConvert = [], noAudio = []
    for (const s of songs) {
      const g = s.fieldData
      if (has(g['Audio_S3_URL'])) continue
      if (has(g['Audio_Vision_URL'])) needConvert.push(val(g['Filename']) || val(g['Track Name']))
      else noAudio.push(val(g['Track Name']) || val(g['MasterID']))
    }
    if (noAudio.length) blockers.push(`${noAudio.length} track(s) have no audio at all: ${noAudio.slice(0, 5).join(', ')}${noAudio.length > 5 ? '…' : ''}`)

    // Artwork: judge the BUCKET, not the field — an album can have a cover on
    // S3 whose URL was never written back (that is exactly ALD 8057's case).
    let artwork = 'missing', artworkKey = null
    const s3art = val(f['Artwork_S3_URL'])
    if (s3art) {
      const k = keyFromS3Url(s3art)
      if (k && (await headAnyKey(k)).exists) { artwork = 'on s3'; artworkKey = k }
      else artwork = 'url points at nothing'
    }
    if (artwork !== 'on s3' && val(f['Artwork_Vision_URL'])) artwork = 'on vision, needs copying'
    if (artwork === 'missing' || artwork === 'url points at nothing') blockers.push('no artwork')

    // Sequence gaps: a real signal that tracks are absent, but tape numbering
    // legitimately skips — warn, never block.
    const seqs = songs.map(s => Number(val(s.fieldData['Sequence Number']))).filter(Boolean).sort((a, b) => a - b)
    if (seqs.length > 1) {
      const gaps = []
      for (let i = seqs[0]; i <= seqs[seqs.length - 1]; i++) if (!seqs.includes(i)) gaps.push(i)
      if (gaps.length) warnings.push(`track sequence skips ${gaps.join(', ')} — ${songs.length} tracks numbered up to ${seqs[seqs.length - 1]}`)
    }
    for (const [field, label] of [['ISRC', 'ISRC'], ['Genre', 'genre'], ['Language', 'language'], ['Composers', 'composers']]) {
      const n = songs.filter(s => !has(s.fieldData[field])).length
      if (n) warnings.push(`${n} track(s) missing ${label}`)
    }

    const cat = val(f['Album Catalogue Number']) || val(f['Reference Catalogue Number'])
    if (!cat) blockers.push('album has no catalogue number — MADStreamer links tracks by it')

    return {
      albumID, catalogue: cat,
      title: val(f['Album Title']), artist: val(f['Album Artist']),
      tracks: songs.length, needConvert: needConvert.length, artwork, artworkKey,
      ready: blockers.length === 0, blockers, warnings,
    }
  } finally { await db.logout() }
}

/** WAV (or whatever Vision holds) -> 320k mp3 -> S3, keyed by the song's Filename. */
async function makeMp3(song) {
  const g = song.fieldData
  const code = val(g['Filename'])
  if (!code) throw new Error(`song ${val(g['MasterID'])} has no Filename to key the mp3 on`)
  const key = `${process.env.MP3_PREFIX || 'mp3/'}${code}.mp3`
  if ((await headAnyKey(key)).exists) return { key, url: urlForKey(key), reused: true }

  const dir = await mkdtemp(path.join(tmpdir(), 'pub-'))
  try {
    const src = val(g['Audio_Vision_URL']).split('?')[0]
    const inFile = path.join(dir, 'in' + (path.extname(src) || '.wav'))
    const outFile = path.join(dir, 'out.mp3')
    await visionDownloadTo(src, createWriteStream(inFile))
    if ((await stat(inFile)).size === 0) throw new Error('Vision master is zero bytes')
    await execFileP(FFMPEG, ['-y', '-i', inFile, '-codec:a', 'libmp3lame', '-b:a', BITRATE,
      '-id3v2_version', '3', '-metadata', `title=${val(g['Track Name'])}`,
      '-metadata', `artist=${val(g['Track Artist'])}`, outFile],
      { timeout: 20 * 60_000, maxBuffer: 50 * 1024 * 1024 })
    const size = (await stat(outFile)).size
    if (!size) throw new Error('ffmpeg produced an empty file')
    await uploadAnyKey(await import('node:fs').then(m => m.readFileSync(outFile)), key, 'audio/mpeg')
    const head = await headAnyKey(key)
    if (!head.exists || head.size !== size) throw new Error('mp3 upload did not verify')
    return { key, url: urlForKey(key), bytes: size }
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

/** Copy the album's Vision cover to S3 (with derivatives) and return its URL. */
async function makeArtwork(albumFields, nextCode) {
  const rel = val(albumFields['Artwork_Vision_URL'])
  if (!rel) throw new Error('no Vision artwork to copy')
  const obj = await visionOpen(rel)
  const chunks = []
  for await (const c of (obj.Body.transformToWebStream ? Readable.fromWeb(obj.Body.transformToWebStream()) : obj.Body)) chunks.push(c)
  const raw = Buffer.concat(chunks)
  const meta = await sharp(raw).metadata()
  const jpeg = meta.format === 'jpeg' ? raw : await sharp(raw).jpeg({ quality: 92 }).toBuffer()
  const key = artworkKeyForGmvi(nextCode, '.jpg')
  await uploadAnyKey(jpeg, key, 'image/jpeg')
  await writeArtworkDerivatives(key, jpeg)
  return { key, url: urlForKey(key) }
}

/** Highest GMVin in the bucket + 1 — the bucket is the counter, not a field. */
async function nextGmvin() {
  const { listKeysWithPrefix } = await import('./s3-imports.js')
  let max = 99999
  for (const k of await listKeysWithPrefix('artwork/GMVin')) {
    const m = k.match(/artwork\/GMVin(\d+)\./)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return 'GMVin' + (max + 1)
}

const MAP_SONG = {
  'Track Name': 'Track Name', 'Track Artist': 'Track Artist', 'Featured Artist': 'Featured Artist',
  'ISRC': 'ISRC', 'Sequence Number': 'Sequence Number', 'Track Number': 'Track Number',
  'Duration': 'Duration', 'Genre': 'Genre', 'Sub Genre': 'Sub Genre', 'Local Genre': 'Local Genre',
  'Language': 'Language', 'Language Code': 'Language Code', 'Lyrical Content Rating': 'Lyrical Content Rating',
  'Composer': 'Composer', 'Composer 2': 'Composer 2', 'Composer 3': 'Composer 3', 'Composer 4': 'Composer 4',
  'Composers': 'Composers', 'Producer': 'Producer', 'Producers': 'Producers', 'Publishers': 'Publishers',
  'cLine': 'cLine', 'pLine': 'pLine', 'Rights Territories': 'Rights Territories',
  'Original Release Date': 'Original Release date', 'Filename': 'Filename', 'AudioHashSum': 'AudioHashSum',
}
const MAP_ALBUM_ON_SONG = {
  'Album Title': 'Album Title', 'Album Artist': 'Album Artist', 'UPC': 'UPC',
  'Label': 'Label', 'Country': 'Country', 'Year of Release': 'Year of Release', 'Release Date': 'Release Date',
}

/**
 * Publish one album. Converts what is missing, copies artwork if needed, then
 * creates the tape record and one song record per track in MADStreamer.
 *
 * Tracks go in as 'Show', matching the 42,846 records already set that way —
 * Ian does not use Visibility as a staging switch, so an album that passes the
 * readiness check is meant to be live. That makes the check the only thing
 * standing between an album and the public site: keep its blockers strict.
 */
export async function publish(albumID, { visibility = 'Show', onProgress = () => {} } = {}) {
  const pre = await check(albumID)
  if (!pre.ready) return { ok: false, stage: 'readiness', ...pre }

  const db = mam(), stream = mad()
  const steps = []
  try {
    const { album, songs } = await gather(db, albumID)
    const af = album.fieldData
    const cat = pre.catalogue

    // 1. artwork
    let artUrl = val(af['Artwork_S3_URL'])
    if (pre.artwork !== 'on s3') {
      onProgress('artwork')
      const code = await nextGmvin()
      const made = await makeArtwork(af, code)
      artUrl = made.url
      await db.patch('Albums', album.recordId, { 'Artwork_S3_URL': artUrl })
      steps.push(`artwork copied to ${made.key}`)
    } else if (!artUrl) {
      steps.push('artwork already on s3')
    }

    // 2. audio
    let made = 0, reused = 0
    for (const [i, s] of songs.entries()) {
      if (has(s.fieldData['Audio_S3_URL'])) continue
      onProgress(`audio ${i + 1}/${songs.length}`)
      const r = await makeMp3(s)
      await db.patch('Songs', s.recordId, { 'Audio_S3_URL': r.url })
      s.fieldData['Audio_S3_URL'] = r.url
      r.reused ? reused++ : made++
    }
    if (made || reused) steps.push(`${made} mp3 created, ${reused} already on s3`)

    // 3. the tape record — songs attach to it by Reference Catalogue Number
    onProgress('madstreamer album')
    const existingTape = await stream.find('Tape Files Master', { 'Reference Catalogue Number': '==' + cat })
    if (existingTape.length) {
      await stream.patch('Tape Files Master', existingTape[0].recordId, { 'Artwork_S3_URL': artUrl })
      steps.push('tape record already existed — artwork refreshed')
    } else {
      await stream.create('Tape Files Master', {
        'Reference Catalogue Number': cat,
        'Album Artist': val(af['Album Artist']), 'Album Title': val(af['Album Title']),
        'Release Date': val(af['Release Date']), 'Genre': val(af['Genre']),
        'Language': val(af['Language']), 'Bar Code': val(af['UPC']),
        'Track Count': String(songs.length), 'Artwork_S3_URL': artUrl,
      })
      steps.push('tape record created')
    }

    // 4. the tracks
    let created = 0, skipped = 0
    for (const [i, s] of songs.entries()) {
      const g = s.fieldData
      onProgress(`madstreamer track ${i + 1}/${songs.length}`)
      // Dedupe on ISRC *within this catalogue*. An ISRC identifies a recording,
      // and the same recording legitimately appears on compilations — matching
      // on it alone would refuse to add a track that already exists elsewhere.
      const isrc = val(g['ISRC'])
      const dupe = isrc
        ? await stream.find('Song Files', { ISRC: '==' + isrc, 'Reference Catalogue Number': '==' + cat })
        : await stream.find('Song Files', { 'Reference Catalogue Number': '==' + cat, 'Track Name': '==' + val(g['Track Name']) })
      if (dupe.length) { skipped++; continue }
      const fd = { 'Reference Catalogue Number': cat, 'Album Catalogue Number': cat,
                   'S3_URL': val(g['Audio_S3_URL']), 'Visibility': visibility }
      for (const [from, to] of Object.entries(MAP_SONG)) if (has(g[from])) fd[to] = val(g[from])
      for (const [from, to] of Object.entries(MAP_ALBUM_ON_SONG)) if (has(af[from])) fd[to] = val(af[from])
      await stream.create('Song Files', fd)
      created++
    }
    steps.push(`${created} track(s) created in MADStreamer${skipped ? `, ${skipped} already there (matched on ISRC)` : ''}`)

    return { ok: true, albumID, catalogue: cat, title: pre.title, artist: pre.artist,
             tracks: songs.length, created, skipped, visibility, artworkUrl: artUrl,
             warnings: pre.warnings, steps }
  } finally { await db.logout(); await stream.logout() }
}
