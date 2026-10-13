/**
 * scripts/mam-cache-gaps.mjs — every MAM album and song with BLANK fields the metadata cache can fill.
 * Read-only (Ian, 2026-10-13: "find all records in Metadata Cache and compare with MAM where MAM records
 * are incomplete and Metadata contains the missing info, create a list").
 *
 * The catalogue-wide version of the MAM tab's "fill from cache" preview (lib/mam-cache-fill.js
 * planCacheFill), with the SAME rules: blanks only; songs paired by normalised TITLE, never position;
 * near-miss titles listed separately, never as fills; cache sequence numbers only when they look like a
 * track order. MAM is read once, in pages of 500 with a pause between pages, instead of one session per
 * album.
 *
 *   node scripts/mam-cache-gaps.mjs [out.json]      → JSON for the workbook step
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { songFillsFrom, albumFillsFrom, gapsOnly, tn, similarity, nn } from '../lib/mam-cache-fill.js'

const OUT = process.argv[2] || 'tmp/mam-cache-gaps.json'
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(process.env.MAM_FM_DB || 'Music Arena Master')}`
const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const catKey = (c) => String(c || '').trim().toUpperCase()

let token = null
async function login() {
  const r = await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
  token = r?.response?.token
  if (!token) throw new Error('MAM login failed: ' + JSON.stringify(r?.messages))
}
async function scan(layout) {
  const out = []
  for (let off = 1; ; off += 500) {
    let r
    for (let tries = 0; ; tries++) {
      r = await (await fetch(`${MB}/layouts/${encodeURIComponent(layout)}/records?_limit=500&_offset=${off}`, { headers: { Authorization: 'Bearer ' + token } })).json()
      const code = r?.messages?.[0]?.code
      if (code === '952' && tries < 2) { await login(); continue }     // session expired
      if (code !== '0' && code !== '401' && tries < 3) { await sleep(2000 * (tries + 1)); continue }
      break
    }
    const rows = r?.response?.data || []
    if (!rows.length) break
    out.push(...rows)
    if (off % 5000 === 1) console.log(`  ${layout}: ${out.length.toLocaleString()} read`)
    await sleep(250)
  }
  return out
}

await login()
console.log('reading MAM Albums…'); const albums = await scan(process.env.MAM_FM_ALBUMS_LAYOUT || 'Albums')
console.log('reading MAM Songs…');  const songs = await scan(process.env.MAM_FM_SONGS_LAYOUT || 'Songs')
await fetch(`${MB}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
console.log(`MAM: ${albums.length.toLocaleString()} albums, ${songs.length.toLocaleString()} songs`)

const mc = await import('../lib/metadata-cache.js')
await mc.loadMetadata()
console.log(`cache: ${mc.getStatus().count.toLocaleString()} rows`)

const songsByCat = new Map()
for (const s of songs) {
  const k = catKey(s.fieldData['Album Catalogue']); if (!k) continue
  if (!songsByCat.has(k)) songsByCat.set(k, [])
  songsByCat.get(k).push(s)
}

const albumGaps = [], songGaps = [], nearMisses = [], noCache = []
let albumsChecked = 0, songsMatched = 0
for (const a of albums) {
  const g = a.fieldData
  const cat = String(g['Album Catalogue Number'] || g['Reference Catalogue Number'] || '').trim()
  if (!cat) continue
  albumsChecked++
  const cacheRows = mc.lookupAlbumTracks(cat) || []
  const mamSongs = songsByCat.get(catKey(cat)) || []
  if (!cacheRows.length) { noCache.push({ cat, title: g['Album Title'] }); continue }

  const albumFills = gapsOnly(albumFillsFrom(cacheRows[0]), g)
  if (Object.keys(albumFills).length) albumGaps.push({ cat, recordId: a.recordId, albumId: g.AlbumID, title: g['Album Title'], artist: g['Album Artist'], fills: albumFills })

  // Same sequence-number guard as planCacheFill: only a plausible track order is offered.
  const seqs = cacheRows.map((r) => Number(r.seq))
  const seqOk = seqs.every((n) => Number.isInteger(n) && n >= 1 && n <= cacheRows.length * 2) && new Set(seqs).size === seqs.length
  const rowFills = (r) => { const f = songFillsFrom(r); if (!seqOk) { delete f['Sequence Number']; delete f['Track Number'] } return f }
  const byTitle = new Map()
  for (const r of cacheRows) { const k = tn(r.track_name); if (k && !byTitle.has(k)) byTitle.set(k, r) }
  const used = new Set()
  for (const s of mamSongs) {
    const sg = s.fieldData
    const exact = byTitle.get(tn(sg['Track Name']))
    if (exact) {
      used.add(tn(exact.track_name)); songsMatched++
      const fills = gapsOnly(rowFills(exact), sg)
      if (Object.keys(fills).length) songGaps.push({ cat, album: g['Album Title'], recordId: s.recordId, seq: sg['Sequence Number'], title: sg['Track Name'], fills })
      continue
    }
    let best = null, bestScore = 0
    for (const r of cacheRows) {
      if (used.has(tn(r.track_name))) continue
      const sc = similarity(sg['Track Name'], r.track_name)
      if (sc > bestScore) { bestScore = sc; best = r }
    }
    if (best && bestScore >= 0.6) {
      const fills = gapsOnly(rowFills(best), sg)
      if (Object.keys(fills).length) nearMisses.push({ cat, album: g['Album Title'], recordId: s.recordId, seq: sg['Sequence Number'], title: sg['Track Name'], cacheTitle: best.track_name, score: Math.round(bestScore * 100) / 100, fills })
    }
  }
}
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), mamAlbums: albums.length, mamSongs: songs.length, cacheRows: mc.getStatus().count,
  albumsChecked, songsMatched, albumsWithoutCache: noCache.length, albumGaps, songGaps, nearMisses }, null, 0))
console.log(`albums checked ${albumsChecked.toLocaleString()} · without cache rows ${noCache.length.toLocaleString()} · album gaps ${albumGaps.length.toLocaleString()} · songs matched ${songsMatched.toLocaleString()} · song gaps ${songGaps.length.toLocaleString()} · near misses ${nearMisses.length.toLocaleString()} → ${OUT}`)
process.exit(0)
