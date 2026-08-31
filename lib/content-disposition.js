/**
 * lib/content-disposition.js — build a Content-Disposition header that survives
 * real Gallo filenames.
 *
 * Node refuses to send a header value containing anything outside Latin-1, so a
 * filename like "JGMVAULT028445 – Dan Chauke.wav" (en-dash, U+2013) throws
 * "Invalid character in header content" and the download fails outright. The
 * archive is full of en-dashes, curly quotes and accented artist names, so
 * stripping control characters alone was never enough.
 *
 * RFC 6266 answers this with two parameters: a plain ASCII `filename` that old
 * clients understand, and a percent-encoded UTF-8 `filename*` that every current
 * browser prefers. So the user still gets the real name, dashes and all.
 */

// Latin-1 look-alikes for the punctuation that actually shows up in these
// names, so the ASCII fallback stays readable rather than turning into gaps.
const FOLD = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', ' ': ' ' }

/** ASCII-only, quote-safe version of a filename — the fallback parameter. */
function asciiFallback(name) {
  return String(name)
    .replace(/[–—‘’“”… ]/g, c => FOLD[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // café → cafe
    .replace(/[^\x20-\x7e]/g, '_')                       // anything left over
    .replace(/[\\"]/g, '_')                              // would close the quoted string
    .trim() || 'download'
}

/**
 * @param {string} name     the filename to offer
 * @param {object} [opts]
 * @param {boolean} [opts.inline]  true for `inline` (play in place) instead of `attachment`
 * @returns {string} a complete Content-Disposition header value
 */
export function contentDisposition(name, { inline = false } = {}) {
  const clean = String(name || 'download').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[/\\]/g, '_').trim() || 'download'
  const type = inline ? 'inline' : 'attachment'
  // encodeURIComponent leaves ! ' ( ) *, which RFC 5987 does not allow bare
  const star = encodeURIComponent(clean).replace(/['()!*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `${type}; filename="${asciiFallback(clean)}"; filename*=UTF-8''${star}`
}

export default contentDisposition
