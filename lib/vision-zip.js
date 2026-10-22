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
import { Transform } from 'stream'
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
 * Open one Vision file for sending: returns { body, run, stop }. `body` is the
 * readable to hand on (the file itself, or MP3 when f.mp3 holds ID3 tags);
 * `run()` pulls the file off Vision into it and resolves once it is all through;
 * `stop()` abandons it (the browser went away). `onBytes` counts bytes READ
 * from Vision, so progress is measured against the masters' sizes either way.
 */
function openVisionEntry(f, onBytes) {
  // Counted in a Transform, not a 'data' listener — that would set the stream
  // flowing before the zip starts reading it, and those bytes would be lost.
  const pass = new Transform({ transform(c, _e, cb) { onBytes?.(c.length); cb(null, c) } })
  const enc = f.mp3 ? mp3EncodeStream({ tags: f.mp3 }) : null
  if (enc) pass.pipe(enc.stdin)   // Vision → pass → ffmpeg → body
  return {
    body: enc ? enc.stdout : pass,
    async run() {
      // visionDownloadTo pipes with { end: false } and resolves when the source
      // is spent, so we close the entry ourselves. Backpressure from whoever
      // reads `body` is what paces the transfer.
      await visionDownloadTo(f.path, pass)
      pass.end()
      if (enc) await enc.finished
    },
    stop() {
      pass.destroy(new Error('Download stopped'))
      if (enc) enc.kill()
    },
  }
}

/** Send one Vision file (as-is, or as MP3 when f.mp3 is set) as an attachment. */
export async function streamVisionFile(res, f) {
  res.setHeader('Content-Type', f.mp3 ? 'audio/mpeg' : 'application/octet-stream')
  res.setHeader('Content-Disposition', contentDisposition(f.name))
  // An MP3 made on the fly has no size until it is finished.
  if (!f.mp3 && f.size != null) res.setHeader('Content-Length', String(f.size))
  const e = openVisionEntry(f)
  res.on('close', () => { if (!res.writableFinished) e.stop() })
  e.body.pipe(res)
  await e.run()
}

/**
 * Stream `files` ([{ path, name, size?, mp3? }] — Vision path, name inside the
 * zip, and ID3 tags when the entry should be converted to MP3)
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
