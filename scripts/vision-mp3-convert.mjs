/**
 * scripts/vision-mp3-convert.mjs
 *
 * Transcode Vision master WAVs to 320k MP3 and put them on the MAD streamer
 * bucket, filling the gap for songs that have a master but no streamable copy.
 *
 * Follows the cms-vision-recover.mjs doctrine: ADD-ONLY (an existing key is
 * never overwritten), verify-after-put, resumable from the JSONL log, and
 * nothing is staged on disk beyond one temp file at a time.
 *
 * The mp3 key is the song's Filename field — that is the existing convention
 * (mp3/GMVF31533.mp3), verified against 65,358 already-converted rows.
 *
 * Vision gets its OWN S3 client from lib/vision-drive.js and the destination
 * bucket its own from here, so the two never share a connection pool (the
 * 2026-07-27 incident where artwork bursts made songs hang).
 *
 *   node scripts/vision-mp3-convert.mjs --worklist <file.json> [--limit N] [--dry-run]
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { visionDownloadTo } from '../lib/vision-drive.js'

const execFileP = promisify(execFile)

const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const WORKLIST = arg('--worklist')
const LIMIT    = Number(arg('--limit', '0')) || Infinity
const DRY      = args.includes('--dry-run')
const LOG      = arg('--log', path.join(process.cwd(), 'vision-mp3-convert-log.jsonl'))

const BUCKET   = process.env.S3_IMPORTS_BUCKET || 'mass-music-audio-files'
const BASE_URL = (process.env.S3_IMPORTS_BASE_URL || '').replace(/\/$/, '')
const MP3_PREFIX = process.env.MP3_PREFIX || 'mp3/'
const BITRATE  = process.env.MP3_BITRATE || '320k'
const FFMPEG   = process.env.FFMPEG_BIN || 'ffmpeg'

// Destination client — deliberately separate from the Vision client.
const dest = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
})

const done = new Set()
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (['uploaded', 'exists', 'skipped'].includes(e.status)) done.add(e.masterID)
    } catch { /* a half-written final line is fine to ignore */ }
  }
}
const logStream = fs.createWriteStream(LOG, { flags: 'a' })
const note = o => logStream.write(JSON.stringify(o) + '\n')

async function keyExists(Key) {
  try { await dest.send(new HeadObjectCommand({ Bucket: BUCKET, Key })); return true }
  catch (e) { if (e?.$metadata?.statusCode === 404 || e.name === 'NotFound') return false; throw e }
}

const items = JSON.parse(fs.readFileSync(WORKLIST, 'utf8'))
const todo = items.filter(i => !done.has(i.MasterID)).slice(0, LIMIT)
console.log(`[convert] worklist ${items.length}, already done ${done.size}, this run ${todo.length}`)
console.log(`[convert] dest s3://${BUCKET}/${MP3_PREFIX}  bitrate ${BITRATE}${DRY ? '  (DRY RUN)' : ''}`)

let ok = 0, exists = 0, failed = 0
const t0 = Date.now()

for (const [n, it] of todo.entries()) {
  const Key = `${MP3_PREFIX}${it.Filename}.mp3`
  const tag = `[${n + 1}/${todo.length}] ${it.Filename}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2mp3-'))
  const inFile  = path.join(tmp, 'in' + (path.extname(it.VisionPath.split('?')[0]) || '.wav'))
  const outFile = path.join(tmp, 'out.mp3')
  try {
    if (await keyExists(Key)) {
      console.log(`${tag} already on s3 — skipping (add-only)`)
      note({ ts: new Date().toISOString(), masterID: it.MasterID, key: Key, status: 'exists' })
      exists++; continue
    }
    if (DRY) { console.log(`${tag} would convert ${it.VisionPath}`); continue }

    // visionDownloadTo takes the "/bucket/key" rel path as-is and pipes to a
    // writable — strip any ?query the export left on the URL.
    await visionDownloadTo(it.VisionPath.split('?')[0], fs.createWriteStream(inFile))
    const wavBytes = fs.statSync(inFile).size
    if (!wavBytes) throw new Error('source is zero bytes')

    await execFileP(FFMPEG, ['-y', '-i', inFile, '-codec:a', 'libmp3lame',
      '-b:a', BITRATE, '-id3v2_version', '3',
      '-metadata', `title=${it.Title || ''}`,
      '-metadata', `artist=${it.Artist || ''}`,
      outFile], { timeout: 20 * 60_000, maxBuffer: 50 * 1024 * 1024 })

    const mp3Bytes = fs.statSync(outFile).size
    if (!mp3Bytes) throw new Error('ffmpeg produced an empty file')

    await dest.send(new PutObjectCommand({
      Bucket: BUCKET, Key, Body: fs.createReadStream(outFile),
      ContentType: 'audio/mpeg', ContentLength: mp3Bytes,
    }))

    // verify-after-put: trust the store, not the call that wrote to it
    const head = await dest.send(new HeadObjectCommand({ Bucket: BUCKET, Key }))
    if (head.ContentLength !== mp3Bytes) throw new Error(`size mismatch: put ${mp3Bytes}, store has ${head.ContentLength}`)

    const url = `${BASE_URL}/${Key}`
    console.log(`${tag} ${(wavBytes / 1048576).toFixed(1)}MB wav -> ${(mp3Bytes / 1048576).toFixed(1)}MB mp3  ok`)
    note({ ts: new Date().toISOString(), masterID: it.MasterID, filename: it.Filename,
           visionPath: it.VisionPath, key: Key, url, wavBytes, mp3Bytes, status: 'uploaded' })
    ok++
  } catch (err) {
    console.log(`${tag} FAILED: ${err.message}`)
    note({ ts: new Date().toISOString(), masterID: it.MasterID, filename: it.Filename,
           visionPath: it.VisionPath, error: String(err.message), status: 'failed' })
    failed++
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1)
console.log(`\n[convert] uploaded ${ok}, already there ${exists}, failed ${failed}  in ${mins} min`)
console.log(`[convert] log: ${LOG}`)
logStream.end()
