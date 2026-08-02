#!/usr/bin/env node
/**
 * Backfill the Audio_URL field on Gallo Catalogue records with the Vision
 * reference parsed from their existing audio container. Once populated, the
 * mount-era container is retireable (the resolver reads Audio_URL first).
 *
 *   node scripts/gallo-audiourl-backfill.mjs              # DRY RUN (no writes)
 *   node scripts/gallo-audiourl-backfill.mjs --apply      # write everything
 *   node scripts/gallo-audiourl-backfill.mjs --apply --limit 20   # small batch
 *   node scripts/gallo-audiourl-backfill.mjs --apply --force      # overwrite existing
 *
 * Idempotent: skips records whose Audio_URL is already set (unless --force), so
 * it's safe to re-run / resume. Read-back verifies the FIRST few writes to catch
 * a layout-field problem early, then trusts the rest (field membership proven).
 */
import 'dotenv/config'
import { resolveGalloAudio } from '../lib/gallo-vision.js'
import { updateGalloRecord, getGalloLayoutFieldSet, getGalloFieldData } from '../lib/fm-gallo.js'

const HOST = process.env.GALLO_FM_HOST, DB = process.env.GALLO_FM_DB
const USER = process.env.GALLO_FM_USER, PASS = process.env.GALLO_FM_PASS
const LAYOUT = process.env.GALLO_FM_LAYOUT
const base = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const FIELD = process.env.GALLO_AUDIO_URL_FIELD || 'Audio_URL'

const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) : Infinity })()

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
    const r = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=${batch}&_offset=${offset}`, { headers: { Authorization: `Bearer ${token}` } })
    const data = (await r.json())?.response?.data || []
    if (!data.length) break
    yield data
    if (data.length < batch) break
    offset += data.length
  }
}
async function pMap(items, fn, c = 5) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(c, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

// Pre-flight: field must be on the layout or every write is silently discarded.
const known = await getGalloLayoutFieldSet()
if (!known.has(FIELD)) { console.error(`✖ Field "${FIELD}" is not on the ${LAYOUT} layout — add it in FileMaker first.`); process.exit(1) }

const token = await login()
console.log(`Backfill "${FIELD}" — ${APPLY ? 'APPLY' : 'DRY RUN'}${FORCE ? ' --force' : ''}${LIMIT !== Infinity ? ` --limit ${LIMIT}` : ''}\n`)

// 1. Collect the work list.
const todo = []
let total = 0, already = 0, unresolvable = 0
for await (const page of pageRecords(token)) {
  for (const rec of page) {
    total++
    const f = rec.fieldData || {}
    const has = String(f[FIELD] || '').trim()
    if (has && !FORCE) { already++; continue }
    const r = resolveGalloAudio(f)
    if (!r.ok) { unresolvable++; continue }
    todo.push({ recordId: String(rec.recordId), value: r.kind === 'url' ? r.url : r.path, kind: r.kind })
  }
  process.stdout.write(`\r  scanned ${total}…`)
}
console.log(`\r  scanned ${total} records.            `)
const work = todo.slice(0, LIMIT)
console.log(`  already set:   ${already}`)
console.log(`  unresolvable:  ${unresolvable}`)
console.log(`  to backfill:   ${todo.length}${LIMIT !== Infinity ? ` (this run: ${work.length})` : ''}`)
console.log(`    vision refs: ${work.filter(w => w.kind === 'vision').length}   url refs: ${work.filter(w => w.kind === 'url').length}`)

if (!APPLY) {
  console.log('\nSample:'); work.slice(0, 5).forEach(w => console.log(`  rec ${w.recordId} → ${w.value}`))
  console.log('\n(dry run — nothing written. Re-run with --apply)')
  await fetch(`${base}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
  process.exit(0)
}

// 2. Write, verifying the first few.
let written = 0, failed = 0, notPersisted = 0, n = 0
await pMap(work, async (w) => {
  try {
    await updateGalloRecord(w.recordId, { [FIELD]: w.value })
    if (n++ < 5) { // verify the first handful
      const after = await getGalloFieldData(w.recordId)
      if ((after?.[FIELD] || '') !== w.value) { notPersisted++; return }
    }
    written++
  } catch (e) { failed++; if (failed <= 5) console.error(`\n  ✖ rec ${w.recordId}: ${e.message}`) }
  if ((written + failed) % 250 === 0) process.stdout.write(`\r  written ${written}, failed ${failed}…`)
}, 5)

console.log(`\r  written ${written}, failed ${failed}${notPersisted ? `, NOT-PERSISTED ${notPersisted}` : ''}        `)
if (notPersisted) console.log('  ⚠ some writes did not persist — check the layout field.')
console.log('Done.')
await fetch(`${base}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
process.exit(0)
