/**
 * lib/mam-streamer-sync.js — keep MADStreamer (the website) in step with MAM.
 *
 * MAM is where metadata is corrected; MADStreamer is what the site serves. Until
 * this existed an ISRC fixed in the MAM tab stayed wrong on the site forever.
 *
 * MATCHING. A MAM song and a MADStreamer song are the same track when they are
 * in the same catalogue AND carry the same Filename (the GMVn/GMVF audio name).
 * Checked 2026-09-14: Filename agreed on 53/53 tracks across 6 albums, ISRC only
 * 98%. Sequence number and title are never used — both are exactly what gets
 * corrected, and matching on them is how the duplicate-ISRC mess started. A
 * track with no Filename, or a Filename that appears twice on MADStreamer, is
 * reported and left alone rather than guessed at.
 *
 * WHAT MOVES. Song metadata (MAP_SONG from publish-album, the same mapping that
 * created these records) and the album fields every song row carries. The
 * Tape Files Master record gets the album's title/artist/date/genre/barcode.
 * Never synced: Filename and AudioHashSum (they identify the audio — changing
 * them is a republish, not an edit), catalogue numbers (the match key), S3_URL,
 * Visibility, covers (lib/album-cover.js owns those) and the AI_* analysis
 * fields, which MADStreamer computes itself.
 *
 * TWO MODES.
 *   - An explicit MAM tab edit syncs exactly the fields that were edited on
 *     exactly the records that were edited — blanks included, because clearing
 *     a wrong value is an edit too.
 *   - "Sync album" compares everything and, by default, only pushes values MAM
 *     actually has: a blank in MAM means "not filled in yet", not "delete".
 *
 * The site reads a nightly Postgres mirror of MADStreamer, so a synced change is
 * visible there after the ~01:00 UTC sync, not instantly.
 */
import { getMamAlbumRaw, getMamFieldData } from './fm-mam.js'
import {
  findRecordsByCatalogue, findTapeFileByCatalogue, getLayoutFields,
  updateStreamerRecord, updateTapeFileRecord,
} from './madstreamer.js'
import { MAP_SONG, MAP_ALBUM_ON_SONG } from './publish-album.js'

const NEVER_SYNC = new Set(['Filename', 'AudioHashSum'])

/** MAM Songs field → MADStreamer song field. */
export const SYNC_SONG_MAP = Object.freeze({
  ...Object.fromEntries(Object.entries(MAP_SONG).filter(([from]) => !NEVER_SYNC.has(from))),
  'Version': 'Version',
})
/** MAM Albums field → MADStreamer song field (album values repeated on every track). */
export const SYNC_ALBUM_ON_SONG_MAP = Object.freeze({ ...MAP_ALBUM_ON_SONG })
/** MAM Albums field → MADStreamer Tape Files Master field. */
export const SYNC_ALBUM_ON_TAPE_MAP = Object.freeze({
  'Album Title': 'Album Title', 'Album Artist': 'Album Artist',
  'Release Date': 'Release Date', 'Genre': 'Genre', 'UPC': 'Bar Code',
})

const text = v => (v == null ? '' : String(v).trim())

/**
 * Do two stored values mean the same thing? FileMaker hands numbers back as
 * numbers or strings depending on field type, and dates as MM/DD/YYYY or ISO
 * depending on whether the field is Date or Text — a difference in spelling
 * alone must not show up as a change to push.
 */
export function sameValue(a, b) {
  const x = text(a), y = text(b)
  if (x === y) return true
  if (x === '' || y === '') return false
  if (/^-?\d+(\.\d+)?$/.test(x) && /^-?\d+(\.\d+)?$/.test(y)) return Number(x) === Number(y)
  const dx = isoDate(x), dy = isoDate(y)
  if (dx && dy) return dx === dy
  const tx = seconds(x), ty = seconds(y)          // "0:03:01" vs "00:03:01"
  if (tx != null && ty != null) return tx === ty
  return false
}
function seconds(s) {
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  return m ? (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) : null
}
function isoDate(s) {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)   // FileMaker Data API: MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

const fileKey = v => text(v).toLowerCase()

/** Catalogue spellings MADStreamer might hold: "BL 789" / "BL789". */
function catVariants(cat) {
  const c = text(cat)
  return [...new Set([c, c.replace(/\s+/g, ''), c.replace(/^([A-Za-z]+)\s*(\d)/, '$1 $2')])].filter(Boolean)
}

async function findStreamerTracks(cat) {
  for (const c of catVariants(cat)) {
    const rows = await findRecordsByCatalogue(c, { includeFieldData: true })
    if (rows.length) return { catalogue: c, rows }
  }
  return { catalogue: cat, rows: [] }
}
async function findTape(cat) {
  for (const c of catVariants(cat)) {
    const t = await findTapeFileByCatalogue(c)
    if (t) return t
  }
  return null
}

function diff(map, source, target, { fields, includeBlanks, layout }) {
  const changes = []
  for (const [from, to] of Object.entries(map)) {
    if (fields && !fields.has(from)) continue
    if (layout && !layout.has(to)) continue
    const want = text(source[from])
    if (!includeBlanks && want === '') continue
    if (sameValue(want, target[to])) continue
    changes.push({ field: to, mamField: from, from: text(target[to]), to: want })
  }
  return changes
}

/**
 * Work out what would change on MADStreamer for one album. Writes nothing.
 *
 * @param {string} catalogue
 * @param {object}  [opts]
 * @param {string[]} [opts.songRecordIds] only these MAM Songs records (default: all)
 * @param {string[]} [opts.mamFields]     only these MAM field names (default: all mapped)
 * @param {boolean}  [opts.includeBlanks] push blank MAM values too (explicit edits)
 * @param {boolean}  [opts.albumFields]   include album-level fields (default true)
 */
export async function planAlbumSync(catalogue, {
  songRecordIds = null, mamFields = null, includeBlanks = false, albumFields = true,
} = {}) {
  const mam = await getMamAlbumRaw(catalogue)
  if (!mam) return { ok: false, catalogue, reason: `No album ${catalogue} in Music Arena Master` }
  const af = mam.album.fieldData
  const cat = text(af['Reference Catalogue Number']) || text(af['Album Catalogue Number']) || text(catalogue)

  const fields = mamFields ? new Set(mamFields) : null
  const onlySongs = songRecordIds ? new Set(songRecordIds.map(String)) : null

  const [{ rows: streamer }, tape, songLayout, tapeLayout] = await Promise.all([
    findStreamerTracks(cat),
    albumFields ? findTape(cat) : null,
    getLayoutFields(),
    albumFields ? getLayoutFields('Tape Files Master') : null,
  ])

  const plan = {
    ok: true, catalogue: cat, onMadStreamer: streamer.length > 0 || !!tape,
    tracks: [], tape: null, streamerOnly: [],
    notOnStreamerLayout: [...new Set([...Object.values(SYNC_SONG_MAP), ...Object.values(SYNC_ALBUM_ON_SONG_MAP)])]
      .filter(f => !songLayout.has(f)),
  }
  if (!plan.onMadStreamer) return summarise(plan)

  const byFile = new Map()
  for (const r of streamer) {
    const k = fileKey(r.filename)
    if (!k) continue
    byFile.set(k, [...(byFile.get(k) || []), r])
  }
  const matched = new Set()

  for (const s of mam.songs) {
    const g = s.fieldData
    const row = { mamRecordId: String(s.recordId), title: text(g['Track Name']),
                  sequence: text(g['Sequence Number']), filename: text(g['Filename']) }
    const k = fileKey(g['Filename'])
    const hits = k ? byFile.get(k) || [] : []
    hits.forEach(h => matched.add(h.recordId))
    if (onlySongs && !onlySongs.has(row.mamRecordId)) continue

    if (!k) { plan.tracks.push({ ...row, status: 'no-filename', changes: [] }); continue }
    if (!hits.length) { plan.tracks.push({ ...row, status: 'not-on-madstreamer', changes: [] }); continue }
    if (hits.length > 1) {
      plan.tracks.push({ ...row, status: 'ambiguous', streamerRecordIds: hits.map(h => h.recordId), changes: [] })
      continue
    }
    const target = hits[0].fieldData || {}
    const opts = { fields, includeBlanks, layout: songLayout }
    const changes = [
      ...diff(SYNC_SONG_MAP, g, target, opts),
      ...(albumFields ? diff(SYNC_ALBUM_ON_SONG_MAP, af, target, opts) : []),
    ]
    plan.tracks.push({ ...row, status: changes.length ? 'changes' : 'in-step',
                       streamerRecordId: hits[0].recordId, changes })
  }

  if (!onlySongs) {
    plan.streamerOnly = streamer.filter(r => !matched.has(r.recordId))
      .map(r => ({ streamerRecordId: r.recordId, title: r.title, filename: r.filename }))
  }

  if (albumFields && tape) {
    const changes = diff(SYNC_ALBUM_ON_TAPE_MAP, af, tape.fieldData || {},
      { fields, includeBlanks, layout: tapeLayout })
    plan.tape = { recordId: String(tape.recordId), changes }
  }
  return summarise(plan)
}

function summarise(plan) {
  const t = plan.tracks
  plan.counts = {
    tracks: t.length,
    withChanges: t.filter(x => x.status === 'changes').length,
    inStep: t.filter(x => x.status === 'in-step').length,
    unmatched: t.filter(x => x.status !== 'changes' && x.status !== 'in-step').length,
    fieldChanges: t.reduce((n, x) => n + x.changes.length, 0) + (plan.tape?.changes.length || 0),
  }
  return plan
}

/**
 * Plan, then write. Each record's write is reported individually; one failure
 * does not stop the rest.
 */
export async function applyAlbumSync(catalogue, { skipFields = [], ...opts } = {}) {
  const plan = await planAlbumSync(catalogue, opts)
  if (!plan.ok) return plan
  // Fields unticked in the preview (MADStreamer names, e.g. "Release Date").
  if (skipFields.length) {
    const skip = new Set(skipFields)
    for (const t of plan.tracks) {
      t.changes = t.changes.filter(c => !skip.has(c.field))
      if (t.status === 'changes' && !t.changes.length) t.status = 'in-step'
    }
    if (plan.tape) plan.tape.changes = plan.tape.changes.filter(c => !skip.has(c.field))
    summarise(plan)
  }
  let written = 0, failed = 0
  for (const t of plan.tracks) {
    if (t.status !== 'changes') continue
    try {
      await updateStreamerRecord(t.streamerRecordId, Object.fromEntries(t.changes.map(c => [c.field, c.to])))
      t.written = true; written++
    } catch (err) { t.written = false; t.error = err.message; failed++ }
  }
  if (plan.tape?.changes.length) {
    try {
      await updateTapeFileRecord(plan.tape.recordId, Object.fromEntries(plan.tape.changes.map(c => [c.field, c.to])))
      plan.tape.written = true; written++
    } catch (err) { plan.tape.written = false; plan.tape.error = err.message; failed++ }
  }
  return { ...plan, applied: true, written, failed }
}

/**
 * The follow-up to a MAM tab save: push exactly what was just written. Never
 * throws — the MAM save already succeeded, and the caller shows this as the
 * "MadStreamer ✓ / ✗" half of the confirmation.
 *
 * @param {object} edit
 * @param {string}   [edit.catalogue]     required unless songRecordId is given
 * @param {string}   [edit.songRecordId]  a single-song edit
 * @param {string[]} [edit.songRecordIds] several songs (album fields still reach every track)
 * @param {string[]} edit.mamFields       MAM field names that were written
 */
export async function syncMamEdit({ catalogue, songRecordId, songRecordIds, mamFields }) {
  try {
    let cat = catalogue
    if (!cat && songRecordId) {
      const song = await getMamFieldData('Songs', songRecordId)
      cat = text(song?.['Album Catalogue'])
      if (!cat) return { ok: false, reason: 'could not tell which album this song is on' }
    }
    const syncable = new Set([...Object.keys(SYNC_SONG_MAP), ...Object.keys(SYNC_ALBUM_ON_SONG_MAP),
                              ...Object.keys(SYNC_ALBUM_ON_TAPE_MAP)])
    const fields = (mamFields || []).filter(f => syncable.has(f))
    if (!fields.length) return { ok: true, skipped: 'none of these fields are kept on MadStreamer' }

    const r = await applyAlbumSync(cat, {
      songRecordIds: songRecordId ? [songRecordId] : (songRecordIds || null),
      mamFields: fields, includeBlanks: true,
    })
    if (!r.ok) return { ok: false, reason: r.reason }
    if (!r.onMadStreamer) return { ok: true, skipped: 'album is not on MadStreamer yet' }
    const unmatched = r.tracks.filter(t => !['changes', 'in-step'].includes(t.status))
    return {
      ok: r.failed === 0, catalogue: r.catalogue, written: r.written, failed: r.failed,
      alreadyInStep: r.counts.inStep, unmatched: unmatched.map(t => ({ title: t.title, status: t.status })),
      errors: [...r.tracks.filter(t => t.error).map(t => `${t.title}: ${t.error}`),
               ...(r.tape?.error ? [`album record: ${r.tape.error}`] : [])],
    }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}
