/**
 * scripts/hidden-worklist.mjs — the songs the ISRC+UPC+cover rule would hide,
 * grouped by catalogue, with what each one is actually missing.
 *
 * Built from the cached Streamer scan (tmp/streamer-hidden.json) plus MAM and
 * the metadata cache, so it shows what is FIXABLE from what we hold versus what
 * needs a code allocating. Emits JSON for the workbook step. Read-only.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'

const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const key = c => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const has = v => String(v ?? '').trim() !== ''

const { hidden } = JSON.parse(readFileSync('tmp/streamer-hidden.json', 'utf8'))

// MAM — the canonical catalogue
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const mAuth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const ms = await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: mAuth }, body: '{}' })).json()
const MH = { Authorization: 'Bearer ' + ms.response.token }
const mamByCat = new Map()
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${MB}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: MH })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData, k = key(g['Album Catalogue']); if (!k) continue
    if (!mamByCat.has(k)) mamByCat.set(k, [])
    mamByCat.get(k).push({ title: tn(g['Track Name']), isrc: g.ISRC })
  }
}
await fetch(MB + '/sessions/' + ms.response.token, { method: 'DELETE', headers: MH })

const mc = await import('../lib/metadata-cache.js')
await mc.loadMetadata()
const cacheByCat = new Map()
for (const r of mc.getAllRows()) {
  const k = key(r.catalogue); if (!k) continue
  if (!cacheByCat.has(k)) cacheByCat.set(k, [])
  cacheByCat.get(k).push({ title: tn(r.track_name), isrc: r.isrc, barcode: r.barcode })
}

// A medley is the commonest unissuable shape in the vault: several songs in one
// band, which never had an ISRC because it was never a release in its own right.
const looksMedley = t => /,/.test(t) && /\band\b|&|\+/i.test(t)

const rows = hidden.map(h => {
  const k = key(h.cat), t = tn(h.title)
  const mamHit = (mamByCat.get(k) || []).find(r => r.title === t)
  const cacheHit = (cacheByCat.get(k) || []).find(r => r.title === t)
  const cacheAny = (cacheByCat.get(k) || [])[0]
  const isrcFix = has(mamHit?.isrc) ? 'MAM' : has(cacheHit?.isrc) ? 'cache' : ''
  const upcFix  = has(cacheAny?.barcode) ? 'cache' : ''
  const still = h.missing.filter(m =>
    (m === 'isrc' && !isrcFix) || (m === 'upc' && !upcFix) || m === 'cover')
  return { ...h, isrcFix, upcFix, still, medley: looksMedley(h.title) }
})

const byCat = new Map()
for (const r of rows) {
  const c = r.cat || '(no catalogue)'
  if (!byCat.has(c)) byCat.set(c, { cat: c, artist: r.artist, tracks: [], })
  byCat.get(c).tracks.push(r)
}
const cats = [...byCat.values()].map(g => ({
  cat: g.cat, artist: g.artist, hidden: g.tracks.length,
  noIsrc: g.tracks.filter(t => t.missing.includes('isrc')).length,
  noUpc:  g.tracks.filter(t => t.missing.includes('upc')).length,
  noCover:g.tracks.filter(t => t.missing.includes('cover')).length,
  fixable: g.tracks.filter(t => !t.still.length).length,
  medleys: g.tracks.filter(t => t.medley).length,
})).sort((a, b) => b.hidden - a.hidden)

writeFileSync('tmp/hidden-worklist.json', JSON.stringify({ rows, cats }, null, 0))
console.log('tracks hidden      :', rows.length)
console.log('catalogues affected:', cats.length)
console.log('fully fixable now  :', rows.filter(r => !r.still.length).length)
console.log('look like medleys  :', rows.filter(r => r.medley).length)
console.log('\nworst catalogues:')
for (const c of cats.slice(0, 10)) console.log(`   ${String(c.cat).padEnd(16)} ${String(c.hidden).padStart(4)} hidden  (${c.artist || ''})`.slice(0, 90))
