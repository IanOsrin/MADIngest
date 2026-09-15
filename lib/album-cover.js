/**
 * lib/album-cover.js — THE way an album cover gets set. There is no other.
 *
 * On 2026-09-14 seven Duffy Ravenscroft covers were replaced through the MAM
 * tab and every one skipped the artwork pipeline: a raw 2–9 MB PNG went to
 * AudioImports/artwork/<Artist>_<Album>_<Cat>.png, MAM was pointed at it, and
 * MADStreamer — the website — never heard about it. The MAM tab's upload had
 * been written as "upload the file, write the URL", a shortcut past a pipeline
 * that already existed. This module is that pipeline, in one place, so every
 * entry point (MAM tab upload, cover from Vision, push to MAD, repair scripts)
 * takes the same route:
 *
 *   1. the album's GMVi ARTWORK RECORD — found, or created so FileMaker
 *      allocates the number. This code never invents a GMVi.
 *   2. JPEG. Whatever arrives (PNG, HEIC, WebP) becomes a JPEG master; the
 *      site's convention is artwork/GMVi<n>.jpg and a PNG master is what made
 *      FileMaker's cover field crawl.
 *   3. artwork/<GMVi>.jpg for a first cover, artwork/<GMVi>-<stamp>.jpg for a
 *      replacement (a fresh key, so no CDN or browser serves the old image),
 *      with the 300/800 WebP derivatives the site actually renders written in
 *      the same call — the cover is live on upload, not after the nightly cron.
 *   4. BOTH databases pointed at it: MAM's Albums.Artwork_S3_URL and
 *      MADStreamer's Tape Files Master.Artwork_S3_URL.
 *   5. The ORIGINAL image archived on Vision (Digital Sleeves/GalloIngest/
 *      <Artist>_<Album>_<CAT>.<ext>, never overwriting) and MAM's
 *      Albums.Artwork_Vision_URL pointed at it, so Vision — the archive — holds
 *      the same cover as the website rather than the one it replaced
 *      (Ian, 2026-09-15).
 *
 * The superseded master is never deleted: anything still holding the old URL
 * (a cached page, the mirror until 01:00) keeps rendering, and bucket
 * versioning keeps it recoverable regardless.
 */
import { listArtworkKeysForGmvi, headAnyKey, uploadArtworkByGmvi } from './s3-imports.js'
import { findArtworkByCatalogue, createArtworkRecord, setTapeFileArtworkUrl } from './madstreamer.js'
import { findMamAlbumByCatalogue, updateMamAlbum } from './fm-mam.js'
import { toJpeg } from './publish-album.js'
import { assertPipelineCoverUrl } from './cover-url.js'
import { visionStatus, visionStat, visionUploadFile } from './vision-drive.js'
import { writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Where covers set through GalloIngest are archived on Vision. Alongside the
// existing Digital Sleeves batches, named the way those are.
const VISION_COVER_FOLDER = () =>
  (process.env.VISION_COVER_FOLDER || '/gallo-music-files-wavs/Digital Sleeves/GalloIngest').replace(/\/+$/, '')

const EXT_FOR_FORMAT = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tif', gif: 'gif', heif: 'heic', avif: 'avif' }
const TYPE_FOR_EXT   = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', tif: 'image/tiff', gif: 'image/gif', heic: 'image/heic', avif: 'image/avif' }
const safeName = s => String(s || '').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()

/**
 * Put the original image on Vision without overwriting anything (Vision has no
 * trash). Returns { ok, path } or { ok: false, reason }.
 */
async function archiveOnVision(cat, image, converted, album) {
  if (!visionStatus().configured) return { ok: false, reason: 'Vision is not configured on this server' }
  // Keep the original bytes when sharp recognised them — Vision is the archive,
  // so it gets the full-quality source, not the website JPEG.
  const ext = EXT_FOR_FORMAT[converted.format] || 'jpg'
  const bytes = EXT_FOR_FORMAT[converted.format] ? image : converted.jpeg
  const af = album?.fieldData || {}
  const stem = safeName([af['Album Artist'], af['Album Title'], cat].filter(Boolean).join('_')) || safeName(cat)
  let rel = `${VISION_COVER_FOLDER()}/${stem}.${ext}`
  if (await visionStat(rel)) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
    rel = `${VISION_COVER_FOLDER()}/${stem} (${stamp}).${ext}`
    if (await visionStat(rel)) return { ok: false, reason: `${rel} already exists` }
  }
  const tmp = path.join(os.tmpdir(), `cover-${process.pid}-${Date.now()}.${ext}`)
  try {
    await writeFile(tmp, bytes)
    await visionUploadFile(rel, tmp, TYPE_FOR_EXT[ext] || 'application/octet-stream')
    return { ok: true, path: rel }
  } finally { await unlink(tmp).catch(() => {}) }
}

export { isPipelineCoverUrl, assertPipelineCoverUrl } from './cover-url.js'

/**
 * Set an album's cover. `image` is the raw bytes of anything sharp or ffmpeg
 * can read.
 *
 * @returns {{ catalogue, gmvi, createdArtworkRecord, key, url, replaced,
 *             derivatives, mam: {ok, recordId?, reason?},
 *             madstreamer: {ok, recordId?, previousUrl?, reason?},
 *             source: {format, width, height, bytes}, jpegBytes }}
 */
/**
 * @param {object} [opts]
 * @param {'upload'|false|{path: string}} [opts.vision]  'upload' (default) archives
 *   the original on Vision; {path} says the image already IS that Vision file
 *   (cover from Vision), so only MAM's link is set; false leaves Vision alone
 *   (re-pushing MAM's existing cover).
 */
export async function setAlbumCover(catalogue, image, { label = 'cover', vision = 'upload' } = {}) {
  const cat = String(catalogue || '').trim()
  if (!cat) throw Object.assign(new Error('catalogue required'), { status: 400 })
  if (!image?.length) throw Object.assign(new Error('image is empty'), { status: 400 })

  // 1. The GMVi record owns the number. Find it; create it only if absent, and
  //    let FileMaker allocate — never a number made up here.
  let art = await findArtworkByCatalogue(cat)
  let createdArtworkRecord = false
  if (!art) {
    art = await createArtworkRecord(cat)
    createdArtworkRecord = true
  }
  if (!art?.gmvi) {
    throw Object.assign(new Error(
      `Artwork record for ${cat} has no GMVi — FileMaker did not allocate one, so the cover cannot be named`),
      { status: 502 })
  }

  // 2. JPEG master, always.
  const converted = await toJpeg(image, label)

  // 3. First cover → artwork/<GMVi>.jpg; replacement → stamped key.
  let replaced = false
  for (const key of await listArtworkKeysForGmvi(art.gmvi)) {
    if ((await headAnyKey(key)).exists) { replaced = true; break }
  }
  const up = await uploadArtworkByGmvi(converted.jpeg, art.gmvi, '.jpg', 'image/jpeg', { stamped: replaced })
  assertPipelineCoverUrl(up.url, 'pipeline self-check')   // if this ever fires, the pipeline itself broke

  // 4 + 5. Vision, then both databases. Each is reported rather than thrown:
  //    the S3 file is already up and correct, and a partial result the caller
  //    can see is more useful than an exception that hides which side succeeded.
  const mam = { ok: false }
  let visionResult = { ok: false, skipped: true }
  try {
    const album = await findMamAlbumByCatalogue(cat)
    if (vision === 'upload') {
      try { visionResult = await archiveOnVision(cat, image, converted, album) }
      catch (err) { visionResult = { ok: false, reason: err.message } }
    } else if (vision && vision.path) {
      visionResult = { ok: true, path: vision.path, existing: true }
    }
    if (!album) mam.reason = `no MAM album for ${cat}`
    else {
      const fields = { Artwork_S3_URL: up.url }
      if (visionResult.ok && visionResult.path) fields.Artwork_Vision_URL = visionResult.path
      await updateMamAlbum(album.recordId, fields)
      Object.assign(mam, { ok: true, recordId: album.recordId })
    }
  } catch (err) { mam.reason = err.message }

  let madstreamer
  try {
    madstreamer = await setTapeFileArtworkUrl(cat, up.url)
    // An album not yet on the site has no Tape Files record — normal, not a fault.
  } catch (err) { madstreamer = { ok: false, reason: err.message } }

  return {
    catalogue: cat, gmvi: art.gmvi, createdArtworkRecord,
    key: up.key, url: up.url, replaced, derivatives: up.derivatives,
    mam, madstreamer, vision: visionResult,
    source: { format: converted.format, width: converted.width, height: converted.height, bytes: image.length },
    jpegBytes: converted.jpeg.length,
  }
}
