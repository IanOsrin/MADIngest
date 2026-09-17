/**
 * lib/mam-cache-fill.js — fill a MAM album's blanks from the metadata cache.
 *
 * MAM was merged from the three FileMaker databases (Catalogue, CMS,
 * MadStreamer). The metadata cache — the Ingrooves extract plus the Alex ISRC
 * register — was never one of its sources, so albums that came in as
 * `Sources=cat` routinely have no ISRC, no barcode, no publisher, even though
 * the cache holds all of it. SMCD 185 (Henry Ate) is the case that surfaced it.
 *
 * Two rules, the same ones the audio linker follows:
 *
 *  1. Fill EMPTY fields only. Never overwrite a value already in MAM — the
 *     cache is a good source, not an authority, and re-pointing existing data
 *     is a different decision from filling a gap.
 *  2. Match on normalised TITLE, never on position. Cache rows and MAM tracks
 *     do not agree on numbering (SMCD 185's cache is missing "Hey Mister"
 *     entirely, so every row after it is off by one).
 *
 * Near-miss titles are reported as SUGGESTIONS with their score and never
 * applied automatically: "Eudiamonia"/"Eudaimonia" and "Station Beach"/"Station
 * Bench" are real spelling drift, but so is a genuinely different song.
 */
import { mamComposerFields } from './credits.js'
import { lookupAlbumTracks, getStatus, findCatalogueVariants } from './metadata-cache.js'
import { mamSession, findMamAlbum } from './fm-mam-write.js'
import { languageParts } from './language-codes.js'
import { sameValue } from './mam-streamer-sync.js'

const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

const has = v => String(v ?? '').trim() !== ''

/** Dice coefficient on bigrams — cheap, and forgiving of one-letter drift. */
function similarity(a, b) {
  a = tn(a); b = tn(b)
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1) } return g }
  const ga = grams(a), gb = grams(b)
  let hit = 0
  for (const [k, n] of ga) hit += Math.min(n, gb.get(k) || 0)
  const total = [...ga.values()].reduce((x, y) => x + y, 0) + [...gb.values()].reduce((x, y) => x + y, 0)
  return total ? (2 * hit) / total : 0
}

/** Excel-ish "7/15/1996" and ISO both appear in the cache. */
function isoDate(v) {
  const s = String(v || '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

/** Cache credits carry role tags — "Henry Ate <Lyricist>, Henry Ate <Composer>". */
const stripTags = v => {
  const names = String(v || '').split(/\s*,\s*/)
    .map(x => x.replace(/<[^>]*>/g, '').trim()).filter(Boolean)
  return [...new Set(names)].join('; ') || null
}

const nn = v => {
  const s = String(v ?? '').trim()
  return (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') ? null : s
}

/** Fields a cache row can contribute to a MAM song. */
function songFillsFrom(c) {
  const lang = languageParts(nn(c.language) || nn(c.audio_language))
  return {
    'Track Artist': nn(c.track_artist),
    // The cache calls it `seq` (the '#' column). Reading sequence_no here found
    // nothing, so sequence numbers were never filled or offered (2026-09-15).
    'Sequence Number': nn(c.seq),
    'Track Number': nn(c.seq),
    'ISRC': nn(c.isrc),
    'Genre': nn(c.genre),
    'Duration': nn(c.duration),
    // Composers is filled as the cache holds it, role tags kept; the numbered
    // slots get one plain name each and are left out when there is no name.
    ...Object.fromEntries(Object.entries(mamComposerFields(nn(c.composer), { clearUnused: false }))
      .map(([k, v]) => [k, v || null])),
    'Producers': stripTags(c.producer),
    'Producer': stripTags(c.producer),
    'Publishers': stripTags(c.publisher),
    'Language': lang.name,
    'Language Code': lang.code,
    'pLine': nn(c.p_line),
    'cLine': nn(c.c_line),
    'Rights Territories': nn(c.rights_territories),
    'Original Release Date': isoDate(c.original_release_date) || isoDate(c.release_date),
    'Featured Artist': nn(c.featured_artist),
    'Lyrical Content Rating': /^y/i.test(String(c.parental || '')) ? 'Explicit' : null,
  }
}

function albumFillsFrom(c) {
  return {
    'UPC': nn(c.barcode),
    'Label': nn(c.label),
    'Genre': nn(c.genre),
    'Release Date': isoDate(c.release_date),
    'Year of Release': (isoDate(c.original_release_date) || isoDate(c.release_date) || '').slice(0, 4) || null,
    'Album Title': nn(c.album_title),
    'Album Artist': nn(c.album_artist),
  }
}

/** Keep only the fields that are actually blank on the record right now. */
const gapsOnly = (fills, fieldData) => Object.fromEntries(
  Object.entries(fills).filter(([k, v]) => v !== null && v !== undefined && !has(fieldData[k])))

/**
 * Fields where MAM and the cache BOTH have a value and the values disagree.
 *
 * Deliberately separate from the fills: filling a blank is safe and can be
 * batched, while replacing a value someone may have entered by hand is a
 * per-field judgement. These are reported so the caller can show both sides;
 * nothing here is ever applied without the field being named explicitly.
 *
 * Compared loosely — a difference of case, spacing or punctuation is drift in
 * how the two systems write the same thing, not a correction worth offering.
 *
 * Credits are compared AFTER the same tag-stripping the cache side already
 * went through in songFillsFrom. The cache stores the Ingrooves string verbatim
 * ("Pieter W. Grobbelaar <Lyricist>, Pieter W. Grobbelaar <Composer>" on
 * TGE 90) and tn() strips (…) and […] but not <…>, so an untreated MAM side
 * normalised to "…grobbelaar lyricist…" and every such album reported a
 * standing composer conflict against a value identical to its own. Left alone,
 * someone eventually ticks one and overwrites a good value with a reformat of
 * itself. The MAM side is still REPORTED raw — the operator should see what is
 * actually in the field.
 */
const CREDIT_FIELDS = new Set(['Composers', 'Composer', 'Composer 2', 'Composer 3', 'Composer 4', 'Producers', 'Producer', 'Publishers'])
const creditNorm = (k, v) => CREDIT_FIELDS.has(k) ? (stripTags(v) || v) : v

const conflictsWith = (fills, fieldData) => Object.fromEntries(
  Object.entries(fills)
    .filter(([k, v]) => v !== null && v !== undefined && has(fieldData[k]))
    .filter(([k, v]) => {
      // Both sides through the same tag-stripping: the Composers fill now
      // carries the role tags as supplied, so stripping only MAM's side would
      // flag identical values.
      const mam = creditNorm(k, fieldData[k])
      const cache = creditNorm(k, v)
      return tn(cache) !== tn(mam) && !sameValue(cache, mam)                                 // 0:02:28 = 00:02:28
    })
    .map(([k, v]) => [k, { mam: String(fieldData[k]).trim(), cache: v }]))

/**
 * Plan the fill. Writes nothing.
 *
 * @param {string} catalogue
 * @param {object} [opts]
 * @param {number} [opts.suggestAbove]  score at which a near-miss is offered (default 0.60)
 *
 * The bar is deliberately low. A suggestion is never applied without an
 * explicit accept, so hiding a real match costs more than showing a doubtful
 * one: at 0.72, "Eudiamonia"/"Eudaimonia" (0.67) was silently dropped even
 * though it is plainly the same song.
 */
export async function planCacheFill(catalogue, { suggestAbove = 0.60, cacheCatalogue = '' } = {}) {
  const cat = String(catalogue || '').trim()
  if (!cat) throw Object.assign(new Error('catalogue is required'), { status: 400 })

  // A cold server answers every lookup with nothing. Without this the preview
  // reports "0 fields to fill", which reads as "this album needs nothing" —
  // a wrong answer dressed as a real one. Seen on Render right after a deploy,
  // where the S3 store takes ~2m to load.
  const cache = getStatus()
  if (!cache.loaded) {
    throw Object.assign(new Error('Metadata cache is still loading — try again in a moment'), { status: 503 })
  }

  // The cache may file this album under a different catalogue variant — MAM's
  // CDGMP 1004 is GMP 1004D in the cache. cacheCatalogue lets the caller read
  // from a variant the USER has confirmed; nothing is adopted automatically,
  // because CDGMP 1823 and GMP 1823 normalise alike and are different albums.
  const readCat   = String(cacheCatalogue || '').trim() || cat
  const cacheRows = lookupAlbumTracks(readCat) || []
  // Only offer alternatives when the exact catalogue genuinely has nothing;
  // suggesting one alongside real rows would just invite a wrong switch.
  const catalogueSuggestions = (!cacheRows.length && !cacheCatalogue)
    ? findCatalogueVariants(cat) : []
  const db = await mamSession()
  try {
    const album = await findMamAlbum(db, cat)
    if (!album) throw Object.assign(new Error(`No album ${cat} in Music Arena Master`), { status: 404 })
    const songs = await db.find('Songs', [{ 'Album Catalogue': '==' + cat }], 500)

    // Sequence numbers are only offered when the cache's look like a track
    // order. 235 albums carry something else — GALP 1065 has 938…949, a running
    // row number — and writing those would scramble the album.
    const seqs = cacheRows.map(r => Number(r.seq))
    const seqOk = cacheRows.length > 0 && seqs.every(n => Number.isInteger(n) && n >= 1 && n <= cacheRows.length * 2)
      && new Set(seqs).size === seqs.length
    const seqNote = cacheRows.length && !seqOk && cacheRows.some(r => r.seq != null)
      ? `Sequence numbers in the cache don't look like a track order (${cacheRows.slice(0, 4).map(r => r.seq ?? '—').join(', ')}…) — not offered.`
      : null
    // No numbers at all (1,596 cache albums, e.g. UNA 1544): the rows' own order
    // is usually the track order — CMS 2024 lists UNA 1544 the same way — but
    // nothing states it. So it is OFFERED per song, labelled as row order, and
    // never filled on its own. Not when titles repeat: a doubled album
    // (GALP 1065 has every track twice) has no single row order to trust.
    const noSeqAtAll = cacheRows.length > 0 && cacheRows.every(r => r.seq == null)
    const rowOrderOk = noSeqAtAll && new Set(cacheRows.map(r => tn(r.track_name))).size === cacheRows.length
    const rowPos = new Map(rowOrderOk ? cacheRows.map((r, i) => [r, i + 1]) : [])
    const rowOrderOffer = (row, g) => {
      const n = rowPos.get(row)
      if (!n || sameValue(n, g['Sequence Number'])) return {}
      const mam = String(g['Sequence Number'] ?? '').trim() || '(blank)'
      return { 'Sequence Number': { mam, cache: String(n), fromRowOrder: true } }
    }
    const rowNote = rowOrderOk
      ? 'The cache has no track numbers for this album. Its row order is offered as Sequence Number below — check it against the sleeve before ticking.'
      : null

    const rowFills = r => {
      const f = songFillsFrom(r)
      if (!seqOk) { delete f['Sequence Number']; delete f['Track Number'] }
      return f
    }

    const byTitle = new Map()
    for (const r of cacheRows) {
      const k = tn(r.track_name)
      if (k && !byTitle.has(k)) byTitle.set(k, r)
    }

    const used = new Set()
    const tracks = [], suggestions = []
    for (const s of songs) {
      const g = s.fieldData
      const exact = byTitle.get(tn(g['Track Name']))
      if (exact) {
        used.add(tn(exact.track_name))
        const all   = rowFills(exact)
        const fills = gapsOnly(all, g)
        const conflicts = { ...conflictsWith(all, g), ...rowOrderOffer(exact, g) }
        tracks.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                      matched: exact.track_name, score: 1,
                      fills, fillCount: Object.keys(fills).length,
                      conflicts, conflictCount: Object.keys(conflicts).length })
        continue
      }
      // No exact title — offer the best near miss for a human to rule on.
      let best = null, bestScore = 0
      for (const r of cacheRows) {
        if (used.has(tn(r.track_name))) continue
        const sc = similarity(g['Track Name'], r.track_name)
        if (sc > bestScore) { bestScore = sc; best = r }
      }
      if (best && bestScore >= suggestAbove) {
        const all   = rowFills(best)
        const fills = gapsOnly(all, g)
        // A near miss is exactly where MAM's title and the cache's differ, so
        // the cache's title is offered as a replacement like any other value.
        // Never for an exact match: those were paired BY title, so a rename
        // there could only be case or spacing.
        const conflicts = { ...conflictsWith({ 'Track Name': nn(best.track_name), ...all }, g), ...rowOrderOffer(best, g) }
        suggestions.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                           matched: best.track_name, score: Math.round(bestScore * 100) / 100,
                           fills, fillCount: Object.keys(fills).length,
                           conflicts, conflictCount: Object.keys(conflicts).length })
      } else {
        tracks.push({ recordId: s.recordId, seq: g['Sequence Number'], title: g['Track Name'],
                      matched: null, score: 0, fills: {}, fillCount: 0,
                      conflicts: {}, conflictCount: 0 })
      }
    }

    const albumFillsAll  = cacheRows.length ? albumFillsFrom(cacheRows[0]) : {}
    const albumFills     = gapsOnly(albumFillsAll, album.fieldData)
    const albumConflicts = conflictsWith(albumFillsAll, album.fieldData)
    // Distinguish "the cache has nothing for this catalogue" from "everything is
    // already filled" — they look identical in a total of zero.
    const note = seqNote || rowNote || (!cacheRows.length
      ? `The metadata cache has no rows for ${cat} (${cache.count.toLocaleString()} rows searched)` +
        (catalogueSuggestions.length
          ? ` — but ${catalogueSuggestions.length} similar catalogue(s) exist; check the album title before using one.`
          : '')
      : null)

    return {
      catalogue: cat,
      // Which catalogue the cache rows were actually read from — equal to
      // `catalogue` unless the user chose a variant.
      readCatalogue: readCat,
      catalogueSuggestions,
      note,
      cacheLoaded: cache.count,
      album: { recordId: album.recordId, albumID: album.fieldData.AlbumID,
               title: album.fieldData['Album Title'], artist: album.fieldData['Album Artist'],
               fills: albumFills, fillCount: Object.keys(albumFills).length,
               conflicts: albumConflicts, conflictCount: Object.keys(albumConflicts).length },
      cacheRows: cacheRows.length,
      songs: songs.length,
      tracks,
      suggestions,
      // Cache tracks MAM has no song for. The full row travels with each one so
      // the caller can create the track from it without re-reading the cache.
      missingSongs: cacheRows
        .filter(r => !used.has(tn(r.track_name)))
        .filter(r => !suggestions.some(sg => sg.matched === r.track_name))
        .map(r => ({
          title:  r.track_name,
          artist: nn(r.track_artist) || nn(r.album_artist),
          seq:    seqOk ? nn(r.seq) : null,
          isrc:   nn(r.isrc),
          fills:  Object.fromEntries(Object.entries(rowFills(r)).filter(([, v]) => v !== null)),
        })),
      // Kept for the Excel tab, which reads titles only.
      unusedCacheRows: cacheRows.filter(r => !used.has(tn(r.track_name)))
        .map(r => r.track_name).filter(t => !suggestions.some(sg => sg.matched === t)),
      totalFills: Object.keys(albumFills).length + tracks.reduce((n, t) => n + t.fillCount, 0),
      totalConflicts: Object.keys(albumConflicts).length + tracks.reduce((n, t) => n + t.conflictCount, 0),
    }
  } finally { await db.logout() }
}

/**
 * Apply a plan. `acceptSuggestions` is a list of recordIds the caller has
 * explicitly approved — suggestions are never applied without one.
 */
/**
 * Apply a plan.
 *
 * @param {string} catalogue
 * @param {object} [opts]
 * @param {string[]} [opts.acceptSuggestions]  recordIds whose near-miss match is approved
 * @param {object}   [opts.acceptConflicts]    { recordId|'album': ['Field', ...] } — the
 *                                             ONLY route by which an existing value is
 *                                             replaced. A field absent here is left alone.
 * @param {boolean}  [opts.skipFills]          apply only the approved conflicts
 */
export async function applyCacheFill(catalogue, { acceptSuggestions = [], acceptConflicts = {}, skipFills = false, cacheCatalogue = '' } = {}) {
  // Re-plan with the same cache catalogue the user was shown, or the apply
  // would read different rows from the ones they approved.
  const plan = await planCacheFill(catalogue, { cacheCatalogue })
  const accept = new Set(acceptSuggestions.map(String))

  // Approved overwrites, per record. Filling a blank and replacing a value are
  // different decisions, so they stay separate all the way to the patch: a
  // field only overwrites if the caller named it.
  const okConflicts = (key, conflicts) => {
    const wanted = acceptConflicts[String(key)]
    if (!Array.isArray(wanted) || !wanted.length) return {}
    const out = Object.fromEntries(
      Object.entries(conflicts || {})
        .filter(([f]) => wanted.includes(f))
        .map(([f, v]) => [f, v.cache]))
    // A row-order sequence number is the track number too.
    if (out['Sequence Number'] && conflicts['Sequence Number']?.fromRowOrder) out['Track Number'] = out['Sequence Number']
    return out
  }

  const db = await mamSession()
  try {
    const result = { catalogue, albumUpdated: false, tracksUpdated: 0,
                     fieldsWritten: 0, fieldsOverwritten: 0, failures: [],
                     written: { album: [], songs: {} } }   // MAM field names, for the MADStreamer sync

    const albumOver = okConflicts('album', plan.album.conflicts)
    const albumData = { ...(skipFills ? {} : plan.album.fills), ...albumOver }
    if (Object.keys(albumData).length) {
      try {
        await db.patch('Albums', plan.album.recordId, albumData)
        result.albumUpdated = true
        result.written.album = Object.keys(albumData)
        result.fieldsWritten     += skipFills ? 0 : plan.album.fillCount
        result.fieldsOverwritten += Object.keys(albumOver).length
      } catch (e) { result.failures.push({ what: 'album', error: e.message }) }
    }

    // A near miss takes part when its match was accepted, or when one of its
    // values was ticked for replacement (ticking "rename to the cache's title"
    // is itself a judgement that they are the same song). Its blanks are only
    // filled when the match itself was accepted.
    const candidates = [
      ...plan.tracks.map(t => ({ ...t, fillsOk: true })),
      ...plan.suggestions
        .filter(t => accept.has(String(t.recordId)) || (acceptConflicts[String(t.recordId)] || []).length)
        .map(t => ({ ...t, fillsOk: accept.has(String(t.recordId)) })),
    ]
    for (const t of candidates) {
      const over = okConflicts(t.recordId, t.conflicts)
      const fills = (skipFills || !t.fillsOk) ? {} : t.fills
      const data = { ...fills, ...over }
      if (!Object.keys(data).length) continue
      try {
        await db.patch('Songs', t.recordId, data)
        result.tracksUpdated++
        result.written.songs[String(t.recordId)] = Object.keys(data)
        result.fieldsWritten     += Object.keys(fills).length
        result.fieldsOverwritten += Object.keys(over).length
      } catch (e) { result.failures.push({ what: t.title, error: e.message }) }
    }
    return { ...result, plan }
  } finally { await db.logout() }
}

/**
 * Create one song the cache has and MAM does not.
 *
 * Driven from a plan's `missingSongs`, one at a time and by title: a whole
 * album's worth of gaps is usually a genuine shortfall, but a single one is
 * just as often a title the matcher could not pair up, and creating that
 * duplicates a track that is already there. So the caller names the title, and
 * this refuses if MAM has since gained a song matching it.
 *
 * MasterID / RecordingID come from the allocator rather than being invented
 * here, so the series stays contiguous with Fill MAM's own.
 */
export async function addMissingSong(catalogue, title, { cacheCatalogue = '' } = {}) {
  const cat = String(catalogue || '').trim()
  const want = tn(title)
  if (!cat || !want) throw Object.assign(new Error('catalogue and title are required'), { status: 400 })

  const plan = await planCacheFill(cat, { cacheCatalogue })
  const row = (plan.missingSongs || []).find(m => tn(m.title) === want)
  if (!row) {
    throw Object.assign(
      new Error(`"${title}" is not missing from ${cat} — it may have been added already, or matched a track since`),
      { status: 409 })
  }

  const { mamSession: session, findMamAlbum: findAlbum, makeIdAllocator, createMamSong } =
    await import('./fm-mam-write.js')
  const db = await session()
  try {
    const album = await findAlbum(db, cat)
    if (!album) throw Object.assign(new Error(`No album ${cat} in Music Arena Master`), { status: 404 })
    const ids = await makeIdAllocator(db)
    const created = await createMamSong(db, {
      master_id:    ids.nextMaster(),
      recording_id: ids.nextRecording(),
      album_id:     album.fieldData?.['AlbumID'] ?? album['AlbumID'],
      sources:      'MetadataCache',
      catalogue_no: cat,
      title:        row.title,
      artist:       row.artist,
      isrc:         row.isrc,
      sequence_no:  row.seq,
      ...Object.fromEntries(Object.entries({
        duration:              row.fills['Duration'],
        genre:                 row.fills['Genre'],
        language:              row.fills['Language'],
        language_code:         row.fills['Language Code'],
        composers:             row.fills['Composers'],
        producers:             row.fills['Producers'],
        publishers:            row.fills['Publishers'],
        parental:              row.fills['Lyrical Content Rating'],
        c_line:                row.fills['cLine'],
        p_line:                row.fills['pLine'],
        rights_territories:    row.fills['Rights Territories'],
        original_release_date: row.fills['Original Release Date'],
      }).filter(([, v]) => v !== null && v !== undefined)),
    })
    return { ok: true, catalogue: cat, title: row.title, recordId: created?.recordId || null }
  } finally { await db.logout?.() }
}
