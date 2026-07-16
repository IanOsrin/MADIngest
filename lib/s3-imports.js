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
  return { key, url: `${_baseUrl()}/${key}` }
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
 * Playlist cover art. Lives in the EXISTING artwork/ prefix (artwork/playlist-<slug>.<ext>)
 * so it inherits the MadStreamer thumbnail pipeline (which keys on /artwork/), same as
 * podcast covers. Stable key per playlist so re-uploading a cover overwrites the old one.
 */
export async function uploadPlaylistArt(buffer, playlistName, ext = '.jpg', contentType = 'image/jpeg') {
  const key = `artwork/playlist-${podcastSlug(playlistName)}${_normExt(ext)}`
  await new Upload({
    client: s3,
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    params: { Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }
  }).done()
  return { key, url: `${_baseUrl()}/${key}` }
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
