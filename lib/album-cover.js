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
export async function setAlbumCover(catalogue, image, { label = 'cover' } = {}) {
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

  // 4. Both databases. Each is reported rather than thrown: the file is already
  //    up and correct, and a partial result the caller can see is more useful
  //    than an exception that hides which side succeeded.
  const mam = { ok: false }
  try {
    const album = await findMamAlbumByCatalogue(cat)
    if (!album) mam.reason = `no MAM album for ${cat}`
    else {
      await updateMamAlbum(album.recordId, { Artwork_S3_URL: up.url })
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
    mam, madstreamer,
    source: { format: converted.format, width: converted.width, height: converted.height, bytes: image.length },
    jpegBytes: converted.jpeg.length,
  }
}
