// ============================================================================
// scripts/cms-vision-letterize.mjs — insert an A–Z layer into
// "CMS Recovered WAVs" so no directory level exceeds ~1000 entries (the
// Vision backend's grouped-listing pagination is broken past 1000 subfolders).
//
//   node scripts/cms-vision-letterize.mjs
//
// Renames each artist FOLDER server-side (copy-verify-delete per object,
// via visionRename): .../CMS Recovered WAVs/Lucky Dube/… →
// .../CMS Recovered WAVs/L/Lucky Dube/…  Resumable: already-moved folders
// are recognised and skipped.
// ============================================================================
import 'dotenv/config'
import { readFileSync, appendFileSync, existsSync } from 'fs'
import { visionRename, visionStat, visionListKeys } from '../lib/vision-drive.js'

const LOGSRC = '/Users/ianosrin/Desktop/Ian stuff/cms-vision-recover-log.jsonl'
const LOG = '/Users/ianosrin/Desktop/Ian stuff/cms-vision-letterize-log.jsonl'
const ROOT = '/gallo-music-files-wavs/CMS Recovered WAVs'

const letter = (artist) => {
  const m = String(artist).match(/[A-Za-z0-9]/)
  if (!m) return 'Misc'
  return /\d/.test(m[0]) ? '0-9' : m[0].toUpperCase()
}

// artist folders from the recovery log's destination keys
const artists = new Set()
for (const line of readFileSync(LOGSRC, 'utf8').split('\n')) {
  try {
    const e = JSON.parse(line)
    if (e.status !== 'uploaded' && e.status !== 'exists') continue
    const rel = e.dest.slice(ROOT.length + 1)
    const artist = rel.split('/')[0]
    if (artist && !/^[A-Z]$|^0-9$|^Misc$/.test(artist)) artists.add(artist)
  } catch {}
}
const done = new Set()
if (existsSync(LOG)) for (const l of readFileSync(LOG, 'utf8').split('\n')) {
  try { const e = JSON.parse(l); if (e.status === 'moved' || e.status === 'already') done.add(e.artist) } catch {}
}
console.log(`[letterize] ${artists.size} artist folders, ${done.size} already done`)

let moved = 0, failed = 0
for (const artist of [...artists].sort()) {
  if (done.has(artist)) continue
  const from = `${ROOT}/${artist}`
  const to = `${ROOT}/${letter(artist)}/${artist}`
  const ts = new Date().toISOString()
  try {
    await visionRename(from, to)
    appendFileSync(LOG, JSON.stringify({ artist, to, status: 'moved', ts }) + '\n')
    moved++
    if (moved % 25 === 0) console.log(`[letterize] ${moved} moved, ${failed} failed — ${artist}`)
  } catch (err) {
    // "Nothing to rename" + files already present at destination = done earlier
    if (/Nothing to rename/i.test(err.message)) {
      const probe = await visionListKeys(to).catch(() => [])
      if ((probe.length ?? probe.size ?? 0) > 0) {
        appendFileSync(LOG, JSON.stringify({ artist, to, status: 'already', ts }) + '\n')
        continue
      }
    }
    failed++
    appendFileSync(LOG, JSON.stringify({ artist, status: 'failed', error: String(err.message), ts }) + '\n')
    console.warn(`[letterize] FAIL ${artist}: ${err.message}`)
  }
}
console.log(`[letterize] DONE: ${moved} folders moved, ${failed} failed. Log → ${LOG}`)
