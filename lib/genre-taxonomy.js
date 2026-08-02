/**
 * lib/genre-taxonomy.js — the ONE agreed genre vocabulary.
 *
 * MadStreamer's `Local Genre` field was normalised from 175 values to 45 on
 * 2026-07-31/08-01 (11,193 records rewritten). That clean-up is only durable if
 * nothing upstream can push a retired value back in — and the Gallo→MadStreamer
 * sync writes `Local Genre` directly (toSongFieldData / toAlbumFieldData), so one
 * sync of a stale Gallo record would reintroduce it. The metadata cache alone
 * still holds 9,772 rows of `Afro-folk`, a spelling we retired.
 *
 * So everything writing a genre downstream goes through normalizeGenre().
 * Unknown values return null and the caller SKIPS the write rather than
 * inventing one — better a missing genre (it lands in the repair queue) than a
 * wrong one, or a fresh variant spelling in a field we just cleaned.
 *
 * Adding a genre is deliberate: add it to CANONICAL_GENRES here AND to the
 * FileMaker value list. Never widen this by accepting whatever arrives.
 */

export const CANONICAL_GENRES = Object.freeze([
  "African",
  "African Traditional",
  "Afro Beat",
  "Afro Folk",
  "Afro Jazz",
  "Afro Pop",
  "Afro Soul",
  "Amapiano",
  "Blues",
  "Boere Musiek",
  "Bubblegum",
  "Cape Jazz",
  "Children's Music",
  "Christmas",
  "Classical",
  "Country",
  "Dance & Electronic",
  "Easy Listening",
  "Folk",
  "Funk & Disco",
  "General",
  "Gospel",
  "Gqom",
  "Hip-Hop",
  "Instrumental",
  "Isicathamiya",
  "Jazz",
  "Kwaito",
  "Kwela",
  "Latin",
  "Marabi",
  "Maskandi",
  "Mbaqanga",
  "Oldies",
  "Pop",
  "Reggae",
  "Rock",
  "Soul & R&B",
  "Soundtrack",
  "Spoken Word",
  "Township Jive",
  "Traditional",
  "Tsonga Disco",
  "Vocal",
  "Volksmusik",
  "World",
])

// Catch-alls: real values, but not scenes. The team repairs these via the Genre
// Fix tab; they are excluded from scene-style browsing.
export const CATCH_ALL_GENRES = Object.freeze([
  'Instrumental', 'Oldies', 'African', 'World', 'Traditional', 'Vocal', 'General'
])

/** Retired spelling → canonical. Resolved transitively at build time. */
export const GENRE_ALIASES = Object.freeze({
  "Swing Jazz": "Jazz",
  "African Reggae": "Reggae",
  "Adult": "Pop",
  "Afro-folk": "Afro Folk",
  "instrumental": "Instrumental",
  "BoereMusiek": "Boere Musiek",
  "Afro-Pop": "Afro Pop",
  "Afropop": "Afro Pop",
  "Hip Hop": "Hip-Hop",
  "Pop Rap/Hip-Hop": "Hip-Hop",
  "R & B/Soul": "Soul & R&B",
  "Childrens Music": "Children's Music",
  "Afro Fusion": "Afro Pop",
  "Adult Contemporary (Singer/Songwriter": "Pop",
  "Oldied": "Oldies",
  "Mbhaqnga": "Mbaqanga",
  "80'": "General",
  "Afro Dancehall": "African Traditional",
  "50's": "Oldies",
  "50s": "Oldies",
  "60's": "Oldies",
  "60s": "Oldies",
  "70's": "Oldies",
  "Latin Music": "Latin",
  "Mbhaqanga": "Mbaqanga",
  "Afro-fusion": "Afro Pop",
  "Afro Rock": "Afro Beat",
  "African Jazz": "Afro Jazz",
  "Sax Jive": "Township Jive",
  "Accordian Jive": "Township Jive",
  "Mgqashiyo": "Township Jive",
  "Jive 80s": "Township Jive",
  "Isichathamiya": "Isicathamiya",
  "Is'cathamiya": "Isicathamiya",
  "Motswako": "Kwaito",
  "Afro House": "Amapiano",
  "Afro Tech": "Amapiano",
  "Shangaan Disco": "Tsonga Disco",
  "Langarm": "Boere Musiek",
  "Basotho Traditional": "African Traditional",
  "Ndebele Traditional": "African Traditional",
  "Tsonga Traditional": "African Traditional",
  "Mbira": "African Traditional",
  "High Life": "African Traditional",
  "Soukous": "African Traditional",
  "Rhumba": "African Traditional",
  "Tuku Music": "African Traditional",
  "Mancala": "African Traditional",
  "Lekompo": "African Traditional",
  "African Dancehall": "African Traditional",
  "Kizomba": "African Traditional",
  "Christian": "Gospel",
  "Spiritual": "Gospel",
  "Devotional": "Gospel",
  "Inspirational": "Gospel",
  "Choir": "Gospel",
  "Choral": "Gospel",
  "Jazz (Contemporary)": "Jazz",
  "Jazz (Traditional)": "Jazz",
  "Traditional Jazz": "Jazz",
  "Cool Jazz": "Jazz",
  "Free Jazz": "Jazz",
  "Jazz Fusion": "Jazz",
  "Smooth Jazz": "Jazz",
  "Vocal Jazz": "Jazz",
  "Soul-Jazz": "Jazz",
  "Brazilian Jazz": "Jazz",
  "Big Band": "Jazz",
  "Swing": "Jazz",
  "Swing Music": "Jazz",
  "Pop Rock": "Pop",
  "Brit Pop": "Pop",
  "Electro Pop": "Pop",
  "Pop Dance": "Pop",
  "Pop (Singer/Songwriter)": "Pop",
  "Singer/Songwriter": "Pop",
  "Adult Contemporary": "Pop",
  "Adult Contemporary (Singer/Songwriter)": "Pop",
  "Anthem": "Pop",
  "Twist": "Pop",
  "Hard Rock": "Rock",
  "Classic Rock": "Rock",
  "Prog Rock": "Rock",
  "Indie Rock": "Rock",
  "Country Rock": "Rock",
  "Rockabilly": "Rock",
  "New Wave": "Rock",
  "Alternative": "Rock",
  "Dance-Rock": "Rock",
  "R&B/Soul": "Soul & R&B",
  "Soul": "Soul & R&B",
  "R&B": "Soul & R&B",
  "RnB": "Soul & R&B",
  "Classic Soul": "Soul & R&B",
  "TrapSoul": "Soul & R&B",
  "Funk": "Funk & Disco",
  "Disco": "Funk & Disco",
  "Rap": "Hip-Hop",
  "Rap/Hip-Hop": "Hip-Hop",
  "Trap": "Hip-Hop",
  "Dancehall": "Reggae",
  "Reggaeton": "Reggae",
  "Country (Traditional)": "Country",
  "Country (Contemporary)": "Country",
  "Dance": "Dance & Electronic",
  "House": "Dance & Electronic",
  "Electronic": "Dance & Electronic",
  "Electronic Dance": "Dance & Electronic",
  "EDM": "Dance & Electronic",
  "Electro": "Dance & Electronic",
  "Funky House": "Dance & Electronic",
  "Chillout": "Dance & Electronic",
  "New Age": "Dance & Electronic",
  "Modern Classical": "Classical",
  "Folk (Singer/Songwriter)": "Folk",
  "Acoustic": "Folk",
  "Children": "Children's Music",
  "Childrens": "Children's Music",
  "Kids": "Children's Music",
  "Classic Lounge": "Easy Listening",
  "Mambo": "Easy Listening",
  "Soundtracks": "Soundtrack",
  "Film Scores": "Soundtrack",
  "Musicals": "Soundtrack",
  "Music Feature Films": "Soundtrack",
  "Comedy": "Spoken Word",
  "Drama": "Spoken Word",
  "Jewish": "Spoken Word",
  "Oldie": "Oldies",
  "World Music": "World",
  "Acapella": "Vocal",
  "Other": "General",
  "Live": "General",
  "Tune": "General",
  "Afrikaans": "General",
  "80's": "General"
})

const _canonSet = new Set(CANONICAL_GENRES)
const _lower = new Map()
for (const g of CANONICAL_GENRES) _lower.set(g.toLowerCase(), g)
for (const [from, to] of Object.entries(GENRE_ALIASES)) _lower.set(from.toLowerCase(), to)

/**
 * Map any incoming genre onto the agreed vocabulary.
 * @returns {string|null} canonical value, or null when unrecognised.
 */
export function normalizeGenre(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (_canonSet.has(raw)) return raw                 // already canonical
  return _lower.get(raw.toLowerCase()) ?? null       // alias / case variant
}

/** True when the value is one of the 45 (canonical, not an alias). */
export function isCanonicalGenre(value) {
  return _canonSet.has(String(value ?? '').trim())
}
