/**
 * scripts/fill-streamer-codes.mjs — fill the ISRC/UPC gaps we can already
 * answer, so those tracks stop being hidden by the eligibility rule.
 *
 * Sources, in order of trust: Music Arena Master (canonical), then the
 * metadata cache (Ingrooves extract + Alex's register). Barcodes are
 * album-level, so a catalogue's barcode fills every track on it.
 *
 * Fills EMPTY fields only, and only where a match is exact on catalogue +
 * normalised title. Never overwrites. Dry run unless --apply.
 */
import 'dotenv/config'

const APPLY = process.argv.includes('--apply')
const SB = 'https://digitalcupboard.fmcloud.fm/fmi/data/vLatest/databases/MadStreamer'
const sAuth = 'Basic ' + Buffer.from(
  (process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER) + ':' +
  (process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS)).toString('base64')

const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const key = c => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const has = v => String(v ?? '').trim() !== ''

// MAM
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
const mAuth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const ms = await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: mAuth }, body: '{}' })).json()
const MH = { Authorization: 'Bearer ' + ms.response.token }
const mam = new Map()
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${MB}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: MH })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData, k = key(g['Album Catalogue']); if (!k) continue
    if (!mam.has(k)) mam.set(k, [])
    mam.get(k).push({ t: tn(g['Track Name']), isrc: g.ISRC })
  }
}
await fetch(MB + '/sessions/' + ms.response.token, { method: 'DELETE', headers: MH })

const mc = await import('../lib/metadata-cache.js')
await mc.loadMetadata()
const cache = new Map()
for (const r of mc.getAllRows()) {
  const k = key(r.catalogue); if (!k) continue
  if (!cache.has(k)) cache.set(k, [])
  cache.get(k).push({ t: tn(r.track_name), isrc: r.isrc, barcode: r.barcode })
}

// Streamer, live
const s = await (await fetch(SB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: sAuth }, body: '{}' })).json()
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.response.token }

const plan = []
let scanned = 0
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${SB}/layouts/API_Album_Songs/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData; scanned++
    const needIsrc = !has(g.ISRC), needUpc = !has(g.UPC)
    if (!needIsrc && !needUpc) continue
    // A cover is still required to be shown, so filling codes on a coverless
    // track changes nothing visible — skip it and keep the run honest.
    const cover = String(g['Tape Files::Artwork_S3_URL'] || '')
    if (!/^https?:\/\//.test(cover)) continue

    const k = key(g['Album Catalogue Number'] || g['Reference Catalogue Number'] || g['Tape Files::Reference Catalogue Number'])
    const t = tn(g['Track Name'])
    const fd = {}
    if (needIsrc) {
      const hit = (mam.get(k) || []).find(z => z.t === t && has(z.isrc))
                || (cache.get(k) || []).find(z => z.t === t && has(z.isrc))
      if (hit) fd.ISRC = String(hit.isrc).trim()
    }
    if (needUpc) {
      const bar = (cache.get(k) || []).find(z => has(z.barcode))
      if (bar) fd.UPC = String(bar.barcode).trim()
    }
    // Only worth writing if it makes the track VISIBLE — both codes present after.
    const willHaveIsrc = has(g.ISRC) || has(fd.ISRC)
    const willHaveUpc  = has(g.UPC)  || has(fd.UPC)
    if (!Object.keys(fd).length || !willHaveIsrc || !willHaveUpc) continue
    plan.push({ recordId: x.recordId, cat: g['Album Catalogue Number'] || '', title: g['Track Name'], fd })
  }
  if (scanned % 20000 === 0) process.stderr.write(`  scanned ${scanned}…\n`)
}

console.log(`scanned            : ${scanned}`)
console.log(`tracks made visible: ${plan.length}`)
console.log(`  ISRC written     : ${plan.filter(p => p.fd.ISRC).length}`)
console.log(`  UPC written      : ${plan.filter(p => p.fd.UPC).length}`)
const byCat = new Map()
for (const p of plan) byCat.set(p.cat, (byCat.get(p.cat) || 0) + 1)
console.log('\ntop catalogues recovered:')
for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(c).padEnd(16)} ${n}`)

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Add --apply')
  await fetch(SB + '/sessions/' + s.response.token, { method: 'DELETE', headers: H })
  process.exit(0)
}
let ok = 0, fail = 0
for (const p of plan) {
  const w = await fetch(`${SB}/layouts/API_Album_Songs/records/${p.recordId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: p.fd }) })
  const j = await w.json()
  j?.messages?.[0]?.code === '0' ? ok++ : (fail++, fail < 5 && console.warn('  FAIL', p.recordId, j?.messages?.[0]?.message))
}
console.log(`\nwritten ${ok}, failed ${fail}`)
await fetch(SB + '/sessions/' + s.response.token, { method: 'DELETE', headers: H })
