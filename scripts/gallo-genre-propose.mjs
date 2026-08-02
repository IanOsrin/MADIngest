#!/usr/bin/env node
/**
 * scripts/gallo-genre-propose.mjs
 * Propose a `Local Genre` for records that have none, by looking at what the
 * SAME ALBUM and the SAME ARTIST are already labelled.
 *
 * READ-ONLY. This script never writes. It produces a proposals file for review;
 * applying is a separate, deliberate step.
 *
 * Why bother before reaching for audio ML: genre correlates almost perfectly
 * with artist and album. If eleven tracks on an album are Mbaqanga, the twelfth
 * is too. Deterministic inference should clear most of the backlog, leaving
 * only genuinely ambiguous tracks — a far smaller and more honest test of
 * whether audio classification earns its keep.
 *
 * Confidence tiers (highest first):
 *   album-unanimous   every labelled track on the album agrees
 *   album-majority    most labelled tracks on the album agree
 *   artist-unanimous  every labelled track by the artist agrees
 *   artist-majority   most labelled tracks by the artist agree
 * Anything below a majority is left for a human.
 */

import 'dotenv/config'
import fs from 'node:fs'
import { isCanonicalGenre } from '../lib/genre-taxonomy.js'

const LAYOUT = process.env.GALLO_FM_LAYOUT || 'API_Album_Songs'
const FIELD  = 'Local Genre'
const PAGE   = 500
const OUT    = process.env.GENRE_PROPOSAL_OUT || '/Users/ianosrin/Downloads/gallo-genre-proposals.json'

const { GALLO_FM_HOST, GALLO_FM_DB, GALLO_FM_USER, GALLO_FM_PASS } = process.env
const base = `${GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(GALLO_FM_DB)}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function login() {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${GALLO_FM_USER}:${GALLO_FM_PASS}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`login failed: ${j?.messages?.[0]?.message || res.status}`)
  return j.response.token
}

const norm = (s) => String(s ?? '').trim()
const key  = (s) => norm(s).toLowerCase()

/** Winner + share of a value tally, ignoring anything not in the taxonomy. */
function consensus(counts) {
  const entries = [...counts.entries()].filter(([g]) => isCanonicalGenre(g))
  if (!entries.length) return null
  entries.sort((a, b) => b[1] - a[1])
  const total = entries.reduce((s, [, n]) => s + n, 0)
  const [genre, n] = entries[0]
  return { genre, share: n / total, labelled: total, unanimous: entries.length === 1 }
}

async function main() {
  const token = await login()
  const records = []
  let offset = 1, total = null

  while (true) {
    const res = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=${PAGE}&_offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`page ${offset}: ${j?.messages?.[0]?.message || res.status}`)
    if (total === null) { total = Number(j?.response?.dataInfo?.totalRecordCount || 0); console.log(`reading ${total} records…`) }
    const data = j?.response?.data || []
    if (!data.length) break
    for (const r of data) {
      const f = r.fieldData || {}
      records.push({
        recordId: r.recordId,
        genre:    norm(f[FIELD]),
        artist:   norm(f['Album Artist']) || norm(f['Track Artist']),
        album:    norm(f['Album Title']),
        cat:      norm(f['Album Catalogue Number']),
        title:    norm(f['Track Name']),
      })
    }
    offset += data.length
    if (records.length % 10000 < PAGE) console.log(`  …${records.length}/${total}`)
    if (total && records.length >= total) break
    await sleep(40)
  }

  // Tally what each album and each artist is already labelled as.
  const byAlbum = new Map(), byArtist = new Map()
  const bump = (map, k, g) => {
    if (!k || !g) return
    if (!map.has(k)) map.set(k, new Map())
    const m = map.get(k)
    m.set(g, (m.get(g) || 0) + 1)
  }
  for (const r of records) {
    if (!r.genre) continue
    bump(byAlbum,  r.cat ? `cat:${key(r.cat)}` : `alb:${key(r.album)}|${key(r.artist)}`, r.genre)
    bump(byArtist, key(r.artist), r.genre)
  }

  const proposals = []
  const tiers = { 'album-unanimous': 0, 'album-majority': 0, 'artist-unanimous': 0, 'artist-majority': 0 }
  let unresolved = 0, noAlbumLabel = 0, noArtistLabel = 0
  const unresolvedAlbums = new Map(), unresolvedArtists = new Map()

  for (const r of records) {
    if (r.genre) continue
    const albumKey = r.cat ? `cat:${key(r.cat)}` : `alb:${key(r.album)}|${key(r.artist)}`
    const alb = byAlbum.get(albumKey)  ? consensus(byAlbum.get(albumKey))  : null
    const art = byArtist.get(key(r.artist)) ? consensus(byArtist.get(key(r.artist))) : null

    let pick = null
    if (alb && alb.unanimous)                     pick = { ...alb, tier: 'album-unanimous' }
    else if (alb && alb.share >= 0.6)             pick = { ...alb, tier: 'album-majority' }
    else if (art && art.unanimous && art.labelled >= 3) pick = { ...art, tier: 'artist-unanimous' }
    else if (art && art.share >= 0.6 && art.labelled >= 5) pick = { ...art, tier: 'artist-majority' }

    if (!pick) {
      unresolved++
      // Why couldn't we infer? Almost always: nothing on this album or by this
      // artist carries a genre either. That reframes the job from 'N tracks to
      // classify' to 'N albums to decide', which is a far smaller human task.
      const albKey = r.cat ? `cat:${key(r.cat)}` : `alb:${key(r.album)}|${key(r.artist)}`
      unresolvedAlbums.set(albKey, (unresolvedAlbums.get(albKey) || 0) + 1)
      unresolvedArtists.set(key(r.artist) || '(no artist)', (unresolvedArtists.get(key(r.artist) || '(no artist)') || 0) + 1)
      if (!byAlbum.has(albKey)) noAlbumLabel++
      if (!byArtist.has(key(r.artist))) noArtistLabel++
      continue
    }
    tiers[pick.tier]++
    proposals.push({
      recordId: r.recordId, title: r.title, artist: r.artist, album: r.album, cat: r.cat,
      propose: pick.genre, tier: pick.tier, share: Number(pick.share.toFixed(2)), basedOn: pick.labelled
    })
  }

  fs.writeFileSync(OUT, JSON.stringify(proposals, null, 2))

  const blanks = records.filter(r => !r.genre).length
  console.log(`\n${'-'.repeat(60)}`)
  console.log(`records            : ${records.length}`)
  console.log(`already labelled   : ${records.length - blanks}`)
  console.log(`blank              : ${blanks}`)
  console.log(`\nproposed           : ${proposals.length}  (${(100 * proposals.length / blanks).toFixed(1)}% of blanks)`)
  for (const [t, n] of Object.entries(tiers)) console.log(`   ${t.padEnd(18)} ${n}`)
  console.log(`still needs a human: ${unresolved}`)
  console.log(`\nproposals written to ${OUT}`)

  console.log(`\nWHY THE REST COULDN'T BE INFERRED:`)
  console.log(`  distinct albums involved   : ${unresolvedAlbums.size}`)
  console.log(`  distinct artists involved  : ${unresolvedArtists.size}`)
  console.log(`  album has NO labelled track: ${noAlbumLabel}`)
  console.log(`  artist has NO labelled track: ${noArtistLabel}`)
  const topA = [...unresolvedAlbums.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)
  console.log('  biggest unlabelled albums:')
  topA.forEach(([k,n])=>console.log(`     ${String(n).padStart(4)}  ${k.slice(0,60)}`))
  fs.writeFileSync(OUT.replace('.json','-unresolved-albums.json'), JSON.stringify([...unresolvedAlbums.entries()].sort((a,b)=>b[1]-a[1]),null,2))

  const dist = new Map()
  for (const p of proposals) dist.set(p.propose, (dist.get(p.propose) || 0) + 1)
  console.log('\ntop proposed genres:')
  ;[...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([g, n]) => console.log(`  ${String(n).padStart(5)}  ${g}`))
}

main().catch(e => { console.error('FATAL:', e.message); process.exitCode = 1 })
