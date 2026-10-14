/**
 * lib/cover-template.js — a generated stand-in cover for albums that have no artwork (Ian, 2026-10-14: "where there is
 * no cover in MAM, using a template you create a cover and use fields for text").
 *
 * An archive-style record sleeve drawn as SVG and rendered with sharp: a sleeve colour picked from a period palette
 * (always the same one for the same catalogue number), a vinyl disc sliding out with the catalogue number on its
 * centre label, the artist in a condensed sans, the title in a serif, and label · catalogue · year along the foot.
 * Missing fields are left out rather than shown as "unknown".
 *
 *   renderCover({ title, artist, catalogue, year, label }, { size }) → Promise<Buffer>  (JPEG)
 */
import sharp from 'sharp'

const PALETTE = [            // [sleeve, ink, accent] — muted colours of 60s–80s South African sleeves
  ['#D9A441', '#1E1A16', '#8C2F1B'], ['#2F5D62', '#F3E9D2', '#E0A458'], ['#B5532A', '#F6EBDD', '#1F3B4D'],
  ['#3E5C3A', '#F1E4C3', '#D9A441'], ['#7A2E2E', '#F4E7D3', '#D9A441'], ['#22344F', '#F1E6D0', '#C8553D'],
  ['#C9B79C', '#1F2421', '#8C2F1B'], ['#5B6C5D', '#F3EEDC', '#D97B29'], ['#A33B20', '#F7EAD7', '#2E4A62'],
  ['#E3C567', '#1E1B18', '#2F5D62'], ['#4A3F6B', '#F2E9DA', '#E3A857'], ['#1F4E5A', '#F4E9D8', '#EA7A3B'],
]
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const isUnknown = (s) => !clean(s) || /^(unknown|n\/?a|none|various artists?\/unknown)$/i.test(clean(s))

/** Break text into at most `max` lines of about `per` characters, never splitting a word. */
function wrap(text, per, max) {
  const words = clean(text).split(' '), lines = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= per) cur += ' ' + w
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  if (lines.length > max) { const keep = lines.slice(0, max); keep[max - 1] = keep[max - 1].replace(/\s*\S*$/, '') + '…'; return keep }
  return lines
}
/** Wrap into at most `max` lines, widening the line length before giving up and truncating. */
function wrapFit(text, per, max) {
  for (let p = per; p <= per * 2; p += 2) { const l = wrap(text, p, max); if (!l[l.length - 1].endsWith('…')) return l }
  return wrap(text, per * 2, max)
}
/** Pick a font size so the longest line fits `width` px (≈ average glyph width × size). */
const fit = (lines, width, glyph, maxSize) => Math.min(maxSize, Math.floor(width / (glyph * Math.max(...lines.map((l) => l.length), 1))))

/** A catalogue number that is really "Artist_Title" text (a data fault) is not printed on the cover. */
export const isRealCatalogue = (c) => !!clean(c) && !clean(c).includes('_') && clean(c).length <= 24
export function coverFields(album) {
  const cat = isRealCatalogue(album.catalogue) ? clean(album.catalogue) : ''
  let title = clean(album.title)
  if (!title || /^unknown$/i.test(title)) title = ''
  if (/^singles?\b/i.test(title)) title = 'Singles'
  const artist = isUnknown(album.artist) ? '' : clean(album.artist)
  const year = /^\d{4}$/.test(clean(album.year)) ? clean(album.year) : (clean(album.year).match(/\b(19|20)\d{2}\b/) || [''])[0]
  const label = clean(album.label) || 'The Gallo Record Company Vault'
  return { cat, title: title || (artist ? 'Singles' : cat), artist, year, label }
}

export function coverSvg(album) {
  const { cat, title, artist, year, label } = coverFields(album)
  const [bg, ink, accent] = PALETTE[hash(cat || title) % PALETTE.length]
  const S = 3000, M = 210                                   // canvas, margin
  // text block (left two-thirds above the disc)
  const artistLines = artist ? wrapFit(artist.toUpperCase(), 18, 3) : []
  const titleLines = wrapFit(title, 16, 3)
  let aSize = artistLines.length ? fit(artistLines, S - 2 * M, 0.5, 230) : 0
  let tSize = fit(titleLines, S - 2 * M, 0.52, 300)
  // the text block must end above the disc (top of disc ≈ y 1300): shrink both sizes together if needed
  const LIMIT = 1230
  const height = (a, t) => M + 40 + artistLines.length * a * 1.12 + (artistLines.length ? 130 : 0) + titleLines.length * t * 1.08
  if (height(aSize, tSize) > LIMIT) { const k = (LIMIT - M - 40 - (artistLines.length ? 130 : 0)) / (height(aSize, tSize) - M - 40 - (artistLines.length ? 130 : 0)); aSize = Math.floor(aSize * k); tSize = Math.floor(tSize * k) }
  let y = M + 40
  const parts = []
  for (const l of artistLines) { y += aSize; parts.push(`<text x="${M}" y="${y}" font-family="Avenir Next Condensed" font-weight="700" font-size="${aSize}" letter-spacing="${aSize * 0.04}" fill="${ink}">${esc(l)}</text>`); y += aSize * 0.12 }
  if (artistLines.length) { y += 70; parts.push(`<rect x="${M}" y="${y}" width="420" height="22" fill="${accent}"/>`); y += 60 }
  for (const l of titleLines) { y += tSize * 0.98; parts.push(`<text x="${M}" y="${y}" font-family="Didot" font-style="italic" font-size="${tSize}" fill="${ink}">${esc(l)}</text>`); y += tSize * 0.1 }
  // disc: bottom-right, partly out of frame; grooves; centre label with the catalogue number
  const cx = 2200, cy = 2380, R = 1060, lr = 320
  const grooves = Array.from({ length: Math.floor((R - lr - 90) / 23) }, (_, i) => `<circle cx="${cx}" cy="${cy}" r="${lr + 40 + i * 23}" fill="none" stroke="#2a2a2a" stroke-width="${i % 5 ? 3 : 7}"/>`).join('')
  const catSize = Math.min(110, Math.floor(520 / (0.55 * Math.max(cat.length, 1))))
  const disc = `
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#111"/>${grooves}
    <path d="M ${cx - R * 0.72} ${cy - R * 0.69} A ${R} ${R} 0 0 1 ${cx + R * 0.2} ${cy - R * 0.98}" fill="none" stroke="#fff" stroke-opacity="0.10" stroke-width="90"/>
    <circle cx="${cx}" cy="${cy}" r="${lr}" fill="${accent}"/>
    <circle cx="${cx}" cy="${cy}" r="${lr - 34}" fill="none" stroke="${bg}" stroke-width="6" stroke-opacity="0.8"/>
    <text x="${cx}" y="${cy - 110}" text-anchor="middle" font-family="Avenir Next Condensed" font-weight="600" font-size="62" letter-spacing="12" fill="${bg}">GALLO</text>
    <text x="${cx}" y="${cy + 70 + catSize * 0.8}" text-anchor="middle" font-family="Avenir Next Condensed" font-weight="700" font-size="${catSize}" fill="${bg}">${esc(cat)}</text>
    <circle cx="${cx}" cy="${cy}" r="26" fill="${bg}"/>`
  // sleeve edge the disc slides out of + foot line
  const foot = [label, cat, year].filter(Boolean).join('   ·   ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${bg}"/>
  <g opacity="0.07">${Array.from({ length: 60 }, (_, i) => `<line x1="0" y1="${i * 50}" x2="${S}" y2="${i * 50 + 25}" stroke="${ink}" stroke-width="2"/>`).join('')}</g>
  <g>${disc}</g>
  <rect x="0" y="0" width="${S}" height="${S}" fill="none" stroke="${ink}" stroke-opacity="0.18" stroke-width="40"/>
  <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/>
  <text x="${M}" y="${S - 128}" font-family="Avenir Next Condensed" font-weight="600" font-size="${Math.min(78, Math.floor(2560 / (0.6 * Math.max(foot.length, 1))))}" letter-spacing="6" fill="${bg}">${esc(foot.toUpperCase())}</text>
  ${parts.join('\n  ')}
</svg>`
}

export async function renderCover(album, { size = 3000, quality = 90 } = {}) {
  const png = await sharp(Buffer.from(coverSvg(album))).png().toBuffer()
  return sharp(png).resize(size, size).jpeg({ quality, mozjpeg: true }).toBuffer()
}
