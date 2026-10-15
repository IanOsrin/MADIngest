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

/**
 * Where to FETCH a cover from (not what to store). 2026-10-15: from the office, some Amazon Stockholm servers crawled at
 * ~5 KB/s (3.5.216.115 stalled, 52.95.170.49 fine — which one DNS hands out varies), so MAM tab covers never appeared
 * locally while Render was fine. The media edge (Cloudflare, MAD's artwork host) was fast, so covers are fetched there
 * first and from S3's path-style address second. Stored URLs are unchanged.
 */
const MEDIA_EDGE = () => (process.env.MEDIA_EDGE_HOST || 'media.musicafricadirect.com').replace(/^https?:\/\//, '').replace(/\/+$/, '')
export function coverFetchUrls(url) {
  const u = String(url || '').trim()
  const m = u.match(/^https:\/\/([a-z0-9.-]+)\.s3\.([a-z0-9-]+)\.amazonaws\.com\/(.+)$/i)
  if (!m) return [u]
  const out = []
  if (/^artwork\//i.test(m[3])) out.push(`https://${MEDIA_EDGE()}/${m[3]}`)
  out.push(`https://s3.${m[2]}.amazonaws.com/${m[1]}/${m[3]}`, u)
  return out
}

/** Fetch a cover's bytes, trying each address in turn with a time limit. Returns { buffer, contentType }. */
export async function fetchCover(url, timeoutMs = 15000) {
  let last
  for (const u of coverFetchUrls(url)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) { last = new Error(`HTTP ${r.status}`); continue }
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'image/jpeg' }
    } catch (err) { last = err }
  }
  throw new Error(`artwork fetch failed: ${last?.message || 'no address worked'}`)
}
