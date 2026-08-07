/**
 * lib/s3-imports.js
 * S3 operations for the AudioImports bucket/prefix.
 * Uses env: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *           S3_IMPORTS_BUCKET, S3_IMPORTS_PREFIX, S3_IMPORTS_BASE_URL
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import path from 'path'
import sharp from 'sharp'

function safePart(s) {
  return (s || 'Unknown')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '_')
}

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
})

const BUCKET  = process.env.S3_IMPORTS_BUCKET  || 'mass-music-audio-files'
const PREFIX  = process.env.S3_IMPORTS_PREFIX  || 'AudioImports/'
const BASE    = (process.env.S3_IMPORTS_BASE_URL || '').replace(/\/$/, '')

function audioKey(originalName, meta) {
  const ext  = path.extname(originalName).toLowerCase() || ''
  const name = [safePart(meta.artist), safePart(meta.album), safePart(meta.title)]
    .filter(p => p && p !== 'Unknown').join('_')
  return `${PREFIX}${name}${ext}`
}

function artworkKey(originalName, meta) {
  const ext  = path.extname(originalName).toLowerCase() || '.jpg'
  const name = [safePart(meta.artist), safePart(meta.album), safePart(meta.catalogue_no)]
    .filter(p => p && p !== 'Unknown').join('_')
  return `${PREFIX}artwork/${name}${ext}`
}

/**
 * Generate a presigned PUT URL so the browser can upload directly to S3.
 * meta: { artist, album, title }
 */
export async function presignImport(originalName, contentType, meta = {}) {
  const key = audioKey(originalName, meta)
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || 'audio/wav' })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  return { key, url: `${BASE}/${key}`, uploadUrl }
}

/**
 * Generate a presigned PUT URL for artwork.
 * meta: { artist, album, catalogue_no }
 */
export async function presignArtworkImport(originalName, contentType, meta = {}) {
  const key = artworkKey(originalName, meta)
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || 'image/jpeg' })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  return { key, url: `${BASE}/${key}`, uploadUrl }
}

/**
 * Server-side buffer upload (fallback / admin use).
 * meta: { artist, album, title }
 */
export async function uploadImport(buffer, originalName, contentType, meta = {}) {
  const key = audioKey(originalName, meta)

  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream' }
  }).done()

  return { key, url: `${BASE}/${key}` }
}

export async function uploadArtworkImport(buffer, originalName, meta = {}) {
  const key = artworkKey(originalName, meta)

  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'image/jpeg' }
  }).done()

  return { key, url: `${BASE}/${key}` }
}

/**
 * List all objects currently in AudioImports/.
 */
export async function listImports() {
  const items = []
  let token

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket:            BUCKET,
      Prefix:            PREFIX,
      ContinuationToken: token
    }))
    for (const obj of res.Contents || []) {
      if (obj.Key === PREFIX) continue
      items.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified })
    }
    token = res.NextContinuationToken
  } while (token)

  return items
}

export async function downloadImport(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export async function deleteImport(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Asset-keyed paths — used by the "Push to MadStreamer" admin action.
//
//  Audio files are named by GCAT (e.g. mp3/GCAT00001.mp3 — the audio asset
//  number from Gallo's Filename.wav). Artwork is named by GMVi (e.g.
//  artwork/GMVF14433.jpg — looked up from MadStreamer's Artwork layout).
//  GCAT and GMVi are intentionally separate identifiers.
//
//  All three live at the bucket root (mp3/, artwork/, wav/) so files match
//  the path the existing MASS S3 File Checker probes.
// ─────────────────────────────────────────────────────────────────────────────

const _baseUrl = () => BASE || `https://${BUCKET}.s3.${process.env.AWS_REGION || 'eu-north-1'}.amazonaws.com`

function _normExt(ext) {
  if (!ext) return ''
  return ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()
}

export function mp3KeyForGcat(gcat)                 { return `mp3/${gcat}.mp3` }
export function wavKeyForGcat(gcat)                 { return `wav/${gcat}.wav` }
export function artworkKeyForGmvi(gmvi, ext='.jpg') { return `artwork/${gmvi}${_normExt(ext)}` }

// UTC YYYYMMDD-HHmmss, for artwork keys that must never be reused. Seconds
// granularity because two uploads of the same cover in one day is routine
// (wrong crop, wrong image) and a day-level stamp would collide.
function _artStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '').replace(/^(\d{8})(\d{6})$/, '$1-$2')
}

export async function uploadMp3ByGcat(buffer, gcat) {
  const key = mp3KeyForGcat(gcat)
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'audio/mpeg' }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
}

export async function uploadWavByGcat(buffer, gcat) {
  const key = wavKeyForGcat(gcat)
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'audio/wav' }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
}

export async function uploadArtworkByGmvi(buffer, gmvi, ext = '.jpg', contentType = 'image/jpeg') {
  const key = artworkKeyForGmvi(gmvi, ext)
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }
  }).done()
  // The app never serves this master — it rewrites the URL to
  // artwork/resized/<name>_300.webp. Uploading without the derivatives meant
  // every same-day album showed no cover until the 05:00 cron, and worse: the
  // CDN caches the 403 from the missing object, so the cover stays broken even
  // after the derivative exists (Babes Wodumo, 2026-08-06 — proven by _800,
  // never requested while absent, serving fine while _300 stayed 403).
  // Generating them here is what keeps a missing-object 403 from ever happening.
  const derivatives = await writeArtworkDerivatives(key, buffer)
  return { key, url: `${_baseUrl()}/${key}`, derivatives }
}

/** Public URL for any key in the configured bucket. */
export function urlForKey(key) {
  return `${_baseUrl()}/${key}`
}

/** Upload a buffer to any key in the configured bucket. */
export async function uploadAnyKey(buffer, key, contentType = 'application/octet-stream') {
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
}

/** HEAD an object — { exists, size?, lastModified?, contentType? }. */
export async function headAnyKey(key) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return { exists: true, size: res.ContentLength, lastModified: res.LastModified, contentType: res.ContentType }
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return { exists: false }
    throw err
  }
}

/** Delete any object in the configured bucket (bucket versioning keeps a copy). */
export async function deleteAnyKey(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

/**
 * Download any object from the configured bucket. Returns buffer + content
 * type so callers can re-upload under a new key with correct headers.
 */
export async function downloadAnyKey(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return {
    buffer:        Buffer.concat(chunks),
    contentType:   res.ContentType,
    contentLength: res.ContentLength,
  }
}

/**
 * Convert an absolute S3 URL into the bucket key (if it points at this bucket).
 * Returns null if the URL is for a different host or unparseable.
 */
export function keyFromS3Url(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    // virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
    if (u.hostname.startsWith(`${BUCKET}.`)) return decodeURIComponent(u.pathname.replace(/^\//, ''))
    // path-style: s3.<region>.amazonaws.com/<bucket>/<key>
    const segs = u.pathname.replace(/^\//, '').split('/')
    if (segs[0] === BUCKET) return decodeURIComponent(segs.slice(1).join('/'))
  } catch (_) {}
  return null
}

/**
 * Fetch an arbitrary URL into a Buffer. Used as a fallback when the WAV
 * pointer in the Gallo record is not for our bucket (e.g. a moviemac:
 * container reference that's been resolved to a public URL elsewhere).
 */
export async function downloadByUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`)
  const arr = await res.arrayBuffer()
  return {
    buffer:      Buffer.from(arr),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Podcast assets (added 2026-06-11)
//
//  Audio lives under its own prefix: podcasts/audio/<show-slug>/<file>.mp3
//  Covers live in the EXISTING artwork/ prefix (artwork/podcast-<slug>.jpg) so
//  they inherit the MadStreamer thumbnail pipeline (which keys on /artwork/).
// ─────────────────────────────────────────────────────────────────────────────

export function podcastSlug(s) {
  return (s || 'show')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'show'
}

export async function uploadPodcastAudio(buffer, showTitle, episodeNumber, episodeTitle) {
  const ep  = episodeNumber ? String(episodeNumber).padStart(3, '0') : 'ep'
  const key = `podcasts/audio/${podcastSlug(showTitle)}/${ep}-${podcastSlug(episodeTitle)}.mp3`
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'audio/mpeg' }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
}

/**
 * Playlist cover art. Lives in the EXISTING artwork/ prefix so it inherits the
 * MadStreamer thumbnail pipeline (which keys on /artwork/), same as podcast covers.
 *
 * The key carries a timestamp — artwork/playlist-<slug>-<YYYYMMDD-HHmmss>.<ext> —
 * so every upload lands on a path nothing has ever requested. Stable keys were a
 * trap: the app asks for the _300.webp derivative the instant a cover is saved in
 * FileMaker, but that derivative doesn't exist until the nightly resizer runs, and
 * Cloudflare CACHES THE 403 AND NEVER RE-CHECKS. One page view inside that window
 * poisons the path permanently, and re-uploading to the same key does not clear it
 * (verified 2026-08-02: an object probed while missing stayed 403 after being
 * created; an identical object never probed served 200). It also fixes the milder
 * problem that replacing a cover left the old one showing until the CDN TTL expired.
 *
 * The cost is that superseded masters and their derivatives stay in the bucket.
 * They are a few hundred KB each and nothing points at them — far cheaper than a
 * cover that can never be displayed again.
 */
export async function uploadPlaylistArt(buffer, playlistName, ext = '.jpg', contentType = 'image/jpeg') {
  const key = `artwork/playlist-${podcastSlug(playlistName)}-${_artStamp()}${_normExt(ext)}`
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }
  }).done()
  // Derivatives BEFORE the caller writes the URL to FileMaker, and a failure
  // here FAILS THE UPLOAD. Swallowing it would publish a URL whose derivative
  // doesn't exist — which is precisely the bug this whole arrangement exists to
  // prevent, and the resulting 403 is cached permanently. Failing loudly costs
  // the operator one retry, and the retry gets a fresh timestamped key, so the
  // half-finished attempt poisons nothing.
  try {
    await writeArtworkDerivatives(key, buffer)
  } catch (e) {
    throw new Error(`Cover uploaded but could not be resized (${e.message}). Nothing was published — try again, or check the image is a valid JPEG/PNG/WebP.`)
  }
  return { key, url: `${_baseUrl()}/${key}` }
}

// MadStreamer serves artwork/resized/<name>_<size>.webp, never the master, so a
// cover with no derivative is a blank card. The nightly resizer cron would make
// them eventually, but "eventually" is the whole problem: the app requests the
// derivative the moment the cover is saved in FileMaker, and Cloudflare caches
// the 403 from the missing object and never re-checks. Generating them here, in
// the same request that uploads the master, means the URL is never published
// before the object behind it exists.
//
// Settings are deliberately identical to scripts/artwork-resize/resize-artwork.mjs
// in the madmusic repo (300 + 800, fit inside, no enlargement, WebP q80, and the
// same Cache-Control). If that script changes, change this to match — otherwise a
// later cron run would silently replace these with different-looking files.
const ART_SIZES         = [300, 800]
const ART_QUALITY       = 80
const ART_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400'

export async function writeArtworkDerivatives(masterKey, buffer) {
  const base = masterKey.replace(/^artwork\//, '').replace(/\.[^.]+$/, '')
  const written = []
  for (const size of ART_SIZES) {
    const out = await sharp(buffer)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: ART_QUALITY })
      .toBuffer()
    const key = `artwork/resized/${base}_${size}.webp`
    await new Upload({
      client: s3,
      params: {
        Bucket:       BUCKET,
        Key:          key,
        Body:         out,
        ContentType:  'image/webp',
        CacheControl: ART_CACHE_CONTROL
      }
    }).done()
    written.push(key)
  }
  return written
}

export async function uploadPodcastArtwork(buffer, showTitle, episodeNumber, ext = '.jpg', contentType = 'image/jpeg') {
  // Unique key per episode — episode number when supplied, timestamp otherwise —
  // so a new episode's cover never overwrites a previous episode's artwork.
  const ep  = episodeNumber ? String(episodeNumber).padStart(3, '0') : String(Date.now())
  const key = `artwork/podcast-${podcastSlug(showTitle)}-ep${ep}${_normExt(ext)}`
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
}

/**
 * Presigned GET for an existing audio object (Download Track tab) — the
 * browser downloads DIRECTLY from S3 (no server bandwidth) and the
 * response-content-disposition override gives it a clean download filename.
 * Bucket + key are parsed from the record's own S3 URL.
 */
export async function presignAudioDownload(s3url, filename) {
  const u = new URL(s3url)
  const bucket = u.hostname.split('.')[0]
  const key = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${String(filename).replace(/"/g, '')}"`,
  })
  return getSignedUrl(s3, cmd, { expiresIn: 600 })
}

// ── Editorial hero banners ───────────────────────────────────────────────────
// Masters live under editorial/ (docs/banners.md). The key is timestamped and
// never reused: the CDN caches a 403 for a key that did not exist when it was
// first requested, and nothing bustable clears it — re-uploading over the same
// name would leave the old broken entry serving. A new name is a new cache
// entry with no history.
//
// Served through media.musicafricadirect.com, not the S3 host: the app stores
// and renders this URL verbatim (no rewrite anywhere), and the hero is the
// largest image on the page, so it should come off the edge.
const HERO_CDN_BASE = (process.env.HERO_CDN_BASE || 'https://media.musicafricadirect.com').replace(/\/$/, '')
const HERO_RATIO    = 7500 / 1750       // 4.286 — what the designed masters are
const HERO_RATIO_TOLERANCE = 0.08       // ±8%, so 1600×380 or 2400×570 pass

export function heroSlug(name) {
  return String(name || 'banner')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'banner'
}

/**
 * Check a banner before it is uploaded. Returns { ok, ratio, width, height,
 * warnings[] } — a wrong-shaped image is rejected here rather than being
 * discovered as a cropped headline on the live site.
 */
export async function inspectHeroImage(buffer) {
  const m = await sharp(buffer).metadata()
  const ratio = m.width / m.height
  const off   = Math.abs(ratio - HERO_RATIO) / HERO_RATIO
  const warnings = []
  if (m.width < 1600) warnings.push(`${m.width}px wide — under 1600 will look soft on a large screen`)
  if (buffer.length > 500 * 1024) warnings.push(`${Math.round(buffer.length / 1024)}KB — over the 500KB guide`)
  return {
    ok: off <= HERO_RATIO_TOLERANCE,
    width: m.width, height: m.height, format: m.format,
    ratio: Number(ratio.toFixed(3)), expected: Number(HERO_RATIO.toFixed(3)),
    bytes: buffer.length,
    reason: off <= HERO_RATIO_TOLERANCE ? null
      : `${m.width}×${m.height} is ${ratio.toFixed(2)}:1 — the hero is ${HERO_RATIO.toFixed(2)}:1 (e.g. 2000×475). `
        + `At this shape the sides would be cropped, taking any type near the edges with them.`,
    warnings,
  }
}

export async function uploadHeroBanner(buffer, originalName, contentType = 'image/jpeg') {
  const ext   = (originalName || '').toLowerCase().endsWith('.png') ? '.png' : '.jpg'
  const key   = `editorial/${heroSlug(originalName)}-${_artStamp()}${ext}`
  await new Upload({
    client: s3,
    params: {
      Bucket: BUCKET, Key: key, Body: buffer,
      ContentType: contentType,
      CacheControl: ART_CACHE_CONTROL,
    }
  }).done()
  return { key, url: `${HERO_CDN_BASE}/${key}`, s3Url: `${_baseUrl()}/${key}` }
}
