/**
 * lib/vision-zip.js — the one way GalloIngest hands Vision files to a browser:
 * single-use download tickets, and a streamed zip of a list of Vision files.
 *
 * Shared by the Vision Utility's "Download folder" and the MAM album tab's
 * "Download album" (Ian, 2026-10-22), so there is one download path to trust.
 *
 * A download has to be a plain browser navigation — fetching it instead would
 * hold a multi-GB archive in the tab's memory before saving. But a navigation
 * cannot carry an Authorization header, and putting the admin secret in the
 * query string would write it into browser history, proxies and every access
 * log. So the UI trades the header for a single-use ticket: bound to one job,
 * valid for five minutes, deleted the moment it is redeemed.
 */
import crypto from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import archiver from 'archiver'
import { visionDownloadTo } from './vision-drive.js'
import { contentDisposition } from './content-disposition.js'
import { mp3EncodeStream } from './audio-convert.js'

const TICKET_TTL_MS = 5 * 60 * 1000
const tickets = new Map()   // ticket → { job, expires }

// Progress outlives the ticket (it is read while the download runs) but not by
// much: an hour after the last update it is dropped.
const PROGRESS_TTL_MS = 60 * 60 * 1000
const progress = new Map()  // ticket → { sent, total, files, done, current, error, updated }

function sweep() {
  const now = Date.now()
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t)
  for (const [t, v] of progress) if (v.updated + PROGRESS_TTL_MS < now) progress.delete(t)
}

/** Issue a ticket for `job` (any object the redeeming route understands). */
export function issueTicket(job) {
  sweep()
  const ticket = crypto.randomBytes(24).toString('hex')
  tickets.set(ticket, { job, expires: Date.now() + TICKET_TTL_MS })
  return { ticket, expiresInMs: TICKET_TTL_MS }
}

/** Redeem a ticket: returns its job once, or null if unknown/expired/used. */
export function redeemTicket(ticket) {
  sweep()
  const t = String(ticket || '')
  const entry = tickets.get(t)
  if (!entry) return null
  tickets.delete(t)
  return entry.job
}

/** Where a ticket's download has got to — for a progress line in the UI. */
export function ticketProgress(ticket) {
  return progress.get(String(ticket || '')) || null
}

/**
 * First of `urls` that answers, as { url, size } — a one-byte ranged GET, since
 * the media edge answers that where a HEAD is not guaranteed. null if none
 * does (a missing object on S3 or the edge is a 403/404, not an exception).
 */
export async function probeUrls(urls, timeoutMs = 10000) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) })
      await r.body?.cancel().catch(() => {})
      if (!r.ok) continue
      const total = r.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? r.headers.get('content-length')
      return { url, size: total != null ? Number(total) : null }
    } catch { /* slow or unreachable address: try the next */ }
  }
  return null
}

/**
 * Open one file for sending: returns { body, run, stop }. The file is on Vision
 * (f.path) or on the web (f.url — e.g. the website MP3 on S3). `body` is the
 * readable to hand on (the file itself, or MP3 made from it when f.mp3 holds ID3
 * tags); `run()` pulls the file into it and resolves once it is all through;
 * `stop()` abandons it (the browser went away). `onBytes` counts bytes READ
 * from the source, so progress is measured against the sources' sizes.
 */
function openVisionEntry(f, onBytes) {
  // Counted in a Transform, not a 'data' listener — that would set the stream
  // flowing before the zip starts reading it, and those bytes would be lost.
  const pass = new Transform({ transform(c, _e, cb) { onBytes?.(c.length); cb(null, c) } })
  // stop() destroys `pass` with an error, often before visionDownloadTo has
  // attached its own listener (Vision can take seconds to start sending from
  // Render). An 'error' with no listener crashes the whole server — it did,
  // 2026-10-22 — so there is always one; run() reports the failure instead.
  pass.on('error', () => {})
  const enc = f.mp3 ? mp3EncodeStream({ tags: f.mp3 }) : null
  if (enc) { enc.stdout.on('error', () => {}); pass.pipe(enc.stdin) }   // Vision → pass → ffmpeg → body
  const ac = new AbortController()
  return {
    body: enc ? enc.stdout : pass,
    async run() {
      if (f.url) {
        const r = await fetch(f.url, { signal: ac.signal })
        if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status} from ${new URL(f.url).hostname}`)
        await pipeline(Readable.fromWeb(r.body), pass)
      } else {
        // visionDownloadTo pipes with { end: false } and resolves when the source
        // is spent, so we close the entry ourselves. Backpressure from whoever
        // reads `body` is what paces the transfer.
        await visionDownloadTo(f.path, pass)
        pass.end()
      }
      if (enc) await enc.finished
    },
    stop() {
      ac.abort()
      pass.destroy(new Error('Download stopped'))
      if (enc) enc.kill()
    },
  }
}

/** Send one file (as-is, or as MP3 when f.mp3 is set) as an attachment. */
export async function streamVisionFile(res, f) {
  res.setHeader('Content-Type', f.mp3 || /\.mp3$/i.test(f.name) ? 'audio/mpeg' : 'application/octet-stream')
  res.setHeader('Content-Disposition', contentDisposition(f.name))
  // An MP3 made on the fly has no size until it is finished.
  if (!f.mp3 && f.size != null) res.setHeader('Content-Length', String(f.size))
  const e = openVisionEntry(f)
  res.on('close', () => { if (!res.writableFinished) e.stop() })
  e.body.pipe(res)
  await e.run()
}

/**
 * Stream `files` ([{ path | url, name, size?, mp3? }] — Vision path or web
 * address, name inside the zip, and ID3 tags when the entry should be converted
 * to MP3)
 * to `res` as a zip. Nothing is buffered: each object is piped from Vision into
 * the archive and out to the browser as it goes, so the size is bounded by
 * patience rather than memory — which is what lets the 2 GB Render plan do it.
 *
 * STORE, not deflate — this is overwhelmingly WAV and JPEG, which do not
 * compress meaningfully, and deflating them would just burn CPU on a shared dyno.
 *
 * `extras` ([{ name, text }]) are small text files added at the end, e.g. a
 * list of the tracks that could not be included.
 */
export async function streamVisionZip(res, { zipName, files, extras = [], ticket = null, log = 'vision-zip' }) {
  const p = ticket ? { sent: 0, total: files.reduce((n, f) => n + (f.size || 0), 0), files: files.length,
                       done: 0, current: null, error: null, finished: false, updated: Date.now() } : null
  if (p) progress.set(ticket, p)

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', contentDisposition(zipName))

  const zip = archiver('zip', { store: true })
  let failed = null
  zip.on('warning', (e) => console.warn(`[${log}] zip warning:`, e.message))
  zip.on('error', (e) => { failed = e; res.destroy() })
  zip.pipe(res)
  // If the user closes the tab, stop pulling objects off Vision.
  let current = null
  res.on('close', () => {
    if (!res.writableFinished) {
      zip.abort()
      current?.stop()
      if (p && !p.finished) { p.error = 'Download stopped before the end'; p.updated = Date.now() }
    }
  })

  try {
    for (const f of files) {
      if (failed || res.destroyed) break
      if (p) { p.current = f.name; p.updated = Date.now() }
      current = openVisionEntry(f, p && ((n) => { p.sent += n; p.updated = Date.now() }))
      zip.append(current.body, { name: f.name })
      await current.run()
      current = null
      if (p) p.done++
    }
    for (const x of extras) {
      if (failed || res.destroyed) break
      zip.append(Buffer.from(x.text, 'utf8'), { name: x.name })
    }
    if (!failed && !res.destroyed) {
      await zip.finalize()
      if (p) { p.finished = true; p.current = null; p.updated = Date.now() }
    }
  } catch (e) {
    if (p) { p.error = e.message; p.updated = Date.now() }
    throw e
  }
}
