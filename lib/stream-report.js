/**
 * lib/stream-report.js — what was listened to, for how long, in a given period.
 *
 * Source: the MadStreamer `API_Stream_Events` layout, which the MAD website
 * writes as people listen. ONE RECORD IS ONE LISTEN — the site opens a record
 * when a track starts and updates that same record as it plays (routes/access.js
 * in madmusicv2.1), so:
 *   - TotalPlayedSec is seconds actually heard, already capped at the track's
 *     length, so summing records never double-counts;
 *   - a pause and resume stays one record; only END or ERROR closes one, and a
 *     replay in the same session opens a new record;
 *   - PlayStartUTC is when the listen began and TimestampUTC its last event.
 *
 * Song titles on the event are what the player had at the time and are
 * sometimes blank, so every row is re-labelled from the Postgres mirror by
 * TrackRecordID — that is also where the album and catalogue number come from.
 *
 * Previews (PlaybackMode PREVIEW) are the 30-second guest tasters. They are
 * real streams but not listening, so they are reported on their own line and
 * left out of the table and the percentages (Ian, 2026-09-18).
 */
import { fetchStreamEvents } from './madstreamer.js'
import { mirrorQuery, isMirrorEnabled } from './mirror-db.js'

// A play in the royalty sense. Shorter listens still count their seconds.
export const QUALIFYING_SEC = 30

// The catalogue is South African and so is everyone reading this report: a day
// means a day here, not a UTC day. FileMaker stores the events in UTC and South
// Africa has no daylight saving, so the offset is always +2.
const SAST_OFFSET_MIN = 120

const pad = n => String(n).padStart(2, '0')

/** FileMaker timestamp ("09/18/2026 08:30:03", UTC) → epoch ms. */
export function parseFmTimestamp(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim())
  if (!m) return 0
  return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0))
}

/** epoch ms → FileMaker's MM/DD/YYYY HH:MM:SS, for a find request. */
function fmTimestamp(ms) {
  const d = new Date(ms)
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/**
 * "2026-09-01" (a South African calendar day) → the epoch ms of its start, or
 * of the moment just after its end when `endOfDay`.
 */
export function sastDayToUtcMs(day, { endOfDay = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '').trim())
  if (!m) return NaN
  const midnight = Date.UTC(+m[1], +m[2] - 1, +m[3]) - SAST_OFFSET_MIN * 60_000
  return endOfDay ? midnight + 24 * 60 * 60 * 1000 : midnight
}

const seconds = v => {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Seconds → "3h 07m" / "7m 12s" / "48s", for reading rather than arithmetic. */
export function formatDuration(total) {
  const s = Math.round(total)
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
  if (s >= 60) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${s}s`
}

const isPreview = ev => String(ev.PlaybackMode || '').toUpperCase() === 'PREVIEW'

// When the listen happened: when it started, or failing that its last event.
const listenTime = ev => parseFmTimestamp(ev.PlayStartUTC) || parseFmTimestamp(ev.TimestampUTC) || parseFmTimestamp(ev.LastEventUTC)

/**
 * Track details from the nightly mirror, keyed by the event's TrackRecordID.
 * The mirror is a copy of MadStreamer, so a track added since last night's sync
 * simply keeps the title the player recorded on the event.
 */
async function trackDetails(ids) {
  if (!ids.length || !isMirrorEnabled()) return new Map()
  const { rows } = await mirrorQuery(
    `SELECT fm_record_id AS id,
            raw->>'Track Name'   AS track,
            raw->>'Track Artist' AS artist,
            COALESCE(NULLIF(raw->>'Album Title', ''),  raw->>'Tape Files::Album Title')  AS album,
            COALESCE(NULLIF(raw->>'Album Artist', ''), raw->>'Tape Files::Album Artist') AS album_artist,
            COALESCE(NULLIF(TRIM(raw->>'Reference Catalogue Number'), ''),
                     NULLIF(TRIM(raw->>'Album Catalogue Number'), '')) AS cat,
            raw->>'ISRC' AS isrc
       FROM tracks WHERE fm_record_id = ANY($1)`,
    [ids]
  )
  return new Map(rows.map(r => [String(r.id), r]))
}

const GROUPS = {
  song:   { key: r => `t:${r.trackId}`,                   label: r => r.track, sub: r => r.artist },
  album:  { key: r => `a:${(r.cat || r.album || '').toLowerCase()}`, label: r => r.album, sub: r => r.albumArtist || r.artist },
  artist: { key: r => `r:${(r.albumArtist || r.artist || '').toLowerCase()}`, label: r => r.albumArtist || r.artist, sub: () => '' },
}

/**
 * Build the report.
 *
 * @param {object} opts
 * @param {string} opts.from      first day to include, "YYYY-MM-DD" (SA time)
 * @param {string} opts.to        last day to include, inclusive
 * @param {'song'|'album'|'artist'} [opts.group]
 * @param {boolean} [opts.includePreviews]  count the 30 s guest tasters too
 * @param {number} [opts.limit]   rows returned (the totals always cover them all)
 */
export async function buildStreamReport({ from, to, group = 'song', includePreviews = false, limit = 200 } = {}) {
  const startMs = sastDayToUtcMs(from)
  const endMs   = sastDayToUtcMs(to, { endOfDay: true })
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw Object.assign(new Error('from and to must be YYYY-MM-DD dates'), { status: 400 })
  if (endMs <= startMs) throw Object.assign(new Error('"to" must be on or after "from"'), { status: 400 })
  const grouping = GROUPS[group] || GROUPS.song

  // A listen is counted by when it STARTED, but FileMaker can only be asked
  // about one field, and TimestampUTC (the last event) is the one every record
  // has. Ask for a day either side and do the exact filtering here.
  const events = await fetchStreamEvents({
    from: fmTimestamp(startMs - 24 * 60 * 60 * 1000),
    to:   fmTimestamp(endMs + 24 * 60 * 60 * 1000),
  })

  const inPeriod = []
  let previewListens = 0
  let previewSeconds = 0
  for (const ev of events) {
    const at = listenTime(ev)
    if (!at || at < startMs || at >= endMs) continue
    const secs = seconds(ev.TotalPlayedSec) || seconds(ev.TimeStreamed)
    if (isPreview(ev) && !includePreviews) {
      previewListens += 1
      previewSeconds += secs
      continue
    }
    if (!secs) continue                       // a listen that played nothing tells us nothing
    inPeriod.push({ ev, at, secs })
  }

  const details = await trackDetails([...new Set(inPeriod.map(r => String(r.ev.TrackRecordID)))])

  const rows = new Map()
  let totalSeconds = 0
  let totalListens = 0
  let qualifying = 0
  const songs = new Set()
  const listeners = new Set()

  for (const { ev, secs } of inPeriod) {
    const trackId = String(ev.TrackRecordID)
    const d = details.get(trackId) || {}
    const r = {
      trackId,
      track:  d.track  || ev['Track Name']   || `(track ${trackId})`,
      artist: d.artist || ev['Track Artist'] || '',
      album:  d.album || '',
      albumArtist: d.album_artist || '',
      cat:    d.cat || '',
      isrc:   d.isrc || ev.TrackISRC || '',
    }
    totalSeconds += secs
    totalListens += 1
    songs.add(trackId)
    if (secs >= QUALIFYING_SEC) qualifying += 1
    const who = String(ev.Email || ev.Token_Number || '').toLowerCase()
    if (who) listeners.add(who)

    const key = grouping.key(r)
    const row = rows.get(key) || {
      key,
      title: grouping.label(r) || '(unknown)',
      subtitle: grouping.sub(r) || '',
      catalogue: r.cat,
      isrc: group === 'song' ? r.isrc : '',
      trackId: group === 'song' ? trackId : '',
      listens: 0, plays30: 0, seconds: 0, tracks: new Set(),
    }
    row.listens += 1
    if (secs >= QUALIFYING_SEC) row.plays30 += 1
    row.seconds += secs
    row.tracks.add(trackId)
    if (!row.catalogue && r.cat) row.catalogue = r.cat
    rows.set(key, row)
  }

  const all = [...rows.values()]
    .map(r => ({
      ...r,
      tracks: r.tracks.size,
      seconds: Math.round(r.seconds),
      duration: formatDuration(r.seconds),
      share: totalSeconds > 0 ? +(r.seconds / totalSeconds * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds || b.listens - a.listens)

  return {
    from, to, group,
    includePreviews,
    rowCount: all.length,
    rows: all.slice(0, limit),
    totals: {
      seconds: Math.round(totalSeconds),
      duration: formatDuration(totalSeconds),
      listens: totalListens,
      plays30: qualifying,
      songs: songs.size,
      listeners: listeners.size,
    },
    // Reported, never silently dropped: excluded previews are still streams.
    previews: { listens: previewListens, seconds: Math.round(previewSeconds), duration: formatDuration(previewSeconds), counted: includePreviews },
    eventsScanned: events.length,
    mirror: isMirrorEnabled(),
  }
}
