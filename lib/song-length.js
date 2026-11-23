/**
 * lib/song-length.js — the ONE way a song length is written to FileMaker.
 *
 * "Duration" is a FileMaker TIME field in MADStreamer, MAM and Gallo. A time
 * field reads what it is given as hours first: "3:27" becomes 3 h 27 m
 * (03:27:00) and a bare "207" becomes 207 hours. The site then shows a 3:27
 * song as "207:00". That has happened three times (2026-06, 07-08 and 11-23,
 * 71 records on new albums) because each write path had its own converter, or
 * none — Publish and the MAM → MADStreamer sync copied MAM's value as it was.
 *
 * Every Duration write goes through songLengthToFmTime(), which always returns
 * a full zero-padded "HH:MM:SS".
 *
 * Accepted input: seconds (number or numeric string), a fraction of a day
 * below 1 (how a spreadsheet stores times), "M:SS", "H:MM:SS", ISO-8601
 * "PT4M35S".
 *
 * Already-broken values are repaired, not copied: an "H:MM:00" of an hour or
 * more is read as M:SS ("3:27:00" → 00:03:27), and an "N:00:00" of 24 hours or
 * more as N seconds ("275:00:00" → 00:04:35, the July 2026 seconds-as-hours fault). A whole catalogue of ~69,000
 * tracks holds no genuine song of an hour or more once these are fixed
 * (checked 2026-11-23), so the rule costs nothing real; fm-cms2024's
 * durationSeconds uses the same rule for CMS 2024. A value under an hour is
 * left as it is — "0:20:00" may be a 20-second interlude typed as "0:20",
 * but it may also be a 20-minute track, and only the audio can tell.
 */

/** Seconds in a song length, or null when the value cannot be read. */
export function songLengthSeconds(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? fromNumber(v) : null
  const s = String(v).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return fromNumber(parseFloat(s))
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Math.round((+iso[1] || 0) * 3600 + (+iso[2] || 0) * 60 + (+iso[3] || 0))
  }
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null
  const n = parts.map(Number)
  if (n.length === 2) return Math.round(n[0] * 60 + n[1])
  const [h, m, sec] = n
  if (m >= 60 || sec >= 60) return null
  if (h >= 24 && m === 0 && sec === 0) return h        // "275:00:00" = 275 seconds written as hours
  if (h >= 1 && sec === 0) return h * 60 + m          // "3:27:00" = a 3:27 song typed into a time field
  return Math.round(h * 3600 + m * 60 + sec)
}

/** A whole number is seconds; a fraction of 1 is a spreadsheet time (fraction of a day). */
function fromNumber(x) {
  if (x > 0 && x < 1) return Math.round(x * 86400)
  return Math.round(x)
}

/** "HH:MM:SS" for a FileMaker time field, or null when the value cannot be read. */
export function songLengthToFmTime(v) {
  const sec = songLengthSeconds(v)
  if (sec == null) return null
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`
}
