/**
 * lib/search-merge.js — merge cross-database search results into one row per song.
 *
 * Extracted from routes/ingest.js so the precedence rule can be tested. It was
 * previously inline and implicit in array order, with a first-writer-wins merge:
 * Gallo Catalogue ran first, so it silently won every field it had a value for
 * and an edit made in MadStreamer could NEVER show up in the Source tab. Ian
 * reported that as a caching problem on 2026-09-08 — nothing was cached, it was
 * just displaying a different database's value.
 */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Spelling variants of a catalogue-number-shaped search term. The FM databases
 * disagree about spacing ("HUL 40238" vs "HUL40238"), and a wildcard contains-
 * match cannot bridge that — so catalogue fields are OR-searched with every
 * variant. Non-catalogue terms (no digits) pass through unchanged.
 */
/**
 * Catalogue format prefixes. The same release carries a different code per
 * format — GMP 40715 on vinyl, CDGMP 40715 on CD, MCGMP 40715 on cassette —
 * and the databases disagree about which one an album is filed under.
 *
 * Order matters: longer codes first, so MC is not shortened to M.
 */
const CAT_FORMAT_PREFIXES = ['CASS', 'CDS', 'CD', 'MC', 'LP', 'K7']

/**
 * Search spellings for a catalogue number.
 *
 * Note the asymmetry these solve. Searching "GMP 40715" ALREADY finds
 * "CDGMP 40715", because the lanes match on substring and the short form is a
 * substring of the long one. The reverse is what fails: "CDGMP 40715" never
 * finds "GMP 40715". So the variant that earns its keep is the STRIPPED one.
 *
 * Widening a SEARCH only — never automatic record matching. CDGMP 1823
 * ("Nelson Mandela's Lifetime Tribute") and GMP 1823 ("Ziyangiluma Izinja")
 * are different albums, so a human still has to pick from the results.
 *
 * Leading zeros are deliberately preserved: in the GSP series CDGSP 006 and
 * CDGSP 6 are different releases ("On Stage" vs "Out Of Africa"), so
 * normalising them away would merge unrelated albums.
 */
export function catSearchVariants(term) {
  const t = String(term || '').trim()
  if (!t || !/\d/.test(t)) return [t].filter(Boolean)

  const out = [
    t,
    t.replace(/\s+/g, ''),                      // "HUL 40238" -> "HUL40238"
    t.replace(/^([A-Za-z]+)\s*(\d)/, '$1 $2'),  // "HUL40238"  -> "HUL 40238"
  ]

  // Drop a leading format code, if what remains still starts with letters —
  // "CDGMP 40715" -> "GMP 40715". Guarded so "CD 123" (a catalogue in its own
  // right) is not reduced to a bare number, which would match half the library.
  const m = t.match(/^([A-Za-z]+)(.*)$/)
  if (m) {
    const head = m[1].toUpperCase()
    for (const f of CAT_FORMAT_PREFIXES) {
      // At least two letters must survive: "CDS 5" reduced to "S 5" would match
      // a large slice of the library on a substring search.
      if (head.startsWith(f) && head.length - f.length >= 2) {
        const stripped = m[1].slice(f.length) + m[2]
        out.push(stripped, stripped.replace(/\s+/g, ''),
                 stripped.replace(/^([A-Za-z]+)\s*(\d)/, '$1 $2'))
        break
      }
    }
  }
  return [...new Set(out)].filter(Boolean)
}


/**
 * Which sources a request should query.
 *
 * @param {string} requestedCsv  the `sources` query param, may be absent/junk
 * @param {string[]} knownKeys   every source key that exists
 * @param {string[]} defaultOff  keys excluded when the caller doesn't choose
 *
 * Unknown keys are ignored rather than rejected, and a list that selects nothing
 * valid falls back to the default — a malformed param must never turn the search
 * into "no databases", which looks identical to "this track doesn't exist".
 */
export function selectSources(requestedCsv, knownKeys, defaultOff = []) {
  const known = new Set(knownKeys)
  const valid = String(requestedCsv || '')
    .split(',').map((s) => s.trim()).filter((k) => known.has(k))
  if (valid.length) return new Set(valid)
  const off = new Set(defaultOff)
  return new Set(knownKeys.filter((k) => !off.has(k)))
}

/**
 * @param {Array<{key:string,label:string,rank:number,tracks:Array}>} entries
 *        One per source that returned. `rank` is precedence — LOWER WINS.
 * @returns {Array} one row per song, sorted by breadth then artist/title.
 */
export function mergeSourceTracks(entries) {
  const merged = new Map()

  // Highest-precedence (lowest rank) non-empty value wins. `_rank` records which
  // rank supplied each field, so a weaker source can fill a blank but can never
  // overwrite a stronger source's value — regardless of what order sources
  // happen to finish in.
  const assign = (song, field, value, rank) => {
    const v = value || null
    if (!v) return
    if (song[field] == null || rank < song._rank[field]) {
      song[field] = v
      song._rank[field] = rank
    }
  }

  for (const src of entries) {
    for (const t of src.tracks || []) {
      const isrc = (t.isrc || '').trim().toUpperCase()
      // ISRC is the identity when present. Without one, title+artist is the only
      // handle we have — which means editing either of those in one database
      // splits the row rather than updating it. Nothing to do about that here;
      // it is a reason to get ISRCs allocated.
      const key = isrc || `t:${norm(t.title)}|a:${norm(t.artist_name)}`

      if (!merged.has(key)) {
        merged.set(key, {
          title: null, artist: null, album: null, catalogue_no: null,
          isrc:        isrc || null,
          sequence_no: t.sequence_no ?? null,
          sources:     [],
          _rank:       {},
        })
      }
      const song = merged.get(key)
      // Count how many of THIS source's records landed on this row. More than
      // one means that database has several records sharing an ISRC, and the
      // row the user sees is standing in for all of them. Surfacing the count
      // is the difference between "the tab lost my tracks" and "MadStreamer has
      // six songs carrying one ISRC" — the second is true, and actionable.
      // (GALP 1296 / Virginia Lee, 2026-09-08: 12 records, 7 distinct ISRCs.)
      const existing = song.sources.find((s) => s.db === src.label)
      if (existing) existing.count += 1
      else song.sources.push({ db: src.label, key: src.key, fm_record_id: t.fm_record_id || null, count: 1 })
      assign(song, 'title',        t.title,        src.rank)
      assign(song, 'artist',       t.artist_name,  src.rank)
      assign(song, 'album',        t.album_title,  src.rank)
      assign(song, 'catalogue_no', t.catalogue_no, src.rank)
      if (song.sequence_no == null && t.sequence_no != null) song.sequence_no = t.sequence_no
    }
  }

  return [...merged.values()]
    .map(({ _rank, ...song }) => song)
    .sort((a, b) =>
      (b.sources.length - a.sources.length) ||
      String(a.artist || '').localeCompare(String(b.artist || '')) ||
      String(a.title  || '').localeCompare(String(b.title  || '')))
}
