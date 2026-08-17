#!/usr/bin/env node
/**
 * scripts/sidecar-sweep.mjs — find (and optionally delete) audio-editor sidecar
 * files on Vision: waveform caches, peak files, markers, editor scratch temps.
 *
 * DRY RUN BY DEFAULT. It prints what it would remove and exits:
 *   node scripts/sidecar-sweep.mjs
 *   node scripts/sidecar-sweep.mjs --ext gpk,peak,mrk,'$$$'
 *   node scripts/sidecar-sweep.mjs --delete          ← actually deletes
 *
 * Deliberately a script and not an API route: "delete everything matching a
 * pattern, drive-wide" is not a button anyone should have, and this is a
 * one-off tidy-up rather than an ongoing operation.
 */
import 'dotenv/config'
import { visionList, visionAllKeys } from '../lib/vision-drive.js'
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import https from 'https'

const argv = process.argv.slice(2)
const DO_DELETE = argv.includes('--delete')
const extArg = argv.includes('--ext') ? argv[argv.indexOf('--ext') + 1] : 'gpk,peak,mrk,$$$'
const EXTS = extArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

// Anchored at the end and preceded by a dot, so a folder merely NAMED "peak"
// is never matched — only a real extension.
const RE = new RegExp(`\\.(${EXTS.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i')

const s3 = () => new S3Client({
  endpoint: (process.env.VISION_ENDPOINT || '').replace(/\/$/, ''),
  region: process.env.VISION_REGION || 'us-east-1',
  credentials: { accessKeyId: process.env.VISION_ACCESS_KEY, secretAccessKey: process.env.VISION_SECRET_KEY },
  forcePathStyle: true,
  ...(String(process.env.VISION_INSECURE_TLS || '') === 'true'
    ? { requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ rejectUnauthorized: false }) }) }
    : {}),
})

const human = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB'

const { entries } = await visionList('/')
const buckets = (entries || []).filter(e => e.type === 'dir' || e.isDir).map(e => e.name)

const byExt = new Map(), byFolder = new Map()
const victims = []          // { bucket, key, size }
let scanned = 0

for (const bucket of buckets) {
  process.stderr.write(`scanning ${bucket}…\n`)
  const keys = await visionAllKeys(bucket, {})
  scanned += keys.length
  for (const k of keys) {
    if (!RE.test(k.key)) continue
    const ext = k.key.slice(k.key.lastIndexOf('.') + 1).toLowerCase()
    byExt.set(ext, (byExt.get(ext) || { n: 0, bytes: 0 }))
    byExt.get(ext).n++; byExt.get(ext).bytes += k.size || 0
    const folder = `${bucket}/${k.key.split('/')[0]}`
    byFolder.set(folder, (byFolder.get(folder) || 0) + 1)
    victims.push({ bucket, key: k.key, size: k.size || 0 })
  }
}

const totalBytes = victims.reduce((a, v) => a + v.size, 0)
console.log(`\nscanned ${scanned.toLocaleString()} objects across ${buckets.length} bucket(s)`)
console.log(`matched ${victims.length.toLocaleString()} sidecar files · ${human(totalBytes)}\n`)
console.log('by extension:')
for (const [e, v] of [...byExt].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  .${e.padEnd(10)} ${String(v.n).padStart(6)}  ${human(v.bytes)}`)
}
console.log('\nby top-level folder:')
for (const [f, n] of [...byFolder].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f.padEnd(52)} ${String(n).padStart(6)}`)
}
console.log('\nsample of what would go:')
for (const v of victims.slice(0, 8)) console.log(`  /${v.bucket}/${v.key}`)

// A sidecar should sit beside the audio it describes. One that does not is
// worth a second look before it is destroyed, so they are reported separately.
const AUDIO_RE = /\.(wav|flac|aiff?|mp3|m4a|aac|ogg)$/i
const orphans = victims.filter(v => !AUDIO_RE.test(v.key.replace(RE, '')))
console.log(`\n${orphans.length} of them do NOT sit on top of an audio filename (e.g. "x.wav.gpk"):`)
for (const v of orphans.slice(0, 10)) console.log(`  /${v.bucket}/${v.key}`)

if (!DO_DELETE) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --delete to remove these.')
  process.exit(0)
}

console.log('\nDELETING…')
const client = s3()
let done = 0
for (const bucket of buckets) {
  const mine = victims.filter(v => v.bucket === bucket).map(v => ({ Key: v.key }))
  for (let i = 0; i < mine.length; i += 1000) {
    const batch = mine.slice(i, i + 1000)
    const r = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }))
    if (r.Errors?.length) console.error(`  ${r.Errors.length} failed, first: ${r.Errors[0].Key} — ${r.Errors[0].Message}`)
    done += batch.length - (r.Errors?.length || 0)
    process.stderr.write(`  ${done}/${victims.length}\n`)
  }
}
console.log(`\ndeleted ${done.toLocaleString()} files · ${human(totalBytes)} reclaimed`)
console.log('Re-index affected folders so search stops listing them.')
