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
import { execFile } from 'child_process'
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionStatus, visionStat, visionListKeys, visionUploadFile } from '../lib/vision-drive.js'

const router = Router()

// Native macOS folder picker — the server runs on the same Mac as the browser
// (this whole route is local-only), so it can pop a real Finder chooser and
// hand back the absolute path. No typed paths, no typos.
router.post('/pick-folder', adminAuth, (req, res) => {
  const script = 'POSIX path of (choose folder with prompt "Choose the folder to copy to Vision")'
  execFile('osascript', ['-e', script], { timeout: 180_000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = String(stderr || err.message)
      if (/-128|canceled/i.test(msg)) return res.json({ ok: true, canceled: true })
      console.warn('[vision-upload] pick-folder failed:', msg.trim())
      return res.status(500).json({ error: 'Could not open the folder picker — is the app running on this Mac with a desktop session?' })
    }
    res.json({ ok: true, path: stdout.trim().replace(/\/$/, '') })
  })
})

// Junk that must never reach the audio lake.
const SKIP_RE = /^(\.|~|Thumbs\.db$|desktop\.ini$)/i

const CONTENT_TYPES = {
  wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  aif: 'audio/aiff', aiff: 'audio/aiff', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const typeFor = (name) => CONTENT_TYPES[(name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()] || 'application/octet-stream'

/**
 * Recursively list a local folder's files as { rel, abs, size }, junk skipped.
 * Network/external volumes (SMB, NFS, some USB) often return dirents with an
 * UNKNOWN type — isDirectory()/isFile() both false — so anything ambiguous is
 * stat()ed before deciding. Skipping those silently once cost a 2000-file
 * folder 92% of its contents. Unreadable entries are collected as warnings,
 * never silently dropped.
 */
async function walkLocal(root, dir = root, out = [], warnings = [], depth = 0) {
  if (depth > 12) { warnings.push(`Skipped ${dir} — deeper than 12 levels`); return { out, warnings } }
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    warnings.push(`Could not read ${dir}: ${e.message}`)
    return { out, warnings }
  }
  for (const e of entries) {
    if (SKIP_RE.test(e.name)) continue
    const abs = path.join(dir, e.name)
    let isDir = e.isDirectory(), isFile = e.isFile()
    if (!isDir && !isFile) {
      // Unknown dirent type (network FS) or a symlink/alias — resolve it.
      const st = await fs.stat(abs).catch(() => null)
      if (!st) { warnings.push(`Could not stat ${abs} — skipped`); continue }
      isDir = st.isDirectory(); isFile = st.isFile()
    }
    if (isDir) await walkLocal(root, abs, out, warnings, depth + 1)
    else if (isFile) {
      const st = await fs.stat(abs).catch(() => null)
      if (!st) { warnings.push(`Could not stat ${abs} — skipped`); continue }
      out.push({ rel: path.relative(root, abs), abs, size: st.size })
    }
  }
  return { out, warnings }
}

/** Shared planner. Throws {status,message} on bad input. */
/**
 * Look an album up in Music Arena Master and derive where its files belong.
 * Typing the destination by hand is what put files loose in a parent folder:
 * this planner maps a picked folder's CONTENTS onto the destination, so a
 * destination one level too high scatters the album. Deriving it from the
 * album means the album folder always exists and is named like the other
 * 18,000 on Vision.
 */
async function folderForAlbumId(albumID) {
  const base = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const s = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
  const token = s?.response?.token
  if (!token) throw Object.assign(new Error('Could not reach Music Arena Master'), { status: 502 })
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  try {
    const j = await (await fetch(base + '/layouts/Albums/_find', { method: 'POST', headers: H,
      body: JSON.stringify({ query: [{ AlbumID: '==' + albumID }], limit: 1 }) })).json()
    const f = j?.response?.data?.[0]?.fieldData
    if (!f) throw Object.assign(new Error(`No album ${albumID} in Music Arena Master`), { status: 404 })
    const { visionFolderForAlbum } = await import('../lib/vision-destination.js')
    const d = visionFolderForAlbum({
      artist: f['Album Artist'], title: f['Album Title'],
      catalogue: f['Album Catalogue Number'] || f['Reference Catalogue Number'],
    })
    return { ...d, album: { AlbumID: f.AlbumID, artist: f['Album Artist'], title: f['Album Title'],
                            catalogue: f['Album Catalogue Number'] || f['Reference Catalogue Number'],
                            tracks: f['Track Count'] } }
  } finally { await fetch(base + '/sessions/' + token, { method: 'DELETE', headers: H }).catch(() => {}) }
}

async function buildPlan({ localFolder, visionFolder, albumID }) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }

  localFolder  = String(localFolder  || '').trim().replace(/\/+$/, '')
  albumID      = String(albumID      || '').trim()
  let album = null
  if (albumID) {
    // An album wins over a typed path — that is the whole point of picking one.
    const d = await folderForAlbumId(albumID)
    visionFolder = d.folder
    album = d.album
  }
  visionFolder = String(visionFolder || '').trim().replace(/\/+$/, '')
  if (!localFolder)  fail(400, 'Local folder path is required')
  if (!visionFolder) fail(400, 'Choose an album, or give a Vision destination folder')
  if (!visionFolder.startsWith('/')) visionFolder = '/' + visionFolder
  if (visionFolder.split('/').filter(Boolean).length < 2) fail(400, 'Vision destination must be inside a bucket (e.g. /gallo-digital-cupboard/Rendered Files/…), not a bucket root')
  if (!visionStatus().configured) fail(503, 'Vision drive is not configured')

  const st = await fs.stat(localFolder).catch(() => null)
  if (!st?.isDirectory()) fail(404, `Local folder not found: ${localFolder}`)

  const { out: locals, warnings } = await walkLocal(localFolder)
  if (!locals.length) fail(404, `No files found in ${localFolder}${warnings.length ? ` (${warnings.length} unreadable entr${warnings.length === 1 ? 'y' : 'ies'} — first: ${warnings[0]})` : ''}`)

  // Classify by existence on Vision — ONE listing of the destination folder,
  // not a stat per file (that made previews of big folders crawl). Both sides
  // compared NFC-normalized: macOS filenames are NFD-decomposed and would
  // never match their stored keys otherwise.
  const onVision = new Map()
  for (const [k, size] of await visionListKeys(visionFolder)) onVision.set(k.normalize('NFC'), size)
  const files = locals.map(f => {
    const dest = `${visionFolder}/${f.rel.split(path.sep).join('/')}`.normalize('NFC')
    const existingSize = onVision.get(dest)
    return {
      rel: f.rel, abs: f.abs, size: f.size, dest,
      exists: existingSize !== undefined,
      existingSize: existingSize ?? null,
    }
  })

  return {
    localFolder, visionFolder, album, files, warnings,
    newFiles:      files.filter(f => !f.exists),
    existingCount: files.filter(f => f.exists).length,
    totalNewBytes: files.filter(f => !f.exists).reduce((s, f) => s + f.size, 0),
  }
}

const publicFile = ({ abs, ...f }) => f // keep local absolute paths out of responses

/**
 * Search Music Arena Master and return, for each album, the folder its files
 * belong in. Picking an album is the safest way to fill the destination: a
 * typed path one level too high scatters the album loose into the parent,
 * because the planner maps the picked folder's CONTENTS onto it.
 */
router.get('/album-search', adminAuth, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.status(400).json({ error: 'Type at least two characters' })
  const base = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  let token
  try {
    const s = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
    token = s?.response?.token
    if (!token) throw new Error('Could not reach Music Arena Master')
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    const j = await (await fetch(base + '/layouts/Albums/_find', { method: 'POST', headers: H,
      body: JSON.stringify({
        query: [{ 'Album Artist': `*${q}*` }, { 'Album Title': `*${q}*` },
                { 'Album Catalogue Number': `*${q}*` }, { 'Reference Catalogue Number': `*${q}*` }],
        limit: 25,
      }) })).json()
    const { visionFolderForAlbum } = await import('../lib/vision-destination.js')
    const albums = (j?.response?.data || []).map(r => {
      const f = r.fieldData
      const catalogue = f['Album Catalogue Number'] || f['Reference Catalogue Number']
      let folder = null, why = null
      try { folder = visionFolderForAlbum({ artist: f['Album Artist'], title: f['Album Title'], catalogue }).folder }
      catch (e) { why = e.message }
      return { albumID: f.AlbumID, artist: f['Album Artist'], title: f['Album Title'],
               catalogue, tracks: f['Track Count'], folder, why }
    })
    res.json({ ok: true, count: albums.length, albums })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  } finally {
    if (token) await fetch(base + '/sessions/' + token, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {})
  }
})

router.post('/preview', adminAuth, express.json(), async (req, res) => {
  try {
    const plan = await buildPlan(req.body || {})
    console.log(`[vision-upload] preview ${plan.localFolder}: scanned ${plan.files.length} file(s) — ${plan.newFiles.length} new, ${plan.existingCount} on Vision${plan.warnings.length ? `, ${plan.warnings.length} WARNING(s)` : ''}`)
    plan.warnings.forEach(w => console.warn(`[vision-upload]   ⚠ ${w}`))
    res.json({
      ok: true,
      localFolder: plan.localFolder, visionFolder: plan.visionFolder,
      scannedCount: plan.files.length,
      newCount: plan.newFiles.length, existingCount: plan.existingCount,
      totalNewBytes: plan.totalNewBytes,
      warnings: plan.warnings,
      files: plan.files.map(publicFile),
    })
  } catch (e) {
    console.error('[vision-upload] preview failed:', e.message)
    res.status(e.status || 500).json({ error: e.message })
  }
})

// Streams NDJSON progress events so the tab can draw live progress bars:
//   {type:'plan'} → per file {type:'file-start'|'progress'|'file-done'|'file-error'} → {type:'done'}
// Progress events are throttled to ~2/s per file.
router.post('/upload', adminAuth, express.json(), async (req, res) => {
  let streaming = false
  try {
    const plan = await buildPlan(req.body || {})
    if (!plan.newFiles.length) return res.status(400).json({ error: 'Nothing to upload — every file already exists on Vision' })

    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-cache')
    streaming = true
    const emit = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n') }

    // Detect a REAL client disconnect. (req.destroyed is useless here — Node
    // marks the request stream destroyed as soon as its body is consumed,
    // which express.json() already did. That false positive aborted whole
    // uploads at file zero.) The response's 'close' before writableEnded is
    // the actual browser-went-away signal.
    let clientGone = false
    res.on('close', () => { if (!res.writableEnded) clientGone = true })

    console.log(`[vision-upload] START ${plan.localFolder} → ${plan.visionFolder}: ${plan.newFiles.length} file(s), ${Math.round(plan.totalNewBytes / 1e6)}MB (${plan.existingCount} already on Vision, skipped)`)
    emit({ type: 'plan', files: plan.newFiles.length, totalBytes: plan.totalNewBytes, skippedExisting: plan.existingCount })

    let uploaded = 0, failed = 0, doneBytes = 0
    for (const [i, f] of plan.newFiles.entries()) {
      if (clientGone) { console.warn('[vision-upload] client disconnected — stopping after current file'); break }
      const t0 = Date.now()
      emit({ type: 'file-start', index: i, rel: f.rel, size: f.size })
      try {
        // Last-instant add-only check — a put would replace silently.
        if (await visionStat(f.dest)) {
          failed++
          emit({ type: 'file-error', index: i, rel: f.rel, error: 'Appeared on Vision since preview — not overwriting' })
          continue
        }
        let lastEmit = 0
        await visionUploadFile(f.dest, f.abs, typeFor(f.rel), (loaded) => {
          const now = Date.now()
          if (now - lastEmit > 500 || loaded >= f.size) {
            lastEmit = now
            emit({ type: 'progress', index: i, rel: f.rel, loaded, size: f.size, overallDone: doneBytes + loaded, overallTotal: plan.totalNewBytes })
          }
        })
        const check = await visionStat(f.dest)
        if (!check || check.size !== f.size) throw new Error(`post-upload verify failed (stored size ${check?.size ?? 'missing'} vs local ${f.size})`)
        uploaded++
        doneBytes += f.size
        const seconds = Math.round((Date.now() - t0) / 1000)
        console.log(`[vision-upload] ✓ ${f.rel} → ${f.dest} (${Math.round(f.size / 1e6)}MB in ${seconds}s)`)
        emit({ type: 'file-done', index: i, rel: f.rel, seconds })
      } catch (e) {
        failed++
        console.warn(`[vision-upload] ✗ ${f.rel}: ${e.message}`)
        emit({ type: 'file-error', index: i, rel: f.rel, error: e.message })
      }
    }

    console.log(`[vision-upload] DONE: ${uploaded} uploaded${failed ? `, ${failed} FAILED` : ''}`)
    emit({ type: 'done', ok: failed === 0, uploaded, failed, skippedExisting: plan.existingCount,
           note: uploaded ? 'New files are not searchable until the Vision index is rebuilt (Vision tab → Reindex).' : undefined })
    res.end()
  } catch (e) {
    console.error('[vision-upload] upload failed:', e.message)
    if (streaming) { if (!res.writableEnded) { res.write(JSON.stringify({ type: 'done', ok: false, error: e.message }) + '\n'); res.end() } }
    else res.status(e.status || 500).json({ error: e.message })
  }
})

export default router
