/**
 * scripts/streamer-eligibility-audit.mjs — how much of what the app would hide
 * can we actually FIX, before we hide anything.
 *
 * Client rule (2026-09-02): a song must have an ISRC, a UPC/barcode AND a cover
 * or it never renders. That removes one song in five, so the question that
 * matters first is how many of those are simply missing data we already hold
 * somewhere else.
 *
 * Sources checked, in the order they are trusted:
 *   1. Music Arena Master — the canonical catalogue
 *   2. the metadata cache  — Ingrooves extract + Alex's ISRC register
 *
 * Read-only. Writes nothing.
 */
import 'dotenv/config'

const SB = 'https://digitalcupboard.fmcloud.fm/fmi/data/vLatest/databases/MadStreamer'
const sAuth = 'Basic ' + Buffer.from(
  (process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER) + ':' +
  (process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS)).toString('base64')

const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const key = c => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const has = v => String(v ?? '').trim() !== ''

// ── 1. every Streamer song that the rule would hide ─────────────────────────
const s = await (await fetch(SB + '/sessions', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: sAuth }, body: '{}' })).json()
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.response.token }

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const CACHE = 'tmp/streamer-hidden.json'

let hidden = []
let seen = 0
if (existsSync(CACHE) && !process.argv.includes('--rescan')) {
  const c = JSON.parse(readFileSync(CACHE, 'utf8'))
  hidden = c.hidden; seen = c.seen
  console.log('(reusing the cached Streamer scan — pass --rescan to redo it)')
} else {
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${SB}/layouts/API_Album_Songs/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []
  if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData
    seen++
    const missing = []
    if (!has(g.ISRC)) missing.push('isrc')
    if (!has(g.UPC)) missing.push('upc')
    if (!has(g['Tape Files::Artwork_S3_URL'])) missing.push('cover')
    if (!missing.length) continue
    hidden.push({
      recordId: x.recordId, missing,
      cat: g['Album Catalogue Number'] || g['Reference Catalogue Number'] || g['Tape Files::Reference Catalogue Number'] || '',
      title: g['Track Name'] || '', artist: g['Track Artist'] || g['Album Artist'] || '',
      filename: g.Filename || '',
    })
  }
  if (seen % 10000 === 0) process.stderr.write(`  scanned ${seen}…\n`)
}
await fetch(SB + '/sessions/' + s.response.token, { method: 'DELETE', headers: H })
writeFileSync(CACHE, JSON.stringify({ seen, hidden }))
}
console.log(`streamer songs scanned : ${seen}`)
console.log(`would be HIDDEN        : ${hidden.length}`)
for (const m of ['isrc', 'upc', 'cover']) {
  console.log(`   missing ${m.padEnd(6)}      : ${hidden.filter(h => h.missing.includes(m)).length}`)
}
console.log(`   missing a catalogue : ${hidden.filter(h => !h.cat).length}  (unfixable by lookup)`)

// ── 2. what MAM can supply ──────────────────────────────────────────────────
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const mAuth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const ms = await (await fetch(MB + '/sessions', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: mAuth }, body: '{}' })).json()
const MH = { Authorization: 'Bearer ' + ms.response.token }
const mamByCat = new Map()
let mamRows = 0
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${MB}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: MH })).json()
  const rows = r?.response?.data || []
  if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData
    mamRows++
    const k = key(g['Album Catalogue'])
    if (!k) continue
    if (!mamByCat.has(k)) mamByCat.set(k, [])
    mamByCat.get(k).push({ title: tn(g['Track Name']), isrc: g.ISRC })
  }
}
await fetch(MB + '/sessions/' + ms.response.token, { method: 'DELETE', headers: MH })
console.log(`MAM songs read         : ${mamRows}`)
console.log(`\nMAM catalogues loaded  : ${mamByCat.size}`)

// ── 3. what the metadata cache can supply ───────────────────────────────────
const mc = await import('../lib/metadata-cache.js')
await mc.loadMetadata()
const cacheByCat = new Map()
for (const r of mc.getAllRows()) {
  const k = key(r.catalogue)
  if (!k) continue
  if (!cacheByCat.has(k)) cacheByCat.set(k, [])
  cacheByCat.get(k).push({ title: tn(r.track_name), isrc: r.isrc, barcode: r.barcode })
}
console.log(`cache catalogues loaded: ${cacheByCat.size}`)

// ── 4. how many holes can be filled ─────────────────────────────────────────
let fixIsrc = 0, fixUpc = 0, fixBoth = 0, stuck = 0
const stuckSample = []
for (const h of hidden) {
  const k = key(h.cat)
  const t = tn(h.title)
  const mamHit   = (mamByCat.get(k)   || []).find(r => r.title === t)
  const cacheHit = (cacheByCat.get(k) || []).find(r => r.title === t)
  const cacheAny = (cacheByCat.get(k) || [])[0]          // barcode is album-level
  const canIsrc = h.missing.includes('isrc') && (has(mamHit?.isrc) || has(cacheHit?.isrc))
  const canUpc  = h.missing.includes('upc')  && has(cacheAny?.barcode)
  if (canIsrc) fixIsrc++
  if (canUpc)  fixUpc++
  if (canIsrc && canUpc) fixBoth++
  const stillMissing = h.missing.filter(m =>
    (m === 'isrc' && !canIsrc) || (m === 'upc' && !canUpc) || m === 'cover')
  if (stillMissing.length) { stuck++; if (stuckSample.length < 8) stuckSample.push({ ...h, stillMissing }) }
}
console.log(`\n── what can be fixed from what we already hold ──`)
console.log(`  ISRC recoverable     : ${fixIsrc}`)
console.log(`  UPC recoverable      : ${fixUpc}`)
console.log(`  both recoverable     : ${fixBoth}`)
console.log(`  still short after fix: ${stuck}`)
console.log('\n  examples still short:')
for (const x of stuckSample) console.log(`    ${(x.cat||'(no cat)').padEnd(14)} ${String(x.title).slice(0,32).padEnd(34)} missing: ${x.stillMissing.join(', ')}`)
