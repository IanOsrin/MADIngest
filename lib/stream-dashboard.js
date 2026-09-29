/**
 * lib/stream-dashboard.js — the Listening tab: what is happening on Music Africa Direct.
 *
 * Same source as the Reports tab (lib/stream-report.js): MadStreamer's API_Stream_Events, ONE RECORD
 * PER LISTEN, TotalPlayedSec = seconds actually heard. Where Reports answers "what was played, and its
 * share", this answers "what is going on": who is listening right now, listens per day, which devices,
 * who the listeners are, the latest listens, and how many listens carry no email and why (Ian,
 * 2026-09-29).
 *
 * WHY A LISTEN HAS NO EMAIL (measured on Aug–Sep 2026, 3,407 listens):
 *   - guest previews — 30-second tasters with no account, so nothing to attach (expected);
 *   - "full" listens with no access code at all — mostly SUBSCRIBERS whose code the website didn't
 *     recognise at that moment (right after a deploy its memory is empty and the JSON copy is wiped);
 *     60 of 84 came from sessions that played with a code before and after. Fixed on the MAD site
 *     2026-09-29 (routes/access.js looks the code up in FileMaker), so these should stop.
 * Every listen that DID carry a code also carried its email.
 */
import { fetchStreamEvents } from './madstreamer.js'
import { parseFmTimestamp, sastDayToUtcMs, fmTimestamp, formatDuration, listenTime, trackDetails, QUALIFYING_SEC } from './stream-report.js'

const SAST_MS = 2 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

const seconds = v => {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}
const isPreview = ev => String(ev.PlaybackMode || '').toUpperCase() === 'PREVIEW'

/** What the listener was using, from the browser's user-agent string. */
export function deviceOf(ua) {
  const s = String(ua || '')
  if (!s) return 'Unknown'
  if (/Android/.test(s)) return /; wv\)/.test(s) ? 'Android app' : 'Android browser'
  if (/iPhone|iPod/.test(s)) return /Safari\//.test(s) || /CriOS|FxiOS|EdgiOS/.test(s) ? 'iPhone browser' : 'iPhone app'
  if (/iPad/.test(s)) return 'iPad'
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/.test(s)) return 'Computer'
  return 'Other'
}

/** Who listened, for display: the email, else the access code, else what kind of anonymous listen. */
function listener(ev) {
  const email = String(ev.Email || '').trim().toLowerCase()
  const code = String(ev.Token_Number || '').trim().toUpperCase()
  if (email) return { key: email, label: email, kind: 'email' }
  if (code) return { key: code, label: code, kind: 'code' }
  if (isPreview(ev)) return { key: '', label: 'Guest (preview)', kind: 'guest' }
  return { key: '', label: 'No code recorded', kind: 'none' }
}

/** "29 Sep 14:05" in South African time. */
function sastText(ms) {
  const d = new Date(ms + SAST_MS)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  return `${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const sastDay = ms => new Date(ms + SAST_MS).toISOString().slice(0, 10)

/**
 * @param {object} opts
 * @param {string} opts.from  first SA day, YYYY-MM-DD
 * @param {string} opts.to    last SA day, inclusive
 * @param {number} [opts.now] for tests
 */
export async function buildStreamDashboard({ from, to, now = Date.now() } = {}) {
  const startMs = sastDayToUtcMs(from)
  const endMs = sastDayToUtcMs(to, { endOfDay: true })
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw Object.assign(new Error('from and to must be YYYY-MM-DD dates'), { status: 400 })
  if (endMs <= startMs) throw Object.assign(new Error('"to" must be on or after "from"'), { status: 400 })

  // The period (a day either side: FileMaker is asked by last event, a listen counts by its start),
  // plus the last hour for "right now" whatever period is chosen.
  const [events, recentEvents] = await Promise.all([
    fetchStreamEvents({ from: fmTimestamp(startMs - DAY), to: fmTimestamp(endMs + DAY) }),
    fetchStreamEvents({ from: fmTimestamp(now - 2 * 60 * 60 * 1000), to: fmTimestamp(now + 60 * 60 * 1000) }),
  ])

  // ── Right now (last 15 minutes / last hour, whatever the period) ──
  const lastEventAt = ev => parseFmTimestamp(ev.LastEventUTC) || parseFmTimestamp(ev.TimestampUTC) || listenTime(ev)
  const live15 = recentEvents.filter(ev => now - lastEventAt(ev) <= 15 * 60 * 1000)
  const hour = recentEvents.filter(ev => now - listenTime(ev) <= 60 * 60 * 1000)
  const people = list => new Set(list.map(ev => listener(ev).key || `s:${ev.SessionID}`)).size
  const latest = recentEvents.reduce((m, ev) => Math.max(m, lastEventAt(ev)), 0)

  // ── The period ──
  const rows = []
  for (const ev of events) {
    const at = listenTime(ev)
    if (!at || at < startMs || at >= endMs) continue
    rows.push({ ev, at, secs: seconds(ev.TotalPlayedSec) || seconds(ev.TimeStreamed), preview: isPreview(ev), who: listener(ev), device: deviceOf(ev.UserAgent) })
  }
  rows.sort((a, b) => b.at - a.at)

  const full = rows.filter(r => !r.preview)
  const previews = rows.filter(r => r.preview)
  const fullSeconds = full.reduce((s, r) => s + r.secs, 0)
  const listenerKeys = new Set(full.map(r => r.who.key).filter(Boolean))

  // Per day (SA days) — or per hour when the period is a single day.
  const oneDay = from === to
  const buckets = new Map()
  if (oneDay) for (let h = 0; h < 24; h++) buckets.set(String(h).padStart(2, '0'), { label: `${String(h).padStart(2, '0')}:00`, full: 0, preview: 0, seconds: 0 })
  else for (let t = startMs; t < endMs; t += DAY) { const d = sastDay(t); buckets.set(d, { label: d, full: 0, preview: 0, seconds: 0 }) }
  for (const r of rows) {
    const key = oneDay ? new Date(r.at + SAST_MS).toISOString().slice(11, 13) : sastDay(r.at)
    const b = buckets.get(key)
    if (!b) continue
    if (r.preview) b.preview += 1
    else { b.full += 1; b.seconds += r.secs }
  }

  // Devices (all listens, previews included — it's about what people use).
  const devices = new Map()
  for (const r of rows) devices.set(r.device, (devices.get(r.device) || 0) + 1)

  // Listeners: people with an email or code, most listening first.
  const byListener = new Map()
  for (const r of full) {
    if (!r.who.key) continue
    const l = byListener.get(r.who.key) || { who: r.who.label, kind: r.who.kind, listens: 0, seconds: 0, last: 0, devices: new Set() }
    l.listens += 1
    l.seconds += r.secs
    l.last = Math.max(l.last, r.at)
    l.devices.add(r.device)
    byListener.set(r.who.key, l)
  }

  // Why some listens have no email.
  const noEmailFull = full.filter(r => r.who.kind === 'none')
  const codedSessions = new Set(full.filter(r => r.who.key).map(r => r.ev.SessionID))
  const noEmailSubscriber = noEmailFull.filter(r => codedSessions.has(r.ev.SessionID)).length
  const codeNoEmail = full.filter(r => r.who.kind === 'code').length

  // Labels for the latest listens and the top songs, from the nightly mirror.
  const latestRows = rows.slice(0, 60)
  const topSongCounts = new Map()
  for (const r of full) {
    const id = String(r.ev.TrackRecordID)
    const t = topSongCounts.get(id) || { id, listens: 0, seconds: 0, ev: r.ev }
    t.listens += 1
    t.seconds += r.secs
    topSongCounts.set(id, t)
  }
  const topSongs = [...topSongCounts.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8)
  const ids = [...new Set([...latestRows.map(r => String(r.ev.TrackRecordID)), ...topSongs.map(t => t.id)])]
  let details = new Map()
  try { details = await trackDetails(ids) } catch { /* mirror down — fall back to the titles on the events */ }
  const label = (ev) => {
    const d = details.get(String(ev.TrackRecordID)) || {}
    return { track: d.track || ev['Track Name'] || `(track ${ev.TrackRecordID})`, artist: d.artist || ev['Track Artist'] || '', album: d.album || '' }
  }

  return {
    from, to, oneDay,
    generatedAt: new Date(now).toISOString(),
    now: {
      listeningNow: people(live15),
      listensLastHour: hour.length,
      lastActivity: latest ? sastText(latest) : null,
      minutesSinceLast: latest ? Math.max(0, Math.round((now - latest) / 60000)) : null,
    },
    totals: {
      listens: full.length,
      plays30: full.filter(r => r.secs >= QUALIFYING_SEC).length,
      seconds: Math.round(fullSeconds),
      duration: formatDuration(fullSeconds),
      listeners: listenerKeys.size,
      perListener: listenerKeys.size ? formatDuration(fullSeconds / listenerKeys.size) : '0s',
      previews: previews.length,
      previewDuration: formatDuration(previews.reduce((s, r) => s + r.secs, 0)),
      songs: new Set(full.map(r => String(r.ev.TrackRecordID))).size,
    },
    series: [...buckets.values()],
    devices: [...devices.entries()].map(([name, listens]) => ({ name, listens, share: rows.length ? Math.round(listens / rows.length * 100) : 0 })).sort((a, b) => b.listens - a.listens),
    listeners: [...byListener.values()].map(l => ({ who: l.who, kind: l.kind, listens: l.listens, duration: formatDuration(l.seconds), seconds: Math.round(l.seconds), last: sastText(l.last), devices: [...l.devices].join(', ') })).sort((a, b) => b.seconds - a.seconds).slice(0, 25),
    topSongs: topSongs.map(t => ({ ...label(t.ev), listens: t.listens, duration: formatDuration(t.seconds) })),
    recent: latestRows.map(r => ({
      at: sastText(r.at), ...label(r.ev), who: r.who.label, whoKind: r.who.kind, device: r.device,
      played: formatDuration(r.secs), preview: r.preview,
    })),
    missingEmail: {
      total: rows.length,
      withEmail: full.filter(r => r.who.kind === 'email').length,
      guestPreviews: previews.length,
      noCode: noEmailFull.length,
      noCodeSubscriberSessions: noEmailSubscriber,
      codeWithoutEmail: codeNoEmail,
    },
  }
}
