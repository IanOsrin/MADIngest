// routes/vision-upload.js — the Vision Upload tab: copy a LOCAL folder up to
// a Vision folder, strictly ADD-ONLY. Local-only feature (the server reads
// the local filesystem), gated by VISION_UPLOAD_ENABLED in server.js — same
// pattern as DDEX/YouTube.
//
// Overwrite protection is layered:
//   - preview classifies every file by an exact-key visionStat: files already
//     on Vision are listed as "exists" and never part of the upload set
//   - upload re-checks each key immediately before its put (S3 puts replace
//     silently, so the check is repeated even though preview just ran)
//   - after each put the object is stat-verified (exists + size matches)
import { promises as fs } from 'fs'
import path from 'path'
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionStat, visionUploadFile } from '../lib/vision-drive.js'

const router = Router()

// Junk that must never reach the audio lake.
const SKIP_RE = /^(\.|~|Thumbs\.db$|desktop\.ini$)/i

const CONTENT_TYPES = {
  wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  aif: 'audio/aiff', aiff: 'audio/aiff', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const typeFor = (name) => CONTENT_TYPES[(name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream'

/** Recursively list a local folder's files as { rel, abs, size }, junk skipped. */
async function walkLocal(root, dir = root, out = [], depth = 0) {
  if (depth > 8) return out
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (SKIP_RE.test(e.name)) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) await walkLocal(root, abs, out, depth + 1)
    else if (e.isFile()) {
      const st = await fs.stat(abs)
      out.push({ rel: path.relative(root, abs), abs, size: st.size })
    }
  }
  return out
}

/** Shared planner. Throws {status,message} on bad input. */
async function buildPlan({ localFolder, visionFolder }) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }

  localFolder  = String(localFolder  || '').trim().replace(/\/+$/, '')
  visionFolder = String(visionFolder || '').trim().replace(/\/+$/, '')
  if (!localFolder)  fail(400, 'Local folder path is required')
  if (!visionFolder) fail(400, 'Vision destination folder is required')
  if (!visionFolder.startsWith('/')) visionFolder = '/' + visionFolder
  if (visionFolder.split('/').filter(Boolean).length < 2) fail(400, 'Vision destination must be inside a bucket (e.g. /gallo-digital-cupboard/Rendered Files/…), not a bucket root')
  if (!visionStatus().configured) fail(503, 'Vision drive is not configured')

  const st = await fs.stat(localFolder).catch(() => null)
  if (!st?.isDirectory()) fail(404, `Local folder not found: ${localFolder}`)

  const locals = await walkLocal(localFolder)
  if (!locals.length) fail(404, `No files found in ${localFolder}`)

  // Classify each file by exact-key existence on Vision. Keys are NFC —
  // macOS filenames are NFD-decomposed and the two never match on S3.
  const files = []
  for (const f of locals) {
    const dest = `${visionFolder}/${f.rel.split(path.sep).join('/')}`.normalize('NFC')
    const existing = await visionStat(dest)
    files.push({
      rel: f.rel, abs: f.abs, size: f.size, dest,
      exists: !!existing,
      existingSize: existing?.size ?? null,
    })
  }

  return {
    localFolder, visionFolder, files,
    newFiles:      files.filter(f => !f.exists),
    existingCount: files.filter(f => f.exists).length,
    totalNewBytes: files.filter(f => !f.exists).reduce((s, f) => s + f.size, 0),
  }
}

const publicFile = ({ abs, ...f }) => f // keep local absolute paths out of responses

router.post('/preview', adminAuth, express.json(), async (req, res) => {
  try {
    const plan = await buildPlan(req.body || {})
    res.json({
      ok: true,
      localFolder: plan.localFolder, visionFolder: plan.visionFolder,
      newCount: plan.newFiles.length, existingCount: plan.existingCount,
      totalNewBytes: plan.totalNewBytes,
      files: plan.files.map(publicFile),
    })
  } catch (e) {
    console.error('[vision-upload] preview failed:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.post('/upload', adminAuth, express.json(), async (req, res) => {
  try {
    const plan = await buildPlan(req.body || {})
    if (!plan.newFiles.length) return res.status(400).json({ error: 'Nothing to upload — every file already exists on Vision' })

    console.log(`[vision-upload] START ${plan.localFolder} → ${plan.visionFolder}: ${plan.newFiles.length} file(s), ${Math.round(plan.totalNewBytes / 1e6)}MB (${plan.existingCount} already on Vision, skipped)`)

    const results = []
    for (const f of plan.newFiles) {
      const t0 = Date.now()
      try {
        // Last-instant add-only check — a put would replace silently.
        if (await visionStat(f.dest)) {
          results.push({ ...publicFile(f), ok: false, skipped: true, error: 'Appeared on Vision since preview — not overwriting' })
          continue
        }
        await visionUploadFile(f.dest, f.abs, typeFor(f.rel))
        const check = await visionStat(f.dest)
        const verified = !!check && check.size === f.size
        if (!verified) throw new Error(`post-upload verify failed (stored size ${check?.size ?? 'missing'} vs local ${f.size})`)
        console.log(`[vision-upload] ✓ ${f.rel} → ${f.dest} (${Math.round(f.size / 1e6)}MB in ${Math.round((Date.now() - t0) / 1000)}s)`)
        results.push({ ...publicFile(f), ok: true, verified, seconds: Math.round((Date.now() - t0) / 1000) })
      } catch (e) {
        console.warn(`[vision-upload] ✗ ${f.rel}: ${e.message}`)
        results.push({ ...publicFile(f), ok: false, error: e.message })
      }
    }

    const uploaded = results.filter(r => r.ok).length
    const failed   = results.length - uploaded
    console.log(`[vision-upload] DONE: ${uploaded} uploaded${failed ? `, ${failed} FAILED` : ''}`)
    res.json({ ok: failed === 0, uploaded, failed, skippedExisting: plan.existingCount, results,
               note: uploaded ? 'New files are not searchable until the Vision index is rebuilt (Vision tab → Reindex).' : undefined })
  } catch (e) {
    console.error('[vision-upload] upload failed:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

export default router
