/**
 * routes/vision-utility.js — the Vision Utility: general-purpose file handling
 * on the Vision drive, for anything that is NOT the audio ingest path.
 *
 * The rest of the Vision tooling is audio-shaped (the index only holds audio,
 * the upload tab mirrors a local album folder). This is the plain-file half:
 * put arbitrary files into the folder you are browsing, take a whole folder
 * away as a zip, and tidy up names — artwork, sleeves, DDEX XML, contracts,
 * spreadsheets (Ian, 2026-08-17).
 *
 * Unlike routes/vision-upload.js this is browser-based, so it works from the
 * hosted admin as well as locally — nothing here touches a native file picker.
 *
 * WRITE OPERATIONS. Vision holds the masters and has no versioning or trash:
 *   - upload refuses to replace an existing key unless ?overwrite=1
 *   - delete requires the caller to echo back the exact name (confirm=<name>)
 *   - rename refuses to clobber, and copies before it deletes
 */
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { Router } from 'express'
import multer from 'multer'
import archiver from 'archiver'
import { adminAuth } from '../lib/admin-auth.js'
import {
  visionStatus, visionList, visionStat, visionListKeys,
  visionUploadFile, visionDownloadTo, visionDelete, visionRename,
} from '../lib/vision-drive.js'
import { contentDisposition } from '../lib/content-disposition.js'

const router = Router()

/**
 * Delete is OFF on the hosted instance unless explicitly switched on.
 *
 * Upload, zip and rename are all recoverable — a bad upload can be deleted
 * locally, a rename can be renamed back. Delete is not: Vision has no trash and
 * no versioning, so a wrong click from anywhere in the world with the admin
 * password destroys a master for good. Locally the blast radius is someone
 * sitting at the machine; hosted it is anyone holding INGEST_ADMIN_SECRET
 * (Ian, 2026-08-17). Same default-off-in-production shape as VISION_UPLOAD_ENABLED.
 *
 * To enable on Render: set VISION_DELETE_ENABLED=true in the dashboard.
 */
export const VISION_DELETE_ENABLED =
  process.env.VISION_DELETE_ENABLED === 'true' ||
  (process.env.VISION_DELETE_ENABLED !== 'false' && process.env.NODE_ENV !== 'production')

// Spooled to disk, not memory: these are masters, not thumbnails — a couple of
// WAVs held in a Render dyno's RAM is an OOM, on disk it is a temp file.
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: Number(process.env.VISION_UTIL_MAX_BYTES || 8 * 1024 * 1024 * 1024) },
})

const CONTENT_TYPES = {
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.xml': 'application/xml', '.json': 'application/json',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const typeFor = (name) => CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream'

const guard = (req, res) => {
  if (!visionStatus().configured) { res.status(503).json({ error: 'Vision drive is not configured' }); return false }
  return true
}

/**
 * Upload one or more files into a Vision folder. Multipart, so it streams from
 * the browser and works hosted. Each file is reported individually — a partial
 * success must not look like a failure of the whole batch.
 */
router.post('/upload', adminAuth, upload.array('files', 200), async (req, res) => {
  if (!guard(req, res)) return
  const dest = String(req.query.path || req.body?.path || '').trim()
  const overwrite = req.query.overwrite === '1' || req.body?.overwrite === 'true'
  const files = req.files || []
  const cleanup = () => files.forEach(f => { try { fs.unlinkSync(f.path) } catch {} })

  try {
    if (!dest) return res.status(400).json({ error: 'No destination folder given' })
    if (dest.split('/').filter(Boolean).length < 2) {
      return res.status(400).json({ error: 'Pick a folder inside a bucket — uploading to a bucket root is not allowed' })
    }
    if (!files.length) return res.status(400).json({ error: 'No files received' })

    const results = []
    for (const f of files) {
      // multer gives the browser's filename in originalname; normalise to NFC so
      // it matches how the drive and the index store accented names.
      const name = path.basename(f.originalname).normalize('NFC')
      const rel = `${dest.replace(/\/$/, '')}/${name}`
      try {
        if (!overwrite && await visionStat(rel)) {
          results.push({ name, ok: false, skipped: true, error: 'Already exists on Vision — tick Overwrite to replace it' })
          continue
        }
        await visionUploadFile(rel, f.path, typeFor(name))
        results.push({ name, ok: true, size: f.size, path: rel })
      } catch (e) {
        results.push({ name, ok: false, error: e.message })
      }
    }
    const ok = results.filter(r => r.ok).length
    const skipped = results.filter(r => r.skipped).length
    const failed = results.length - ok - skipped
    // Only mention indexing when it actually applies: the index holds audio
    // only, so saying it after a batch of artwork is noise that trains people
    // to ignore the line.
    const audioUploaded = results.some(r => r.ok && /\.(wav|flac|aiff?|mp3|m4a|aac|ogg)$/i.test(r.name))
    res.json({
      ok: failed === 0, uploaded: ok, skipped, failed, results,
      note: `${ok} uploaded${skipped ? `, ${skipped} already there` : ''}${failed ? `, ${failed} failed` : ''}.`
          + (audioUploaded ? ' Not searchable until indexed — use "Index this folder".' : ''),
    })
  } catch (e) {
    console.error('[vision-util] upload failed:', e.message)
    res.status(500).json({ error: e.message })
  } finally {
    cleanup()
  }
})

/**
 * A zip download has to be a plain browser navigation — fetching it instead
 * would hold a multi-GB archive in the tab's memory before saving. But a
 * navigation cannot carry an Authorization header, and putting the admin secret
 * in the query string would write it into browser history, proxies and every
 * access log. So the UI trades the header for a single-use ticket: bound to one
 * path, valid for five minutes, deleted the moment it is redeemed.
 */
const TICKET_TTL_MS = 5 * 60 * 1000
const tickets = new Map()   // ticket → { path, expires }

const sweepTickets = () => {
  const now = Date.now()
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t)
}

router.post('/download-ticket', adminAuth, (req, res) => {
  if (!guard(req, res)) return
  const rel = String(req.query.path || req.body?.path || '').trim()
  if (!rel || rel.split('/').filter(Boolean).length < 2) {
    return res.status(400).json({ error: 'Pick a folder inside a bucket' })
  }
  sweepTickets()
  const ticket = crypto.randomBytes(24).toString('hex')
  tickets.set(ticket, { path: rel, expires: Date.now() + TICKET_TTL_MS })
  res.json({ ok: true, ticket, expiresInMs: TICKET_TTL_MS })
})

/**
 * Download a whole folder as a zip, streamed. Nothing is buffered: each object
 * is piped from Vision into the archive and out to the browser as it goes, so
 * folder size is bounded by patience rather than by memory.
 *
 * STORE, not deflate — this is overwhelmingly WAV and JPEG, which do not
 * compress meaningfully, and deflating them would just burn CPU on a shared dyno.
 */
router.get('/download-folder', async (req, res) => {
  if (!guard(req, res)) return
  sweepTickets()
  const entry = tickets.get(String(req.query.ticket || ''))
  if (!entry) return res.status(401).json({ error: 'Download link expired or already used — click Download folder again' })
  tickets.delete(String(req.query.ticket))
  const rel = entry.path
  try {
    const keys = await visionListKeys(rel)
    if (!keys.size) return res.status(404).json({ error: 'That folder has no files in it' })

    // A guard, not a limit for its own sake: zipping a top-level folder like
    // "Rendered Files" is 21,000 files and hours of streaming, which is never
    // what someone meant to click.
    const MAX = Number(process.env.VISION_UTIL_ZIP_MAX_FILES || 2000)
    if (keys.size > MAX) {
      return res.status(413).json({
        error: `That folder holds ${keys.size.toLocaleString()} files (limit ${MAX.toLocaleString()}). Open a subfolder and zip that instead.`,
      })
    }

    const base = rel.replace(/\/$/, '').split('/').filter(Boolean).pop() || 'vision'
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', contentDisposition(base + '.zip'))

    const zip = archiver('zip', { store: true })
    let failed = null
    zip.on('warning', (e) => console.warn('[vision-util] zip warning:', e.message))
    zip.on('error', (e) => { failed = e; res.destroy() })
    zip.pipe(res)
    // If the user closes the tab, stop pulling objects off Vision.
    res.on('close', () => { if (!res.writableFinished) zip.abort() })

    const prefix = rel.replace(/\/$/, '')
    for (const fullPath of [...keys.keys()].sort()) {
      if (failed || res.destroyed) break
      // Entry names are relative to the folder being zipped, so the archive
      // opens as that folder rather than a chain of empty parents.
      const entry = fullPath.startsWith(prefix + '/') ? fullPath.slice(prefix.length + 1) : fullPath.replace(/^\//, '')
      const pass = new PassThrough()
      zip.append(pass, { name: entry })
      // s3DownloadTo pipes with { end: false } and resolves when the source is
      // spent, so we close the entry ourselves. Backpressure from the archiver
      // is what paces the whole loop.
      await visionDownloadTo(fullPath, pass)
      pass.end()
    }
    if (!failed && !res.destroyed) await zip.finalize()
  } catch (e) {
    console.error('[vision-util] folder download failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: e.message })
    else res.destroy()
  }
})

/**
 * Delete a file or a folder. Irreversible: Vision has no trash and no
 * versioning. `confirm` must equal the item's own name — the UI asks the user
 * to type it, so an accidental click on the wrong row cannot delete anything.
 */
router.post('/delete', adminAuth, async (req, res) => {
  if (!guard(req, res)) return
  if (!VISION_DELETE_ENABLED) {
    return res.status(403).json({
      error: 'Deleting from Vision is switched off on this instance. Do it from local GalloIngest, or set VISION_DELETE_ENABLED=true.',
    })
  }
  try {
    const rel = String(req.query.path || req.body?.path || '').trim()
    const confirm = String(req.query.confirm ?? req.body?.confirm ?? '')
    if (!rel) return res.status(400).json({ error: 'No path given' })
    const parts = rel.split('/').filter(Boolean)
    if (parts.length < 3) {
      return res.status(400).json({ error: 'Refusing to delete a bucket or a top-level folder from here — too much rides on one click' })
    }
    const name = parts[parts.length - 1]
    if (confirm.normalize('NFC') !== name.normalize('NFC')) {
      return res.status(400).json({ error: `Type the exact name to confirm: "${name}"` })
    }
    const r = await visionDelete(rel)
    console.log(`[vision-util] deleted ${r.deleted} object(s) at ${rel}`)
    res.json({
      ok: true, ...r,
      note: `Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'}. The search index still lists them until the folder is re-indexed.`,
    })
  } catch (e) {
    console.error('[vision-util] delete failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/** Rename a file or folder in place (same parent), or move it to another path. */
router.post('/rename', adminAuth, async (req, res) => {
  if (!guard(req, res)) return
  try {
    const from = String(req.query.from || req.body?.from || '').trim()
    const toName = String(req.query.to || req.body?.to || '').trim()
    if (!from || !toName) return res.status(400).json({ error: 'Both from and to are required' })
    const parts = from.split('/').filter(Boolean)
    if (parts.length < 3) return res.status(400).json({ error: 'Refusing to rename a bucket or a top-level folder from here' })
    if (/[\\]/.test(toName)) return res.status(400).json({ error: 'Backslashes are not allowed in a name' })

    // A bare name renames in place; a value containing "/" is treated as a full
    // destination path, so the same endpoint can move things.
    const to = toName.includes('/')
      ? '/' + toName.replace(/^\/+/, '')
      : '/' + [...parts.slice(0, -1), toName.normalize('NFC')].join('/')

    const r = await visionRename(from, to)
    console.log(`[vision-util] renamed ${from} → ${to} (${r.moved} object(s))`)
    res.json({
      ok: true, from, to, ...r,
      note: `Moved ${r.moved} file${r.moved === 1 ? '' : 's'}. Re-index the folder so search reflects the new path.`,
    })
  } catch (e) {
    console.error('[vision-util] rename failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

export default router
