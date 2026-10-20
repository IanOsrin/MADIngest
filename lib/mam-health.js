/**
 * lib/mam-health.js — catalogue-wide data checks over Music Arena Master.
 *
 * Replaces the old Catalogue health check (lib/catalogue-health.js), which read
 * the website's Postgres mirror of MadStreamer. MAM is the master now, so this
 * reads MAM itself — live, not a nightly copy.
 *
 * Reading 126k songs out of FileMaker is the expensive part, so it is done the
 * way scripts/mam-songs-scan.mjs does it: pages of 500, a pause between pages,
 * retries, one sweep at a time, and only the fields the checks need are kept
 * (the hosted instance is small and already holds the 82k-row metadata cache).
 * The result is held in memory until someone presses Refresh.
 *
 * The checks themselves (analyse) are pure — they take arrays and a cache
 * lookup — so scripts/mam-health-smoke.mjs can run them on fixtures.
 */
import { lookupAlbumTracks, loadMetadata, getStatus as cacheStatus } from './metadata-cache.js'
import { songFillsFrom, albumFillsFrom, tn, nn, similarity } from './mam-cache-fill.js'
import { mamComposerFields } from './credits.js'

const S = (v) => String(v ?? '').trim()
const HOST = () => S(process.env.GALLO_FM_HOST).replace(/\/$/, '')
const BASE = () => `${HOST()}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const SONGS_LAYOUT = () => process.env.MAM_FM_SONGS_LAYOUT || 'Songs'
const ALBUMS_LAYOUT = () => process.env.MAM_FM_ALBUMS_LAYOUT || 'Albums'
const PAGE = 500
const PAUSE_MS = Number(process.env.MAM_HEALTH_PAUSE_MS) || 250
const RECORD_CAP = Number(process.env.HEALTH_RECORD_CAP) || 5000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Values people type meaning "blank" — "#N/A" passes a not-empty test.
const JUNK = /^(#n\/a|#ref!|#value!|n\/a|na|none|null|nil|-+|0+|tbc|tba|unknown|\?+|x+)$/i
const ISRC_FORMAT = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/
const isrcOf = (v) => S(v).toUpperCase().replace(/[\s-]/g, '')
const secs = (d) => { const s = S(d); if (!s) return null; if (/^\d+$/.test(s)) return +s; const p = s.split(':').map(Number); return p.some(isNaN) ? null : p.reduce((a, n) => a * 60 + n, 0) }

// ── What makes two copies different versions rather than duplicates ──────────
// Same rules as the 2026-10-19 duplicate scan: a bracket or " - " part counts
// whole when it holds a version word ("English Version" ≠ "Afrikaans Version"),
// numbered parts/sides count anywhere, and a misspelling is still the same song.
const VERSION_WORDS = /\b(live|remix(ed)?|mix|edit|instr?(umental|umentaal)?\.?|a ?cappella|acapella|reprise|radio|extended|demo|mono|stereo|version|(take|tk)\.?\s*\d+|dub|intro|outro|remaster(ed)?|acoustic|unplugged|orchestra(l)?|vocal|karaoke|backing( track)?|club|alt(ernate)?|bonus|interlude|weergawe|uitgawe)(?![a-z])/gi
const NUMBERED = /\b(part|pt|deel|no|nr|vol|movement|mvt|kant|side|disc|cd)\.?\s*(\d+|[ivx]+|[ab])\b/gi
const fold = (s) => S(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const canon = (b) => b.replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(pt|part)\s/, 'part ').replace(/^instr?(umental|umentaal)?$/, 'instrumental').replace(/^(tk|take)\s*/, 'take ')
const parts = (t) => [...(t.match(/\(.*?\)|\[.*?\]/g) || []), ...t.split(/\s+-\s+/).slice(1)].map(canon).filter(Boolean)
const hasVersionWord = (p) => { VERSION_WORDS.lastIndex = 0; NUMBERED.lastIndex = 0; return VERSION_WORDS.test(p) || NUMBERED.test(p) }
const PLACEHOLDER = /^(unknown|untitled|no title|track|trk|song|n a)\s*\d*$/
export const baseTitle = (t) => fold(t).replace(/^medley:-\s*/, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(NUMBERED, ' ')
  .replace(/\s+-\s+.*$/, (m) => m.replace(VERSION_WORDS, ' ')).replace(/[^a-z0-9]+/g, ' ').trim()
export const versionOf = (s) => {
  const t = fold(s.title)
  const bits = [...parts(t).filter(hasVersionWord), ...(fold(s.version) ? [canon(fold(s.version))] : []), ...(t.match(NUMBERED) || []).map(canon)]
  return [...new Set(bits)].sort().join(' + ')
}
const qualifierOf = (s) => parts(fold(s.title)).filter((p) => !hasVersionWord(p)).sort().join(' + ')
// Numbers must agree: "Medley 1"/"Medley 4" and "GMVF09690"/"GMVF09692" are
// different tracks however alike the letters are.
const digits = (t) => (t.match(/\d+/g) || []).map(Number).join(',')
// Dice on bigrams with each title's bigrams worked out once: the per-album
// pairwise pass compares ~1M pairs, and similarity() rebuilt both maps every call.
const _grams = new Map()
const gramsOf = (t) => {
  let g = _grams.get(t)
  if (!g) { g = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1) } _grams.set(t, g) }
  return g
}
const dice = (a, b) => {
  if (a === b) return 1
  const la = a.length - 1, lb = b.length - 1
  if (la < 1 || lb < 1 || Math.min(la, lb) / Math.max(la, lb) < 0.66) return 0   // can't reach 0.8
  const ga = gramsOf(a), gb = gramsOf(b)
  let hit = 0
  for (const [k, n] of ga) hit += Math.min(n, gb.get(k) || 0)
  return (2 * hit) / (la + lb)
}
const sameSong = (a, b) => a === b || (!!a && !!b && digits(a) === digits(b) && dice(a, b) >= 0.8)

// ── The checks ───────────────────────────────────────────────────────────────
// `why` is shown to a person: it says what goes wrong, not just the rule.
export const CHECKS = [
  { code: 'isrc-shared', severity: 'error', group: 'Identity', unit: 'songs',
    label: 'One ISRC on different songs of the same album',
    why: 'Two different titles cannot be one recording. Royalties and DSP delivery are keyed on the ISRC, so plays land on the wrong song — BRS 275 has 12 of these.' },
  { code: 'code-junk', severity: 'error', group: 'Identity', unit: 'records',
    label: 'Placeholder text in ISRC or UPC',
    why: 'Values like "#N/A" or "0" are not empty, so every not-blank check passes and they travel on as if they were real codes.' },
  { code: 'isrc-format', severity: 'warn', group: 'Identity', unit: 'songs',
    label: 'ISRC in the wrong shape',
    why: 'An ISRC is 2 letters, 3 letters/digits, 7 digits (ZAC032300553). Anything else is rejected at delivery.' },
  { code: 'isrc-missing', severity: 'warn', group: 'Identity', unit: 'songs',
    label: 'No ISRC',
    why: 'The recording cannot be reported or delivered, and the site will not render it.' },
  { code: 'upc-missing', severity: 'warn', group: 'Identity', unit: 'albums',
    label: 'Album has no UPC / barcode',
    why: 'Required for delivery and by the site display rule.' },

  { code: 'album-doubled', severity: 'error', group: 'Duplicates', unit: 'albums',
    label: 'Every track on the album twice',
    why: 'The album was merged in twice (RPM 5008 was). Each recording is counted, delivered and paid twice.' },
  { code: 'duplicate-songs', severity: 'warn', group: 'Duplicates', unit: 'extra copies',
    label: 'Same recording twice on one album',
    why: 'Same ISRC or title, same version, same length. Versions (Live, Remix, Instrumental, Part 2, English/Afrikaans Version …) are NOT counted. Check a group before deleting — titles can hide separate movements.' },

  { code: 'songs-without-album', severity: 'error', group: 'Album records', unit: 'songs',
    label: 'Song whose catalogue has no album record',
    why: 'The song points at a catalogue MAM has no album for, so it has no title, artwork or barcode and falls out of every album view.' },
  { code: 'albums-without-songs', severity: 'warn', group: 'Album records', unit: 'albums',
    label: 'Album with no songs',
    why: 'An empty shell — either its songs were filed under another catalogue or it was never filled.' },
  { code: 'catalogue-doubled', severity: 'error', group: 'Album records', unit: 'albums',
    label: 'Catalogue number typed twice',
    why: '"RPM 1006-S RPM 1006-S": the catalogue matches nothing anywhere else, so the album sits apart from its own copy.' },
  { code: 'catalogue-twice', severity: 'error', group: 'Album records', unit: 'catalogues',
    label: 'Two album records with the same catalogue',
    why: 'Songs and lookups land on whichever record is found first; the other one drifts.' },
  { code: 'track-count', severity: 'warn', group: 'Album records', unit: 'albums',
    label: 'Track Count does not match the songs',
    why: 'Track Count is a typed number, not counted. After a merge or delete it lies about the album.' },
  { code: 'album-title-missing', severity: 'warn', group: 'Album records', unit: 'albums',
    label: 'Album has no title or artist',
    why: 'Shows as a blank card and cannot be found by name.' },
  { code: 'repeated-sequence', severity: 'warn', group: 'Album records', unit: 'albums',
    label: 'Same track number twice on one album',
    why: 'The running order is ambiguous, so the album plays in an arbitrary order.' },
  { code: 'no-sequence', severity: 'info', group: 'Album records', unit: 'songs',
    label: 'Song has no track number',
    why: 'Sorts arbitrarily within its album.' },

  { code: 'singles-bundle', severity: 'warn', group: 'Singles and albums', unit: 'albums',
    label: 'A "Singles" bundle repeats songs that are also on their own single',
    why: 'Albums titled "Singles" or catalogued as a range (4885-90) were built in the September merge out of individual singles that MAM also holds separately (BB 1023 "Mamaile" is on its own AND in 4885-90). Each recording is then listed, delivered and counted twice.' },
  { code: 'single-album-isrc-differs', severity: 'error', group: 'Singles and albums', unit: 'songs',
    label: 'Same song on a single and an album, different ISRCs',
    why: 'One recording reissued on an album keeps its ISRC. Two codes means one of them is wrong, or the two are different takes that need telling apart. Matched by title, artist and version.' },
  { code: 'single-album-isrc-missing', severity: 'warn', group: 'Singles and albums', unit: 'songs',
    label: 'Same song on a single and an album, one copy has no ISRC',
    why: 'The other copy has the code — usually it can simply be copied across once you agree they are the same recording.' },
  { code: 'no-audio', severity: 'error', group: 'Media', unit: 'songs',
    label: 'Song has no audio',
    why: 'No S3, Vision or CMS audio path — nothing to play or deliver.' },
  { code: 'no-artwork', severity: 'warn', group: 'Media', unit: 'albums',
    label: 'Album has no artwork',
    why: 'The card renders blank and the site display rule hides the tracks.' },

  { code: 'cache-catalogue-mismatch', severity: 'warn', group: 'Against the Cache', unit: 'albums',
    label: 'Cache files the album under a different catalogue (-S)',
    why: 'MAM says RPM 5008, the Cache says RPM 5008-S, so the Cache values never reach the album.' },
  { code: 'not-in-cache', severity: 'info', group: 'Against the Cache', unit: 'albums',
    label: 'Album not in the Cache',
    why: 'Nothing to check it against — its metadata rests on MAM alone.' },
  { code: 'isrc-differs-cache', severity: 'error', group: 'Against the Cache', unit: 'songs',
    label: 'ISRC differs from the Cache',
    why: 'The Cache is the master, and the ISRC is the field royalties hang on. Matched by album and title, near-identical spellings included ("What A wonderful Wold" = "What a Wonderful World").' },
  { code: 'not-in-cache-tracklist', severity: 'warn', group: 'Against the Cache', unit: 'songs',
    label: "Song not on the Cache's track list for its album",
    why: 'The Cache has the album but not this song — either the title is spelled beyond recognition, or the song does not belong on this album (GL 1890 had "Superman", "Sunshine" … all on one ISRC). Its ISRC and credits cannot be checked.' },
  { code: 'cache-differs', severity: 'warn', group: 'Against the Cache', unit: 'songs',
    label: 'Song differs from the Cache',
    why: 'The Cache is the master. These songs hold a different value in at least one field the Cache supplies (matched by album and title, near-identical spellings included).' },
]

// ── Reading MAM ──────────────────────────────────────────────────────────────
async function fmLogin() {
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const r = await fetch(BASE() + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}', signal: AbortSignal.timeout(60000) })
  const token = (await r.json())?.response?.token
  if (!token) throw new Error('Could not reach Music Arena Master')
  return token
}

/** Page through a layout, handing each page's records to `onRecord`. */
async function readLayout(layout, onRecord, progress) {
  let token = await fmLogin()
  try {
    for (let off = 1; ; off += PAGE) {
      let j
      for (let t = 0; ; t++) {
        try {
          j = await (await fetch(`${BASE()}/layouts/${encodeURIComponent(layout)}/records?_limit=${PAGE}&_offset=${off}`,
            { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(60000) })).json()
        } catch (e) { if (t < 3) { await sleep(3000 * (t + 1)); continue } throw e }
        const code = j?.messages?.[0]?.code
        if (code === '952' && t < 2) { token = await fmLogin(); continue }
        if (code !== '0' && code !== '401' && t < 3) { await sleep(2000 * (t + 1)); continue }
        break
      }
      const rows = j?.response?.data || []
      for (const r of rows) onRecord(r)
      progress?.(layout, off - 1 + rows.length, j?.response?.dataInfo?.totalRecordCount)
      if (rows.length < PAGE) break
      await sleep(PAUSE_MS)
    }
  } finally {
    fetch(`${BASE()}/sessions/${token}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).catch(() => {})
  }
}

// What the Cache says a song should hold — the same rules the Cache-is-master
// update used (2026-10-19): raw cache text, composer slots never cleared,
// Duration left out (0:02:34 = 00:02:34), placeholder cells ignored.
const CACHE_JUNK = /^(0|-|n\/?a|none|null|unknown|tbd|\.|x)$/i
const isoOf = (v) => { const s = S(v); let m
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return s }
function cacheWants(r, seqOk) {
  const f = songFillsFrom(r)
  delete f.Duration
  if (!seqOk) { delete f['Sequence Number']; delete f['Track Number'] }
  for (const k of ['Composers', 'Composer', 'Composer 2', 'Composer 3', 'Composer 4']) delete f[k]
  if (nn(r.composer)) Object.assign(f, mamComposerFields(nn(r.composer), { clearUnused: false }))
  if (nn(r.publisher)) f.Publishers = nn(r.publisher)
  if (nn(r.producer)) { f.Producers = nn(r.producer); f.Producer = nn(r.producer) }
  return Object.entries(f).filter(([, v]) => v != null && !(S(v) && CACHE_JUNK.test(S(v))))
}
const CACHE_FIELDS = ['Track Artist', 'Sequence Number', 'Track Number', 'ISRC', 'Genre', 'Composers', 'Composer', 'Composer 2',
  'Composer 3', 'Composer 4', 'Producers', 'Producer', 'Publishers', 'Language', 'Language Code', 'pLine', 'cLine',
  'Rights Territories', 'Original Release Date', 'Featured Artist', 'Lyrical Content Rating']

/**
 * The cache diff is worked out WHILE reading, so only the names of the fields
 * that differ are kept per song — holding 21 extra fields for 126k songs is
 * what would push the small instance over.
 */
export function cacheDiffer(lookup = lookupAlbumTracks) {
  const memo = new Map()
  const forCat = (cat) => {
    if (memo.has(cat)) return memo.get(cat)
    const rows = lookup(cat) || []
    const seqs = rows.map((r) => Number(r.seq))
    const seqOk = rows.length > 0 && seqs.every((n) => Number.isInteger(n) && n >= 1 && n <= rows.length * 2) && new Set(seqs).size === seqs.length
    const count = new Map(), byTitle = new Map()
    for (const r of rows) { const k = tn(r.track_name); count.set(k, (count.get(k) || 0) + 1); if (!byTitle.has(k)) byTitle.set(k, r) }
    const e = { rows: rows.length, all: rows, seqOk, byTitle, count }
    memo.set(cat, e)
    return e
  }
  // Leading articles and medley labels don't make a different song
  // ("Dream Of Owen" / "The Dream of Olwen") — same rule as the ISRC repair.
  const core = (t) => tn(t).replace(/^(medley|keurspel)\s+/, '').replace(/^(the|a|an|die|n|het|de)\s+/, '').trim()
  return (cat, fd) => {
    const c = forCat(cat)
    if (!c.rows) return null
    const title = fd['Track Name'], k = tn(title)
    if (!k) return null
    // Exact title first; then ONE near-identical title (spelling slips — the 55
    // ISRCs repaired on 2026-10-20 were all of this kind and went unreported).
    let r = c.count.get(k) === 1 ? c.byTitle.get(k) : null, by = 'title'
    if (!r && !c.count.get(k)) {
      const near = c.all.filter((x) => digits(tn(x.track_name)) === digits(k) &&
        (core(x.track_name) === core(title) || similarity(core(x.track_name), core(title)) >= 0.8))
      if (near.length === 1) { r = near[0]; by = 'near title' }
      else if (!near.length) return { notListed: true }
    }
    if (!r) return null                      // the cache lists the title more than once
    const fields = []
    for (const [f, v] of cacheWants(r, c.seqOk)) {
      if (!(f in fd)) continue
      if (/Date$/.test(f) ? isoOf(fd[f]) === isoOf(v) : S(fd[f]) === S(v)) continue
      fields.push(f)
    }
    return { fields, by, cacheTitle: S(r.track_name), cacheIsrc: S(r.isrc) }
  }
}

/** One pass over MAM, keeping a slim copy of each record. */
export async function readMam(progress) {
  const differ = cacheStatus().loaded ? cacheDiffer() : null
  const songs = [], albums = []
  await readLayout(SONGS_LAYOUT(), (r) => {
    const f = r.fieldData
    const cat = S(f['Album Catalogue'])
    songs.push({
      id: S(r.recordId), cat, albumId: S(f.AlbumID), seq: S(f['Sequence Number']), title: S(f['Track Name']),
      artist: S(f['Track Artist']), version: S(f.Version), isrc: S(f.ISRC), duration: S(f.Duration), sources: S(f.Sources),
      audio: !!S(f.Audio_S3_URL || f.Audio_Vision_URL || f.CMS_Audio_File),
      cacheDiff: differ && cat ? differ(cat, f) : null,
    })
  }, progress)
  await readLayout(ALBUMS_LAYOUT(), (r) => {
    const f = r.fieldData
    albums.push({
      id: S(r.recordId), cat: S(f['Album Catalogue Number']), ref: S(f['Reference Catalogue Number']), albumId: S(f.AlbumID),
      title: S(f['Album Title']), artist: S(f['Album Artist']), upc: S(f.UPC), trackCount: S(f['Track Count']),
      artwork: !!S(f.Artwork_S3_URL || f.Artwork_Vision_URL),
    })
  }, progress)
  return { songs, albums, cacheLoaded: !!differ }
}

// ── The analysis (pure) ──────────────────────────────────────────────────────
const songRow = (s, extra = {}) => ({ record_id: s.id, catalogue: s.cat, seq: s.seq, title: s.title, artist: s.artist,
  isrc: s.isrc, duration: s.duration, sources: s.sources, ...extra })

const foldName = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '')
const sameArtist = (a, b) => { a = foldName(a); b = foldName(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a) || similarity(a, b) >= 0.85) }
// "4885-90" is a run of catalogues (4885 … 4890); "PLS 7222-2" is disc 2, not a run.
const isRange = (cat) => {
  const m = S(cat).match(/(\d+)\s*-\s*(\d+)$/)
  if (!m) return false
  const [a, b] = [m[1], m[2]]
  const end = b.length >= a.length ? +b : +(a.slice(0, a.length - b.length) + b)
  return end > +a && end - +a <= 50
}
const isBundle = (cat, title) => /^singles?$/i.test(S(title)) || isRange(cat)

/**
 * Songs on a 1–2 song release (a single) that also sit on a bigger album
 * (Ian, 2026-10-20). Matched on title + artist + version — the same song
 * reissued keeps its title, and a different take says so in its title. A
 * single song that matches more than three album songs is a generic title
 * ("unknown" by "unknown" matched 724) and is left out.
 */
async function singlesVsAlbums(byCat, albumsByCat, push) {
  const albumTitle = (c) => albumsByCat.get(c)?.[0]?.title || ''
  const byTitle = new Map()
  for (const [c, list] of byCat) {
    if (list.length <= 2) continue
    for (const s of list) { const b = baseTitle(s.title); if (b && !PLACEHOLDER.test(b)) (byTitle.get(b) || byTitle.set(b, []).get(b)).push(s) }
  }
  const bundles = new Map()   // bundle catalogue → { songs on singles, singles }
  let n = 0
  for (const [c, list] of byCat) {
    if (++n % 1000 === 0) await breather()
    if (list.length > 2) continue
    for (const s of list) {
      const b = baseTitle(s.title)
      if (!b || PLACEHOLDER.test(b) || PLACEHOLDER.test(foldName(s.artist))) continue
      const v = versionOf(s)
      const hits = (byTitle.get(b) || []).filter((x) => x.cat !== c && sameArtist(s.artist, x.artist) && versionOf(x) === v)
      if (!hits.length || hits.length > 3) continue
      for (const x of hits) {
        const i = isrcOf(s.isrc), xi = isrcOf(x.isrc)
        const pair = { single_catalogue: c, single_title: s.title, single_isrc: s.isrc, single_length: s.duration,
          album_catalogue: x.cat, album: albumTitle(x.cat), album_song: x.title, album_isrc: x.isrc, album_length: x.duration,
          artist: s.artist, single_record_id: s.id, album_record_id: x.id }
        if (i && xi && i !== xi) push('single-album-isrc-differs', { catalogue: c, ...pair })
        else if (!i !== !xi) push('single-album-isrc-missing', { catalogue: i ? x.cat : c, missing_on: i ? 'album' : 'single', ...pair })
        if (isBundle(x.cat, albumTitle(x.cat))) {
          const e = bundles.get(x.cat) || bundles.set(x.cat, { songs: new Set(), singles: new Set() }).get(x.cat)
          e.songs.add(x.id); e.singles.add(c)
        }
      }
    }
  }
  for (const [c, e] of bundles) push('singles-bundle', { catalogue: c, album: albumTitle(c), songs: (byCat.get(c) || []).length,
    songs_also_on_a_single: e.songs.size, singles: [...e.singles].sort().join(', ') })
}

/**
 * @param {object}   snap               { songs, albums, cacheLoaded } as readMam returns
 * @param {function} [cacheTracks]      catalogue → cache rows (lookupAlbumTracks)
 * @returns {{ total:number, albums:number, results: Map<string, object[]> }}
 */
// Hand the event loop back every so often: run in one go, the checks froze the
// whole server (every tab, every user) for 20 s locally and longer on Render,
// and the page sat on its last progress line looking hung (Ian, 2026-10-20).
const breather = () => new Promise((r) => setImmediate(r))

export async function analyse({ songs, albums, cacheLoaded = false }, cacheTracks = lookupAlbumTracks, onProgress = () => {}) {
  const res = new Map(CHECKS.map((c) => [c.code, []]))
  const push = (code, row) => res.get(code).push(row)

  const byCat = new Map()
  for (const s of songs) if (s.cat) (byCat.get(s.cat) || byCat.set(s.cat, []).get(s.cat)).push(s)
  const albumsByCat = new Map()
  for (const a of albums) for (const c of new Set([a.cat, a.ref].filter(Boolean))) (albumsByCat.get(c) || albumsByCat.set(c, []).get(c)).push(a)

  // Song-level
  for (const s of songs) {
    const i = isrcOf(s.isrc)
    if (!S(s.isrc)) push('isrc-missing', songRow(s))
    else if (JUNK.test(S(s.isrc))) push('code-junk', songRow(s, { field: 'ISRC', value: s.isrc }))
    else if (!ISRC_FORMAT.test(i)) push('isrc-format', songRow(s))
    if (!s.seq) push('no-sequence', songRow(s))
    if (!s.audio) push('no-audio', songRow(s))
    if (s.cat && !albumsByCat.has(s.cat)) push('songs-without-album', songRow(s, { album_id: s.albumId }))
    if (!s.cat) push('songs-without-album', songRow(s, { album_id: s.albumId, note: 'no catalogue at all' }))
  }

  // Album-level
  for (const [c, list] of albumsByCat) {
    const own = list.filter((a) => a.cat === c)
    if (own.length > 1) push('catalogue-twice', { catalogue: c, records: own.length, titles: own.map((a) => a.title).join('  |  '), record_ids: own.map((a) => a.id).join(', ') })
  }
  for (const a of albums) {
    const songsHere = byCat.get(a.cat) || []
    const row = { record_id: a.id, catalogue: a.cat, album: a.title, artist: a.artist }
    if (!songsHere.length) push('albums-without-songs', row)
    if (!S(a.upc)) push('upc-missing', row)
    else if (JUNK.test(S(a.upc))) push('code-junk', { ...row, field: 'UPC', value: a.upc })
    if (!a.title || !a.artist) push('album-title-missing', row)
    if (!a.artwork) push('no-artwork', row)
    const w = a.cat.split(/\s+/)
    const half = w.slice(0, w.length / 2).join(' ')
    if (w.length >= 2 && w.length % 2 === 0 && /\d/.test(half) && half === w.slice(w.length / 2).join(' '))
      push('catalogue-doubled', { ...row, songs: songsHere.length })
    if (songsHere.length && S(a.trackCount) && Number(a.trackCount) !== songsHere.length)
      push('track-count', { ...row, track_count: a.trackCount, songs: songsHere.length })
    if (cacheLoaded && a.cat) {
      const rows = cacheTracks(a.cat) || []
      if (!rows.length) {
        const variant = ['-S', ' S', 'S'].map((x) => a.cat + x).find((v) => (cacheTracks(v) || []).length)
        if (variant && !albumsByCat.has(variant)) push('cache-catalogue-mismatch', { ...row, cache_catalogue: S(cacheTracks(variant)[0].catalogue), songs: songsHere.length, cache_tracks: cacheTracks(variant).length })
        else push('not-in-cache', { ...row, songs: songsHere.length })
      }
    }
  }

  // Per album: cache differences, duplicates, shared ISRCs, repeated track numbers
  let done = 0
  for (const [cat, list] of byCat) {
    if (++done % 250 === 0) { onProgress(done, byCat.size); await breather() }
    // A title MAM holds twice can't be paired with one cache row — the Cache
    // update skipped those too, so they are not reported as differing.
    const titleCount = new Map()
    for (const s of list) titleCount.set(tn(s.title), (titleCount.get(tn(s.title)) || 0) + 1)
    for (const s of list) {
      const d = s.cacheDiff
      if (!d) continue
      if (d.notListed) { if (!PLACEHOLDER.test(baseTitle(s.title))) push('not-in-cache-tracklist', songRow(s)); continue }
      if (!d.fields.length || titleCount.get(tn(s.title)) !== 1) continue
      const extra = { matched_by: d.by, cache_title: d.cacheTitle }
      if (d.fields.includes('ISRC')) push('isrc-differs-cache', songRow(s, { cache_isrc: d.cacheIsrc, ...extra }))
      push('cache-differs', songRow(s, { fields: d.fields.join(', '), ...extra }))
    }
    if (list.length < 2) continue
    const seqCount = new Map()
    for (const s of list) if (/^\d+$/.test(s.seq)) seqCount.set(+s.seq, (seqCount.get(+s.seq) || 0) + 1)
    const repeated = [...seqCount].filter(([, n]) => n > 1)
    if (repeated.length) push('repeated-sequence', { catalogue: cat, album: albumsByCat.get(cat)?.[0]?.title || '', songs: list.length,
      repeated: repeated.map(([n, k]) => `#${n} ×${k}`).join(', ') })

    // ISRC on different songs
    const byIsrc = new Map()
    for (const s of list) { const i = isrcOf(s.isrc); if (i && !JUNK.test(i)) (byIsrc.get(i) || byIsrc.set(i, []).get(i)).push(s) }
    for (const [, g] of byIsrc) {
      if (g.length < 2) continue
      const bases = g.map((s) => baseTitle(s.title))
      if (bases.some((a) => bases.some((b) => !sameSong(a, b))))
        for (const s of g) push('isrc-shared', songRow(s, { titles_on_this_isrc: g.map((x) => x.title).join('  |  ') }))
    }

    // Duplicates: union by ISRC or base title, then split by version.
    const parent = list.map((_, i) => i)
    const root = (i) => parent[i] === i ? i : (parent[i] = root(parent[i]))
    const seen = new Map()
    const bases = list.map((s) => baseTitle(s.title))
    list.forEach((s, i) => {
      const b = bases[i]
      for (const k of [isrcOf(s.isrc) && 'i:' + isrcOf(s.isrc), b && !PLACEHOLDER.test(b) && 't:' + b].filter(Boolean)) {
        if (seen.has(k)) parent[root(i)] = root(seen.get(k)); else seen.set(k, i)
      }
    })
    // A copy with no ISRC and a one-letter slip ("Chim Chim Cherree") only meets
    // its twin on a near-identical title. Pairwise, so skipped on huge catalogues.
    if (list.length <= 400) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (root(i) === root(j) || !bases[i] || !bases[j] || PLACEHOLDER.test(bases[i])) continue
        if (sameSong(bases[i], bases[j])) parent[root(i)] = root(j)
      }
    }
    const groups = new Map()
    list.forEach((s, i) => (groups.get(root(i)) || groups.set(root(i), []).get(root(i))).push(s))
    let dupPairs = 0, dupSongs = 0, extra = 0
    const dupRows = []
    for (const g of groups.values()) {
      if (g.length < 2) continue
      const byVer = new Map()
      for (const s of g) { const v = versionOf(s); (byVer.get(v) || byVer.set(v, []).get(v)).push(s) }
      for (const sg of byVer.values()) {
        if (sg.length < 2) continue
        const isrcs = sg.map((s) => isrcOf(s.isrc))
        const lens = sg.map((s) => secs(s.duration)).filter((x) => x !== null)
        const spread = lens.length > 1 ? Math.max(...lens) - Math.min(...lens) : 0
        const bases = sg.map((s) => baseTitle(s.title))
        const quals = sg.map(qualifierOf).filter(Boolean)
        const differentSongs = bases.some((a) => bases.some((b) => !sameSong(a, b)))
        const distinctIsrcs = isrcs.every(Boolean) && new Set(isrcs).size === isrcs.length
        const artists = new Set(sg.map((s) => fold(s.artist)).filter(Boolean))
        if (differentSongs || spread > 5 || distinctIsrcs || (quals.length === sg.length && new Set(quals).size > 1) || artists.size > 1) continue
        extra += sg.length - 1; dupSongs += sg.length
        if (sg.length === 2) dupPairs++
        for (const s of sg) dupRows.push(songRow(s, { group: `${cat} · ${sg[0].title}`, audio: s.audio ? 'yes' : '' }))
      }
    }
    for (const r of dupRows) push('duplicate-songs', r)
    res.get('duplicate-songs').extra = (res.get('duplicate-songs').extra || 0) + extra
    if (dupSongs === list.length && dupPairs * 2 === list.length)
      push('album-doubled', { catalogue: cat, album: albumsByCat.get(cat)?.[0]?.title || '', songs: list.length })
  }

  await singlesVsAlbums(byCat, albumsByCat, push)
  onProgress(byCat.size, byCat.size)

  return { total: songs.length, albums: albums.length, results: res }
}

// ── Cached sweep + API helpers ───────────────────────────────────────────────
let _snap = null, _analysis = null, _building = null, _progress = null

function summaryFrom() {
  const counts = (code) => code === 'duplicate-songs' ? (_analysis.results.get(code).extra || 0) : _analysis.results.get(code).length
  const denom = (unit) => unit === 'songs' || unit === 'extra copies' ? _analysis.total : unit === 'albums' ? _analysis.albums : null
  return {
    ok: true, builtAt: _snap.builtAt, tookMs: _snap.tookMs, total: _analysis.total, albums: _analysis.albums,
    cacheLoaded: _snap.cacheLoaded,
    checks: CHECKS.map((c) => {
      if (!_snap.cacheLoaded && c.group === 'Against the Cache') return { ...c, error: 'the metadata cache was still loading when MAM was read — press Refresh' }
      const n = counts(c.code), d = denom(c.unit)
      return { code: c.code, label: c.label, why: c.why, severity: c.severity, group: c.group, unit: c.unit, count: n, pct: d ? +(n / d * 100).toFixed(1) : null }
    }),
  }
}

/**
 * The sweep reads 126k songs and 16k albums — two minutes or so — so a cold
 * call starts it and answers `{ building: true }` for the page to poll.
 */
export async function getMamHealthSummary({ refresh = false } = {}) {
  if (!HOST()) return { ok: false, reason: 'GALLO_FM_HOST is not set, so MAM cannot be read.' }
  // While a Refresh is running, every poll must say so — answering with the
  // old result alone made the page stop polling, so Refresh looked dead and
  // the new numbers only appeared after a server restart (Ian, 2026-10-20).
  if (_snap && !refresh) return _building ? { ...summaryFrom(), refreshing: true, progress: _progress } : summaryFrom()
  if (!_building) {
    const t0 = Date.now()
    _progress = { songs: 0, songsTotal: null, albums: 0, albumsTotal: null }
    // The Cache checks are worked out while MAM is read, so a sweep started in
    // the first minutes after a deploy (cache still loading) would leave them
    // empty until the next Refresh. Wait for the load — it is shared, not repeated.
    _building = (cacheStatus().loaded ? Promise.resolve() : (_progress.cache = 'loading', loadMetadata()))
      .then(() => { delete _progress.cache; return readMam((layout, n, total) => {
      if (layout === SONGS_LAYOUT()) { _progress.songs = n; _progress.songsTotal = total } else { _progress.albums = n; _progress.albumsTotal = total }
    }) })
      .then(async (snap) => {
        const next = { ...snap, builtAt: Date.now(), tookMs: Date.now() - t0 }
        const t1 = Date.now()
        _progress.checking = { done: 0, total: null }
        const analysis = await analyse(next, lookupAlbumTracks, (d, t) => { _progress.checking = { done: d, total: t } })
        _snap = next; _analysis = analysis          // swapped together, so a poll never sees half
        console.log(`[mam-health] read ${snap.songs.length} songs, ${snap.albums.length} albums in ${((t1 - t0) / 1000).toFixed(0)}s, checked in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
      })
      .catch((e) => { console.error('[mam-health] sweep failed:', e?.message); throw e })
      .finally(() => { _building = null })
    _building.catch(() => {})
  }
  if (_snap) return { ...summaryFrom(), refreshing: true, progress: _progress }
  return { ok: false, building: true, progress: _progress, reason: 'Reading MAM — about two minutes.' }
}

export function getMamHealthRecords(code, { limit = 500, offset = 0 } = {}) {
  if (!_analysis) return { ok: false, reason: 'No sweep yet — open the summary first.' }
  const check = CHECKS.find((c) => c.code === code)
  if (!check) return { ok: false, reason: `unknown check "${code}"` }
  const all = _analysis.results.get(code)
  const lim = Math.min(Math.max(1, Number(limit) || 500), RECORD_CAP)
  const off = Math.max(0, Number(offset) || 0)
  const rows = all.slice(off, off + lim)
  return { ok: true, code, label: check.label, why: check.why, severity: check.severity,
    rows, offset: off, limit: lim, total: all.length, hasMore: off + lim < all.length,
    columns: rows.length ? Object.keys(rows[0]) : [] }
}

/** Every song of one catalogue, in track order, from the last sweep. */
export function getMamCatalogueRecords(cat) {
  if (!_snap) return { ok: false, reason: 'No sweep yet.' }
  const c = S(cat)
  if (!c) return { ok: false, reason: 'catalogue required' }
  const rows = _snap.songs.filter((s) => s.cat === c)
    .sort((a, b) => (Number(a.seq) || 9999) - (Number(b.seq) || 9999) || a.title.localeCompare(b.title))
    .map((s) => songRow(s, { version: s.version, audio: s.audio ? 'yes' : '' }))
  const album = _snap.albums.filter((a) => a.cat === c)
  return { ok: true, catalogue: c, album: album.map((a) => `${a.title} — ${a.artist}`).join('  |  '), rows,
    columns: rows.length ? Object.keys(rows[0]) : [] }
}
