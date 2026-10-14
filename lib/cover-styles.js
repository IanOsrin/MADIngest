/**
 * lib/cover-styles.js — five genre-led designs for generated stand-in covers (Ian, 2026-10-14: "give me 5 alternative
 * designs use the genre as a style guide"). Same inputs as lib/cover-template.js (title, artist, catalogue, year,
 * label + genre); albums whose genre fits no family keep the vinyl design from cover-template.js.
 *
 *   styleFor(genre) → 'township' | 'heritage' | 'jazz' | 'gospel' | 'vintage' | null
 *   renderStyled(album, { style?, size? }) → Promise<Buffer>  (JPEG)
 */
import sharp from 'sharp'
import { coverFields, coverSvg } from './cover-template.js'

const S = 3000
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }
function wrap(text, per, max) {
  const words = String(text).split(' '), lines = []; let cur = ''
  for (const w of words) { if (!cur) cur = w; else if ((cur + ' ' + w).length <= per) cur += ' ' + w; else { lines.push(cur); cur = w } }
  if (cur) lines.push(cur)
  if (lines.length > max) { const k = lines.slice(0, max); k[max - 1] = k[max - 1].replace(/\s*\S*$/, '') + '…'; return k }
  return lines
}
function wrapFit(text, per, max) { for (let p = per; p <= per * 2; p += 2) { const l = wrap(text, p, max); if (!l[l.length - 1].endsWith('…')) return l } return wrap(text, per * 2, max) }
const fit = (lines, width, glyph, maxSize) => Math.min(maxSize, Math.floor(width / (glyph * Math.max(...lines.map((l) => l.length), 1))))
/** Lines of text from (x, y) downwards; returns the y below the block. */
function lines(ls, { x, y, size, lead = 1.05, font, weight = 400, italic = false, fill, anchor = 'start', spacing = 0 }) {
  const out = []
  for (const l of ls) { y += size * lead; out.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''} font-size="${size}" letter-spacing="${spacing}" fill="${fill}">${esc(l)}</text>`) }
  return { svg: out.join(''), y }
}
const foot = (f) => [f.label, f.cat, f.year].filter(Boolean).join('   ·   ').toUpperCase()

const FAMILIES = [
  ['township', /afro ?-?pop|afro ?soul|afro ?-?fusion|afro ?beat|funk|disco|soul|^pop|pop rock|70|80|bubblegum|kwaito|mbaqanga|reggae|rock/i],
  ['heritage', /afro ?-?folk|traditional|^african$|world|maskandi|isicathamiya|neo.?trad/i],
  ['jazz', /jazz|kwela|marabi/i],
  ['gospel', /gospel|choral|classical|religious|sacred|hymn|vocal/i],
  ['vintage', /volksmusi|afrikaans|boeremusiek|country|folk|easy listening|oldies|50|60|children|instrumental|langarm/i],
]
export function styleFor(genre) { const g = String(genre || ''); for (const [k, re] of FAMILIES) if (re.test(g)) return k; return null }

// 1 ── TOWNSHIP: bright flat colours, thick black-outlined geometric blocks (Afro Pop, Soul, Funk, 70s/80s)
function township(f) {
  const sets = [['#F2C14E', '#D7263D', '#1B998B', '#2E4057', '#F4F1DE'], ['#EF476F', '#FFD166', '#06D6A0', '#118AB2', '#FAF3E0'], ['#F18F01', '#C73E1D', '#3B1F2B', '#6A994E', '#F6F0E3'], ['#00A6A6', '#F49D37', '#D72638', '#140F2D', '#F7F3E8']]
  const c = sets[hash(f.cat || f.title) % sets.length], ink = '#141414'
  const cells = [], n = 5, w = S / n, top = 1450, h = (S - 300 - top) / 2
  for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) {
    const x = i * w, y = top + r * h, k = hash(f.cat + r + i), col = c[k % 4]
    const shape = k % 3 === 0 ? `<polygon points="${x},${y + h} ${x + w / 2},${y} ${x + w},${y + h}" fill="${c[(k + 1) % 4]}" stroke="${ink}" stroke-width="28"/>`
      : k % 3 === 1 ? `<rect x="${x + w * 0.22}" y="${y + h * 0.22}" width="${w * 0.56}" height="${h * 0.56}" fill="${c[(k + 2) % 4]}" stroke="${ink}" stroke-width="28"/>`
      : `<polyline points="${x + 40},${y + h * 0.75} ${x + w * 0.3},${y + h * 0.3} ${x + w * 0.55},${y + h * 0.7} ${x + w - 40},${y + h * 0.25}" fill="none" stroke="${c[4]}" stroke-width="60"/>`
    cells.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${col}" stroke="${ink}" stroke-width="36"/>${shape}`)
  }
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 16, 3) : [], t = wrapFit(f.title, 18, 3)
  let aS = a.length ? fit(a, 2560, 0.5, 250) : 0, tS = fit(t, 2560, 0.56, 230)
  const used = a.length * aS * 1.05 + t.length * tS * 1.1 + 120; if (used > 1150) { const k = 1150 / used; aS *= k; tS *= k }
  const A = lines(a, { x: 220, y: 180, size: aS, font: 'Futura', weight: 700, fill: ink, spacing: aS * 0.02 })
  const T = lines(t, { x: 220, y: A.y + (a.length ? 70 : 0), size: tS, font: 'Futura', weight: 500, fill: c[4] === '#F4F1DE' ? '#2E4057' : '#3B1F2B' })
  return `<rect width="${S}" height="${S}" fill="${c[4]}"/><rect x="0" y="0" width="${S}" height="${top}" fill="${c[4]}"/>${cells.join('')}
    <rect x="140" y="${A.y - (a.length ? aS * 1.05 * a.length : 0) - 60}" width="70" height="${(a.length ? aS * 1.05 * a.length : 0) + 60 + (T.y - A.y)}" fill="${c[1]}"/>${A.svg}${T.svg}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="220" y="${S - 125}" font-family="Futura" font-weight="700" font-size="76" letter-spacing="6" fill="${c[0]}">${esc(foot(f))}</text>`
}

// 2 ── HERITAGE: earth tones, beadwork band of triangles (Afro-Folk, Traditional, World)
function heritage(f) {
  const sets = [['#B5562B', '#F3E3C3', '#1D1A17', '#E2B13C', '#3C6E71', '#F2C14E'], ['#6B3A2A', '#F1E0C5', '#141210', '#D98E04', '#8EA604', '#F2B134'], ['#8C5E34', '#F5E6CC', '#1B1B1B', '#C0392B', '#2C7DA0', '#F6D58E'], ['#3E5641', '#F2E8CF', '#1A1A1A', '#D96C06', '#A23E48', '#F4B860']]
  const [bg, cream, ink, b1, b2, artistInk] = sets[hash(f.cat || f.title) % sets.length]
  const band = [], bh = 300, y0 = 1650, tw = 150
  for (let row = 0; row < 2; row++) for (let i = 0; i < S / tw + 1; i++) {
    const x = i * tw, y = y0 + row * bh, up = (i + row) % 2 === 0, col = [b1, cream, b2, ink][(i + row * 2) % 4]
    band.push(`<polygon points="${up ? `${x},${y + bh} ${x + tw / 2},${y} ${x + tw},${y + bh}` : `${x},${y} ${x + tw / 2},${y + bh} ${x + tw},${y}`}" fill="${col}"/>`)
  }
  const dots = Array.from({ length: 40 }, (_, i) => `<circle cx="${75 + i * 75}" cy="${y0 - 70}" r="18" fill="${i % 2 ? b1 : cream}"/><circle cx="${75 + i * 75}" cy="${y0 + 2 * bh + 70}" r="18" fill="${i % 2 ? cream : b2}"/>`).join('')
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 20, 2) : [], t = wrapFit(f.title, 18, 3)
  let aS = a.length ? fit(a, 2500, 0.62, 150) : 0, tS = fit(t, 2500, 0.55, 250)
  const used = a.length * aS * 1.15 + t.length * tS * 1.1 + 100; if (used > 1250) { const k = 1250 / used; aS *= k; tS *= k }
  const T = lines(t, { x: S / 2, y: 230, size: tS, font: 'Rockwell', weight: 700, fill: cream, anchor: 'middle' })
  const A = lines(a, { x: S / 2, y: T.y + 90, size: aS, font: 'Copperplate', weight: 400, fill: artistInk, anchor: 'middle', spacing: aS * 0.1 })
  return `<rect width="${S}" height="${S}" fill="${bg}"/>${band.join('')}${dots}${T.svg}${A.svg}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Copperplate" font-size="74" letter-spacing="8" fill="${cream}">${esc(foot(f))}</text>`
}

// 3 ── JAZZ: dark field, huge condensed type, tinted colour blocks and thin rules (classic jazz label sleeves)
function jazz(f) {
  const tints = ['#2B7DE9', '#E9A23B', '#D64545', '#3BB273', '#9B5DE5', '#00B4D8']
  const tint = tints[hash(f.cat || f.title) % tints.length], dark = '#111214', paper = '#F2EEE6'
  const name = (f.artist || f.title).toUpperCase()
  const a = wrapFit(name, 11, 4)
  let aS = fit(a, 2560, 0.42, 520); if (a.length * aS * 0.92 > 1500) aS = Math.floor(1500 / (a.length * 0.92))
  const A = lines(a, { x: 220, y: 160, size: aS, lead: 0.92, font: 'DIN Condensed', weight: 700, fill: paper })
  const t = f.artist ? wrapFit(f.title.toUpperCase(), 24, 3) : []
  const tS = t.length ? Math.min(150, fit(t, 1700, 0.5, 150)) : 0
  const T = lines(t, { x: 220, y: Math.max(A.y + 140, 1900), size: tS, font: 'Avenir Next Condensed', weight: 600, fill: tint, spacing: tS * 0.08 })
  return `<rect width="${S}" height="${S}" fill="${dark}"/>
    <rect x="${S - 760}" y="${S - 1260}" width="540" height="960" fill="${tint}"/><rect x="${S - 1080}" y="${S - 820}" width="300" height="520" fill="${paper}"/>
    <rect x="220" y="${A.y + 60}" width="${S - 440}" height="10" fill="${tint}"/>${A.svg}${T.svg}
    <text x="220" y="${S - 130}" font-family="Avenir Next Condensed" font-weight="600" font-size="72" letter-spacing="10" fill="${paper}" fill-opacity="0.8">${esc(foot(f))}</text>`
}

// 4 ── GOSPEL: dawn gradient, rays from the horizon, an arched window, serif type (Gospel, Choral, Classical)
function gospel(f) {
  const skies = [['#1B2A49', '#E8A54B', '#F7E7C6'], ['#2D1E4A', '#E57A44', '#F8E5C9'], ['#0F3D3E', '#E9C46A', '#F6EED9'], ['#3A1C32', '#F2A65A', '#F9E8D2']]
  const [top, glow, cream] = skies[hash(f.cat || f.title) % skies.length]
  const rays = Array.from({ length: 18 }, (_, i) => { const a = Math.PI * (i / 17); const x = S / 2 + Math.cos(a) * 2600, y = 2350 - Math.sin(a) * 2600; return `<polygon points="${S / 2},2350 ${x - 60},${y} ${x + 60},${y}" fill="${cream}" fill-opacity="${i % 2 ? 0.05 : 0.1}"/>` }).join('')
  const t = wrapFit(f.title, 16, 3), a = f.artist ? wrapFit(f.artist, 26, 2) : []
  let tS = fit(t, 1700, 0.5, 230), aS = a.length ? fit(a, 1500, 0.6, 110) : 0
  const used = t.length * tS * 1.1 + a.length * aS * 1.2 + 120; if (used > 1150) { const k = 1150 / used; tS *= k; aS *= k }
  const gH = t.length * tS * 1.05 + (a.length ? 110 + a.length * aS * 1.05 : 0)
  const gY = Math.max(820, 900 + (2550 - 900 - gH) / 2)
  const T = lines(t, { x: S / 2, y: gY, size: tS, font: 'Bodoni 72', italic: true, fill: top, anchor: 'middle' })
  const A = lines(a.map((x) => x.toUpperCase()), { x: S / 2, y: T.y + 110, size: aS, font: 'Bodoni 72 Smallcaps', fill: top, anchor: 'middle', spacing: aS * 0.12 })
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="0.75" stop-color="${glow}"/><stop offset="1" stop-color="${cream}"/></linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#sky)"/>${rays}
    <path d="M 450 ${S - 300} L 450 1150 A 1050 1050 0 0 1 2550 1150 L 2550 ${S - 300} Z" fill="${cream}" fill-opacity="0.92"/>
    <path d="M 520 ${S - 300} L 520 1160 A 980 980 0 0 1 2480 1160 L 2480 ${S - 300}" fill="none" stroke="${glow}" stroke-width="14"/>
    <text x="${S / 2}" y="${gY - 60}" text-anchor="middle" font-family="Bodoni 72" font-size="200" fill="${glow}">✝</text>${T.svg}${A.svg}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${top}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Bodoni 72 Smallcaps" font-size="78" letter-spacing="10" fill="${cream}">${esc(foot(f))}</text>`
}

// 5 ── VINTAGE: cream paper, red & black letterpress poster, ornamental border, woodtype (Afrikaans, Volksmusik, Easy Listening)
function vintage(f) {
  const inks = [['#B3261E', '#1C1B1A'], ['#1F4E79', '#1C1B1A'], ['#2F6B3A', '#1C1B1A'], ['#8A2D3B', '#1C1B1A']]
  const [red, ink] = inks[hash(f.cat || f.title) % inks.length], paper = '#F3E9D2'
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 20, 2) : [], t = wrapFit(f.title.toUpperCase(), 14, 4)
  let tS = fit(t, 2200, 0.62, 300), aS = a.length ? fit(a, 2100, 0.62, 140) : 0
  const used = t.length * tS * 1.05 + a.length * aS * 1.2 + 420; if (used > 1900) { const k = 1900 / used; tS *= k; aS *= k }
  const blockH = a.length * aS * 1.05 + (a.length ? 70 : 0) + 80 + t.length * tS * 1.05 + 170
  const A = lines(a, { x: S / 2, y: Math.max(470, 450 + (2620 - 450 - blockH) / 2), size: aS, font: 'Copperplate', weight: 700, fill: ink, anchor: 'middle', spacing: aS * 0.1 })
  const y1 = A.y + (a.length ? 70 : 0)
  const T = lines(t, { x: S / 2, y: y1 + 80, size: tS, font: 'Rockwell', weight: 800, fill: red, anchor: 'middle' })
  const stars = (y) => `<text x="${S / 2}" y="${y}" text-anchor="middle" font-family="Bodoni Ornaments" font-size="110" fill="${ink}">✦  ✦  ✦</text>`
  return `<rect width="${S}" height="${S}" fill="${paper}"/>
    <rect x="110" y="110" width="${S - 220}" height="${S - 430}" fill="none" stroke="${ink}" stroke-width="26"/>
    <rect x="170" y="170" width="${S - 340}" height="${S - 550}" fill="none" stroke="${red}" stroke-width="10"/>
    ${[[170, 170], [S - 170, 170], [170, S - 380], [S - 170, S - 380]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="40" fill="${red}"/>`).join('')}
    <rect x="300" y="300" width="${S - 600}" height="110" fill="${ink}"/><text x="${S / 2}" y="385" text-anchor="middle" font-family="Copperplate" font-weight="700" font-size="74" letter-spacing="18" fill="${paper}">${esc((f.label || '').toUpperCase())}</text>
    ${A.svg}${stars(y1 + 40)}${T.svg}${stars(T.y + 170)}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${red}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Copperplate" font-weight="700" font-size="80" letter-spacing="10" fill="${paper}">${esc([f.cat, f.year].filter(Boolean).join('   ·   ').toUpperCase())}</text>`
}

const STYLES = { township, heritage, jazz, gospel, vintage }
export function styledSvg(album, style) {
  const s = style || styleFor(album.genre)
  if (!s || !STYLES[s]) return coverSvg(album)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${STYLES[s](coverFields(album))}</svg>`
}
export async function renderStyled(album, { style, size = 3000, quality = 90 } = {}) {
  const png = await sharp(Buffer.from(styledSvg(album, style))).png().toBuffer()
  return sharp(png).resize(size, size).jpeg({ quality, mozjpeg: true }).toBuffer()
}
