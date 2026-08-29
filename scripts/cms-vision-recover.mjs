// ============================================================================
// scripts/cms-vision-recover.mjs — stream CMS container audio up to Vision.
//
//   node scripts/cms-vision-recover.mjs --manifest <path> [--limit N]
//
// For each manifest entry: validate the audio where it sits (read-only on the
// FM store), skip anything already on Vision (add-only), stream the upload,
// stat-verify the landed size, append one JSONL log line. Zero staging space;
// resumable — a re-run skips everything the log or Vision already has.
// Manifest entries: { masterID, tier, src, dest, duration, track }.
// ============================================================================
import 'dotenv/config'
import { readFileSync, appendFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'fs'
import { visionStat, visionUploadFile } from '../lib/vision-drive.js'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : dflt
}
const MANIFEST = arg('--manifest')
const LIMIT = parseInt(arg('--limit', '0'), 10) || 0
const LOG = arg('--log', '/Users/ianosrin/Desktop/Ian stuff/cms-vision-recover-log.jsonl')
if (!MANIFEST) { console.error('usage: node scripts/cms-vision-recover.mjs --manifest <path> [--limit N]'); process.exit(1) }

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const done = new Set()
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e.status === 'uploaded' || e.status === 'exists') done.add(e.dest) } catch {}
  }
}
console.log(`[recover] ${manifest.length} entries, ${done.size} already logged done${LIMIT ? `, limit ${LIMIT}` : ''}`)

// Light WAV sanity: RIFF/WAVE magic + fmt/data chunks + duration from sizes.
function wavInfo(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(12)
    readSync(fd, head, 0, 12, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null
    const size = statSync(path).size
    let off = 12, fmt = null, dataSz = null
    const ch = Buffer.alloc(8)
    while (off + 8 <= size) {
      readSync(fd, ch, 0, 8, off)
      const id = ch.toString('ascii', 0, 4), sz = ch.readUInt32LE(4)
      if (id === 'fmt ') {
        const f = Buffer.alloc(16)
        readSync(fd, f, 0, 16, off + 8)
        fmt = { ch: f.readUInt16LE(2), rate: f.readUInt32LE(4), byteRate: f.readUInt32LE(8) }
      }
      if (id === 'data') { dataSz = Math.min(sz, size - off - 8) }
      off += 8 + sz + (sz % 2)
    }
    if (!fmt || !fmt.byteRate || dataSz == null) return null
    return { seconds: dataSz / fmt.byteRate, rate: fmt.rate, channels: fmt.ch }
  } finally { closeSync(fd) }
}

const durSec = (v) => {
  const m = String(v || '').match(/^(\d+):(\d\d?)(?::(\d\d?))?$/)
  if (m) { const p = m.slice(1).filter(Boolean).map(Number); return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + p[1] }
  const f = parseFloat(v); return Number.isFinite(f) ? f : null
}
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + '\n')

let uploaded = 0, skipped = 0, failed = 0, bytes = 0
const t0 = Date.now()
for (const e of manifest) {
  if (LIMIT && uploaded >= LIMIT) break
  if (done.has(e.dest)) { skipped++; continue }
  const stamp = new Date().toISOString()
  try {
    const size = statSync(e.src).size
    if (!size) throw new Error('zero-byte source')
    let note = ''
    if (e.src.toLowerCase().endsWith('.wav')) {
      const info = wavInfo(e.src)
      if (!info) throw new Error('not a valid WAV (header unreadable)')
      const want = durSec(e.duration)
      if (want && Math.abs(info.seconds - want) > 5) note = `duration ${info.seconds.toFixed(0)}s vs record ${want.toFixed(0)}s`
    }
    const existing = await visionStat(e.dest)
    if (existing) { log({ ...e, status: 'exists', size: existing.size, ts: stamp }); skipped++; continue }
    const type = e.src.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'
    await visionUploadFile(e.dest, e.src, type)
    const landed = await visionStat(e.dest)
    if (!landed || landed.size !== size) throw new Error(`post-upload verify failed (${landed ? landed.size : 'missing'} vs ${size})`)
    log({ ...e, status: 'uploaded', size, note, ts: stamp })
    uploaded++; bytes += size
    if (uploaded % 25 === 0 || LIMIT) {
      const mb = bytes / 1e6, mins = (Date.now() - t0) / 60000
      console.log(`[recover] ${uploaded} up (${mb.toFixed(0)}MB, ${(mb / 1e3 / (mins / 60)).toFixed(1)}GB/h), ${skipped} skipped, ${failed} failed — ${e.dest.split('/').slice(-2).join('/')}${note ? '  ⚠ ' + note : ''}`)
    }
  } catch (err) {
    failed++
    log({ ...e, status: 'failed', error: String(err.message || err), ts: stamp })
    console.warn(`[recover] FAIL ${e.src.split('/').pop()}: ${err.message}`)
  }
}
console.log(`[recover] DONE: ${uploaded} uploaded (${(bytes / 1e9).toFixed(1)}GB), ${skipped} skipped, ${failed} failed, log → ${LOG}`)
