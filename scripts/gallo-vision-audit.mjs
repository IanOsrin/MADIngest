#!/usr/bin/env node
/**
 * READ-ONLY audit: for every Gallo Catalogue record, resolve its audio to a
 * Vision address and score the catalogue. Verifies a spread of records against
 * Vision (existence) rather than all 43k. Writes an xlsx of the problems.
 *
 *   node scripts/gallo-vision-audit.mjs [verifySample=600]
 *
 * Writes nothing to FileMaker or Vision.
 */
import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolveGalloAudio } from '../lib/gallo-vision.js'
import { visionStat } from '../lib/vision-drive.js'

const HOST = process.env.GALLO_FM_HOST, DB = process.env.GALLO_FM_DB
const USER = process.env.GALLO_FM_USER, PASS = process.env.GALLO_FM_PASS
const LAYOUT = process.env.GALLO_FM_LAYOUT
const base = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const VERIFY_SAMPLE = Number(process.argv[2] || 600)

const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
async function login() {
  const r = await fetch(`${base}/sessions`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' })
  const t = (await r.json())?.response?.token
  if (!t) throw new Error('FM login failed')
  return t
}

async function* pageRecords(token, batch = 1000) {
  let offset = 1
  for (;;) {
    const r = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=${batch}&_offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } })
    const j = await r.json()
    const data = j?.response?.data || []
    if (!data.length) break
    yield data
    if (data.length < batch) break
    offset += data.length
  }
}

// bounded-concurrency map
async function pMap(items, fn, concurrency = 8) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx) }
  }))
  return out
}

const token = await login()
console.log(`Auditing ${LAYOUT} …`)

const buckets = { resolved: [], url: [], noAudio: [], unparseable: [] }
const byVisionBucket = {}
let total = 0

for await (const page of pageRecords(token)) {
  for (const rec of page) {
    total++
    const f = rec.fieldData || {}
    const r = resolveGalloAudio(f)
    const row = {
      recordId: String(rec.recordId), gcat: f['Filename'] || null,
      catalogue: f['Album Catalogue Number'] || null, track: f['Track Name'] || null,
    }
    if (r.ok && r.kind === 'url') buckets.url.push({ ...row, url: r.url })
    else if (r.ok) {
      buckets.resolved.push({ ...row, bucket: r.bucket, key: r.key, path: r.path, source: r.source })
      byVisionBucket[r.bucket] = (byVisionBucket[r.bucket] || 0) + 1
    } else if (r.reason === 'no-audio-field') buckets.noAudio.push(row)
    else buckets.unparseable.push({ ...row, source: r.source, sample: String(f['Audio File'] || f['Pending Audio Path'] || '').slice(0, 140) })
  }
  process.stdout.write(`\r  read ${total}…`)
}
console.log(`\r  read ${total} records.        `)

// Verify a spread of the resolved ones actually exist on Vision.
const sample = []
const step = Math.max(1, Math.floor(buckets.resolved.length / VERIFY_SAMPLE))
for (let i = 0; i < buckets.resolved.length; i += step) sample.push(buckets.resolved[i])
console.log(`Verifying ${sample.length} of ${buckets.resolved.length} resolved records against Vision …`)
let present = 0
const missing = []
await pMap(sample, async (row) => {
  try { const st = await visionStat(row.path); if (st) present++; else missing.push(row) }
  catch { missing.push(row) }
}, 8)

// ── Scorecard ────────────────────────────────────────────────────────────────
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`
console.log(`\n═══ Gallo Catalogue → Vision audit ═══`)
console.log(`Total records:            ${total}`)
console.log(`Resolved to Vision path:  ${buckets.resolved.length}  (${pct(buckets.resolved.length)})`)
console.log(`Stored as http(s) URL:    ${buckets.url.length}  (${pct(buckets.url.length)})`)
console.log(`No audio field at all:    ${buckets.noAudio.length}  (${pct(buckets.noAudio.length)})`)
console.log(`Audio present, unparseable: ${buckets.unparseable.length}  (${pct(buckets.unparseable.length)})`)
console.log(`\nResolved records by Vision bucket:`)
for (const [b, n] of Object.entries(byVisionBucket).sort((a, c) => c[1] - a[1])) console.log(`  ${b}: ${n}`)
console.log(`\nVision existence check (sample of ${sample.length}):`)
console.log(`  present on Vision: ${present}   missing/error: ${missing.length}`)

// ── Spreadsheet of the problems ──────────────────────────────────────────────
const { default: XLSX } = await import('xlsx').catch(() => ({ default: null }))
if (XLSX) {
  const wb = XLSX.utils.book_new()
  const sheet = (name, rows) => rows.length && XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name)
  sheet('Unparseable', buckets.unparseable)
  sheet('No audio field', buckets.noAudio)
  sheet('Missing on Vision (sample)', missing)
  sheet('URL-based', buckets.url)
  const out = path.join(process.env.HOME, 'Downloads', 'gallo-vision-audit.xlsx')
  XLSX.writeFile(wb, out)
  console.log(`\nProblem records written to ${out}`)
} else {
  console.log('\n(xlsx module not found — skipped spreadsheet)')
}

await fetch(`${base}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
