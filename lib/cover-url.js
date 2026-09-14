/**
 * lib/cover-url.js — what a legitimate album cover URL looks like.
 *
 * Deliberately dependency-free: the database write paths in fm-mam.js and
 * madstreamer.js import this to refuse bad covers at the point of writing, and
 * lib/album-cover.js (which imports both of those) uses it too. Keeping the rule
 * here is what lets every writer share ONE definition without a circular import.
 *
 * A pipeline cover is artwork/GMVi<n>.jpg, optionally stamped
 * (artwork/GMVi<n>-YYYYMMDD-HHmmss.jpg) for a replacement, or GMVin<n> for the
 * series publish-album allocates. JPEG only, root artwork/ folder only.
 * AudioImports/, .png, or an arbitrary filename all mean the cover went round
 * lib/album-cover.js — which is how seven raw PNGs reached MAM on 2026-09-14.
 */
const PIPELINE_COVER_RE = /^https:\/\/[^/]+\/artwork\/GMVin?\d+(-\d{8}-\d{6})?\.jpg$/i

export function isPipelineCoverUrl(url) {
  return PIPELINE_COVER_RE.test(String(url || '').trim())
}

/** Throws unless `url` is a pipeline cover. Blank is allowed — clearing a cover is legitimate. */
export function assertPipelineCoverUrl(url, where = 'Artwork_S3_URL') {
  if (url === '' || url == null) return
  if (!isPipelineCoverUrl(url)) {
    throw Object.assign(new Error(
      `${where} refused: "${url}" is not a pipeline cover. Covers must be ` +
      `artwork/GMVi<n>.jpg, set through setAlbumCover() in lib/album-cover.js — ` +
      `use the MAM tab or the Artwork tab, never a direct S3 upload.`), { status: 422 })
  }
}
