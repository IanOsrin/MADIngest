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
/** Footer font size that keeps `text` inside the cover width (≈ 0.62 em per character incl. letter-spacing). */
const footSize = (text, base) => Math.min(base, Math.floor(2560 / (0.68 * Math.max(String(text).length, 1))))

// township + heritage (the African-pattern designs) were dropped on Ian's word, 2026-10-14 ("Lose the african pattern
// ones"): those genres now get the vinyl design. Their drawing functions stay below, unused.
const DROPPED = new Set(['township', 'heritage'])
const FAMILIES = [
  ['township', /afro ?-?pop|afro ?soul|afro ?-?fusion|afro ?beat|funk|disco|soul|^pop|pop rock|70|80|bubblegum|kwaito|mbaqanga|reggae|rock/i],
  ['heritage', /afro ?-?folk|traditional|^african$|world|maskandi|isicathamiya|neo.?trad/i],
  ['jazz', /jazz|kwela|marabi/i],
  ['gospel', /gospel|choral|classical|religious|sacred|hymn|vocal/i],
  ['vintage', /volksmusi|afrikaans|boeremusiek|country|folk|easy listening|oldies|50|60|children|instrumental|langarm/i],
]
export function styleFor(genre) { const g = String(genre || ''); for (const [k, re] of FAMILIES) if (re.test(g)) return DROPPED.has(k) ? null : k; return null }

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
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="220" y="${S - 125}" font-family="Futura" font-weight="700" font-size="${footSize(foot(f), 76)}" letter-spacing="6" fill="${c[0]}">${esc(foot(f))}</text>`
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
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Copperplate" font-size="${footSize(foot(f), 74)}" letter-spacing="8" fill="${cream}">${esc(foot(f))}</text>`
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
    <text x="220" y="${S - 130}" font-family="Avenir Next Condensed" font-weight="600" font-size="${footSize(foot(f), 72)}" letter-spacing="10" fill="${paper}" fill-opacity="0.8">${esc(foot(f))}</text>`
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
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${top}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Bodoni 72 Smallcaps" font-size="${footSize(foot(f), 78)}" letter-spacing="10" fill="${cream}">${esc(foot(f))}</text>`
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
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${red}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Copperplate" font-weight="700" font-size="${footSize([f.cat, f.year].filter(Boolean).join('   ·   '), 80)}" letter-spacing="10" fill="${paper}">${esc([f.cat, f.year].filter(Boolean).join('   ·   ').toUpperCase())}</text>`
}

// ── Added 2026-11-11 for the Make Cover tab ("create a few more covers"): groove · modern · cassette · minimal.
// Picked by hand only — styleFor() never suggests them, so the batch runner (scripts/generate-covers.mjs) is unchanged.
// Same font families as the designs above, so the Linux look-alikes in fonts/cover-fonts cover them too.

// 6 ── GROOVE: 70s sunset — concentric colour bands rising from the corner, slab-serif title (Pop, Soul, Funk, Disco)
function groove(f) {
  const sets = [['#F4E9D4', ['#E8572A', '#F29E38', '#F6C744', '#7FA650', '#2C6E7F'], '#2B1D14'], ['#F6EEDF', ['#C2412D', '#E07A3A', '#EDB547', '#A3B565', '#5C7F8E'], '#231A15'],
    ['#EFE6D2', ['#7B2D3B', '#C2523C', '#E58E3C', '#F0C35A', '#3E6B5A'], '#1F1A17'], ['#F3E7D8', ['#3D5A80', '#98C1D9', '#EE6C4D', '#F4A259', '#5B8E7D'], '#1B1B1E']]
  const [bg, bands, ink] = sets[hash(f.cat || f.title) % sets.length]
  const arcs = bands.map((c, i) => `<circle cx="${S}" cy="${S - 300}" r="${1750 - i * 260}" fill="${c}"/>`).join('') + `<circle cx="${S}" cy="${S - 300}" r="${1750 - bands.length * 260}" fill="${bg}"/>`
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 18, 2) : [], t = wrapFit(f.title, 16, 3)
  let aS = a.length ? fit(a, 2560, 0.5, 190) : 0, tS = fit(t, 2560, 0.6, 270)
  const used = a.length * aS * 1.05 + (a.length ? 60 : 0) + t.length * tS * 1.05; if (used > 780) { const k = 780 / used; aS *= k; tS *= k }
  const A = lines(a, { x: 220, y: 170, size: aS, font: 'Avenir Next Condensed', weight: 700, fill: bands[0], spacing: aS * 0.06 })
  const T = lines(t, { x: 220, y: A.y + (a.length ? 60 : 0), size: tS, font: 'Rockwell', weight: 700, fill: ink })
  return `<rect width="${S}" height="${S}" fill="${bg}"/>${arcs}${A.svg}${T.svg}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="220" y="${S - 125}" font-family="Avenir Next Condensed" font-weight="600" font-size="${footSize(foot(f), 76)}" letter-spacing="8" fill="${bg}">${esc(foot(f))}</text>`
}

// 7 ── MODERN: Swiss modernist — one big disc of colour, a heavy bar, condensed grotesque type set flush left
function modern(f) {
  const sets = [['#F2F0EA', '#E2412E', '#151515'], ['#EEF0EC', '#1F5FA8', '#121212'], ['#F3EFE6', '#E8A317', '#161616'], ['#ECEFEA', '#2F8F6B', '#141414'], ['#F1ECE6', '#7A3E9D', '#151515']]
  const [paper, accent, ink] = sets[hash(f.cat || f.title) % sets.length]
  const cS = f.cat ? fit([f.cat], 880, 0.45, 210) : 0
  const top = f.cat ? `<text x="220" y="${220 + cS}" font-family="DIN Condensed" font-weight="700" font-size="${cS}" fill="${ink}">${esc(f.cat)}</text>` : ''
  const lab = `<text x="226" y="${f.cat ? 330 + cS : 300}" font-family="Avenir Next Condensed" font-weight="600" font-size="${Math.min(60, fit([f.label], 900, 0.5, 60))}" letter-spacing="10" fill="${ink}">${esc(f.label.toUpperCase())}</text>`
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 16, 2) : [], t = wrapFit(f.title.toUpperCase(), 20, 3)
  let aS = a.length ? fit(a, 2560, 0.44, 280) : 0, tS = fit(t, 2560, 0.5, a.length ? 170 : 260)
  const height = () => a.length * aS * 0.95 + (a.length ? 50 : 0) + t.length * tS * 1.05
  if (height() > 720) { const k = 720 / height(); aS *= k; tS *= k }
  const y0 = S - 370 - height()
  const A = lines(a, { x: 220, y: y0, size: aS, lead: 0.95, font: 'DIN Condensed', weight: 700, fill: ink })
  const T = lines(t, { x: 224, y: A.y + (a.length ? 50 : 0), size: tS, font: 'Avenir Next Condensed', weight: 600, fill: a.length ? accent : ink, spacing: tS * 0.04 })
  return `<rect width="${S}" height="${S}" fill="${paper}"/>
    <circle cx="1980" cy="1020" r="760" fill="${accent}"/><rect x="1180" y="1230" width="${S - 1180}" height="130" fill="${ink}"/>
    <rect x="220" y="${y0 - 70}" width="${S - 440}" height="12" fill="${ink}"/>${top}${lab}${A.svg}${T.svg}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${ink}"/><text x="220" y="${S - 125}" font-family="Avenir Next Condensed" font-weight="600" font-size="76" letter-spacing="10" fill="${paper}">${esc(f.year)}</text>
    <rect x="${S - 520}" y="${S - 190}" width="300" height="80" fill="${accent}"/>`
}

// 8 ── CASSETTE: a tape on a coloured field, the title typed on its label (80s releases, Kwaito, compilations)
function cassette(f) {
  const sets = [['#1E2A38', '#E4572E'], ['#3B2F4A', '#F2A541'], ['#20453E', '#E9C46A'], ['#5A2328', '#4FA3A5'], ['#2E3A59', '#F25F5C']]
  const [bg, stripe] = sets[hash(f.cat || f.title) % sets.length], shell = '#2A2A2D', label = '#F4EEDC', ink = '#1B1B1B'
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 18, 2) : []
  const aS = a.length ? Math.min(fit(a, 2560, 0.42, 300), Math.floor(600 / (a.length * 0.95))) : 0
  const A = lines(a, { x: S / 2, y: 120 + (680 - a.length * aS * 0.95) / 2, size: aS, lead: 0.95, font: 'DIN Condensed', weight: 700, fill: label, anchor: 'middle' })
  const t = wrapFit(f.title, 22, 3)
  let tS = fit(t, 1800, 0.5, 180); if (t.length * tS * 1.15 > 500) tS = Math.floor(500 / (t.length * 1.15))
  const T = lines(t, { x: 520, y: 1060 + (500 - t.length * tS * 1.15) / 2, size: tS, lead: 1.15, font: 'Didot', italic: true, fill: ink })
  const ruled = Array.from({ length: 5 }, (_, i) => `<line x1="460" y1="${1170 + i * 100}" x2="2440" y2="${1170 + i * 100}" stroke="${stripe}" stroke-opacity="0.35" stroke-width="5"/>`).join('')
  const reel = (cx) => `<circle cx="${cx}" cy="1750" r="150" fill="#E8E2D0"/><circle cx="${cx}" cy="1750" r="62" fill="${shell}"/>` +
    Array.from({ length: 6 }, (_, i) => `<rect x="${cx - 14}" y="1688" width="28" height="34" fill="#E8E2D0" transform="rotate(${i * 60} ${cx} 1750)"/>`).join('')
  const screws = [[340, 960], [2660, 960], [340, 2400], [2660, 2400], [1500, 2400]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="28" fill="#4A4A4E"/><line x1="${x - 16}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="${shell}" stroke-width="7"/>`).join('')
  const catS = f.cat ? fit([f.cat], 520, 0.5, 90) : 0
  return `<rect width="${S}" height="${S}" fill="${bg}"/>${A.svg}
    <rect x="260" y="880" width="2480" height="1600" rx="80" fill="${shell}"/>
    <rect x="400" y="1000" width="2200" height="1060" rx="30" fill="${label}"/><rect x="400" y="1000" width="2200" height="40" fill="${stripe}"/>
    ${ruled}<text x="2520" y="1210" text-anchor="end" font-family="Avenir Next Condensed" font-weight="700" font-size="150" fill="${stripe}">A</text>${T.svg}
    <rect x="880" y="1590" width="1240" height="320" rx="160" fill="#121214"/>${reel(1170)}${reel(1830)}
    <rect x="1330" y="1700" width="340" height="100" fill="#3A2A20" fill-opacity="0.85"/>
    ${f.cat ? `<text x="2520" y="2010" text-anchor="end" font-family="Avenir Next Condensed" font-weight="600" font-size="${catS}" letter-spacing="4" fill="${ink}">${esc(f.cat)}</text>` : ''}
    <polygon points="740,2480 880,2240 2120,2240 2260,2480" fill="#202023"/><circle cx="1120" cy="2380" r="40" fill="${bg}"/><circle cx="1880" cy="2380" r="40" fill="${bg}"/>
    ${screws}
    <rect x="0" y="${S - 300}" width="${S}" height="300" fill="${stripe}"/><text x="${S / 2}" y="${S - 125}" text-anchor="middle" font-family="Avenir Next Condensed" font-weight="700" font-size="${footSize(foot(f), 76)}" letter-spacing="8" fill="${ink}">${esc(foot(f))}</text>`
}

// 9 ── MINIMAL: quiet chamber/library sleeve — wide margins, Didot title, one band of colour carrying the catalogue
function minimal(f) {
  const sets = [['#F5F2EC', '#C8553D', '#1E1E1E'], ['#F2F2EE', '#2E5E8C', '#1C1C1C'], ['#F4F0E8', '#5E7F4F', '#1D1D1B'], ['#F6F1EA', '#A2783C', '#1E1C1A'], ['#F3F1EE', '#1E1E1E', '#1E1E1E']]
  const [paper, accent, ink] = sets[hash(f.cat || f.title) % sets.length]
  const a = f.artist ? wrapFit(f.artist.toUpperCase(), 24, 2) : [], t = wrapFit(f.title, 18, 3)
  let aS = a.length ? fit(a, 2200, 0.8, 100) : 0, tS = fit(t, 2300, 0.52, 250)
  const blockH = () => a.length * aS * 1.3 + (a.length ? 160 : 0) + t.length * tS * 1.12
  if (blockH() > 1250) { const k = 1250 / blockH(); aS *= k; tS *= k }
  const y0 = Math.max(260, 300 + (1300 - blockH()) / 2)
  const A = lines(a, { x: S / 2, y: y0, size: aS, lead: 1.3, font: 'Bodoni 72 Smallcaps', fill: ink, anchor: 'middle', spacing: aS * 0.2 })
  const rule = a.length ? `<rect x="${S / 2 - 110}" y="${A.y + 75}" width="220" height="8" fill="${accent}"/>` : ''
  const T = lines(t, { x: S / 2, y: A.y + (a.length ? 160 : 0), size: tS, lead: 1.12, font: 'Didot', fill: ink, anchor: 'middle' })
  const band = [f.cat, f.year].filter(Boolean).join('   ·   ').toUpperCase()
  return `<rect width="${S}" height="${S}" fill="${paper}"/>${A.svg}${rule}${T.svg}
    <rect x="0" y="1820" width="${S}" height="300" fill="${accent}"/>
    <text x="${S / 2}" y="2000" text-anchor="middle" font-family="Avenir Next Condensed" font-weight="600" font-size="${footSize(band, 80)}" letter-spacing="16" fill="${paper}">${esc(band)}</text>
    <rect x="${S / 2 - 600}" y="2380" width="1200" height="4" fill="${ink}" fill-opacity="0.5"/>
    <text x="${S / 2}" y="2560" text-anchor="middle" font-family="Bodoni 72 Smallcaps" font-size="${footSize(f.label, 72)}" letter-spacing="12" fill="${ink}">${esc(f.label.toUpperCase())}</text>`
}

const STYLES = { jazz, gospel, vintage, groove, modern, cassette, minimal }
export function styledSvg(album, style) {
  const s = style || styleFor(album.genre)
  if (!s || !STYLES[s]) return coverSvg(album)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${STYLES[s](coverFields(album))}</svg>`
}
export async function renderStyled(album, { style, size = 3000, quality = 90 } = {}) {
  const png = await sharp(Buffer.from(styledSvg(album, style))).png().toBuffer()
  return sharp(png).resize(size, size).jpeg({ quality, mozjpeg: true }).toBuffer()
}
