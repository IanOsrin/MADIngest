#!/usr/bin/env node
/**
 * scripts/mam-vision-find-audio.mjs — find MAM songs whose master is already
 * on Vision but filed outside the album's canonical folder, and link them.
 *
 * Why this exists: link-album (lib/link-album-audio.js) only looks in
 * Rendered Files/<letter>/<Artist>/<Album>, which is where an upload PUTS an
 * album. Most of the backlog predates that convention — it sits in
 * JazzWorks/Batch 25-32, Rendered Files/Gallo Master 01/<original drive path>,
 * CMS Recovered WAVs/… and similar. A census on 2026-11-24 found 569 songs
 * linkable the canonical way against ~16,000 with a title match elsewhere.
 *
 * Matching a title ALONE across the whole of Vision is not safe — this
 * catalogue repeats titles constantly (3,479 of a 5,000-song sample had more
 * than one candidate). So a file counts only when:
 *
 *   1. its normalised title equals the song's, AND
 *   2. its Vision path contains the album's CATALOGUE or its ARTIST, AND
 *   3. it is the only file that satisfies both.
 *
 * Anything ambiguous is reported, never guessed at — the same rule the
 * canonical linker follows.
 *
 * Usage:
 *   node scripts/mam-vision-find-audio.mjs scan             # read-only, writes a worklist
 *   node scripts/mam-vision-find-audio.mjs apply [--limit N]
 *
 * Inputs : tmp/mam-songs.json, tmp/mam-albums.json (scripts/mam-*-scan.mjs),
 *          tmp/vision-index.json
 * Outputs: tmp/mam-vision-find.json (worklist), tmp/mam-vision-find-log.jsonl
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { mamSession } from '../lib/fm-mam-write.js'
import { getMamFieldData } from '../lib/fm-mam.js'

const mode = process.argv[2] || 'scan'
const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0
// --by=catalogue is the trustworthy half: the album's catalogue number appears
// in the Vision path, so the file belongs to THIS album. --by=artist matches
// only artist + title, which can be the same song on a different release.
const byArg = process.argv.find(a => a.startsWith('--by='))
const ONLY_BY = byArg ? byArg.split('=')[1] : null

const AUDIO = /\.(wav|flac|aiff?|mp3|m4a)$/i
const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const titleFromFile = f => tn(String(f).replace(AUDIO, '').replace(/^\s*\d{1,3}[\s._-]+/, ''))
// For "does the path mention this?" — punctuation and spacing vary wildly
// between a FileMaker field and a folder name ("BL 87" vs "BL87" vs "BL_87").
const squash = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '')

const WORKLIST = 'tmp/mam-vision-find.json'
const LOG = 'tmp/mam-vision-find-log.jsonl'

function buildIndex() {
  const index = JSON.parse(readFileSync('tmp/vision-index.json', 'utf8'))
  const byTitle = new Map()
  let n = 0
  for (const [folder, d] of Object.entries(index.folders || {})) {
    for (const f of [...(d.files || []), ...(d.others || [])]) {
      const name = String(f?.name ?? f)
      if (!AUDIO.test(name)) continue
      const full = f?.path || `/${folder}/${name}`
      const t = titleFromFile(name)
      if (!t) continue
      if (!byTitle.has(t)) byTitle.set(t, [])
      byTitle.get(t).push({ path: full, squashed: squash(full) })
      n++
    }
  }
  return { byTitle, count: n }
}

function scan() {
  const songs = JSON.parse(readFileSync('tmp/mam-songs.json', 'utf8'))
  const albums = JSON.parse(readFileSync('tmp/mam-albums.json', 'utf8'))
  const { byTitle, count } = buildIndex()
  console.log(`Vision index: ${count} audio files, ${byTitle.size} distinct titles`)

  const albumById = new Map()
  for (const a of albums) albumById.set(String(a.AlbumID ?? a.albumID ?? ''), a)

  const need = songs.filter(s => !String(s['Audio_Vision_URL'] || '').trim())
  console.log(`MAM songs with no Audio_Vision_URL: ${need.length}`)

  const hits = [], ambiguous = [], none = []
  for (const s of need) {
    const t = tn(s['Track Name'])
    const cands = t ? (byTitle.get(t) || []) : []
    if (!cands.length) { none.push(s); continue }
    const a = albumById.get(String(s['AlbumID'] || '')) || {}
    const cat = squash(a['Album Catalogue Number'] || a['Reference Catalogue Number'] || s['Album Catalogue'])
    const artist = squash(a['Album Artist'])
    // An album's catalogue is a far stronger signal than its artist, so a
    // catalogue hit wins outright; artist is the fallback.
    const byCat = cat.length >= 4 ? cands.filter(c => c.squashed.includes(cat)) : []
    const pool = byCat.length ? byCat
      : (artist.length >= 4 ? cands.filter(c => c.squashed.includes(artist)) : [])
    if (pool.length === 1) {
      hits.push({ recordId: s.id, albumID: s['AlbumID'], catalogue: s['Album Catalogue'],
                  title: s['Track Name'], path: pool[0].path, by: byCat.length ? 'catalogue' : 'artist' })
    } else if (pool.length > 1) {
      ambiguous.push({ title: s['Track Name'], catalogue: s['Album Catalogue'], candidates: pool.length })
    } else {
      none.push(s)
    }
  }

  const albumsOf = rows => new Set(rows.map(r => r.albumID || r['AlbumID'])).size
  console.log('')
  console.log(`linkable (title + catalogue/artist in path, unique): ${hits.length} songs / ${albumsOf(hits)} albums`)
  console.log(`   …matched via catalogue: ${hits.filter(h => h.by === 'catalogue').length}, via artist: ${hits.filter(h => h.by === 'artist').length}`)
  console.log(`ambiguous (several files pass)                     : ${ambiguous.length}`)
  console.log(`no candidate on Vision                             : ${none.length}`)
  writeFileSync(WORKLIST, JSON.stringify({ generated: new Date().toISOString(), hits, ambiguousCount: ambiguous.length, noneCount: none.length }, null, 1))
  console.log(`\nworklist → ${WORKLIST}`)
}

async function apply() {
  if (!existsSync(WORKLIST)) { console.error(`run scan first — ${WORKLIST} is missing`); process.exit(1) }
  const { hits } = JSON.parse(readFileSync(WORKLIST, 'utf8'))
  const done = new Set()
  if (existsSync(LOG)) for (const l of readFileSync(LOG, 'utf8').split('\n')) {
    try { const e = JSON.parse(l); if (e.ok) done.add(e.recordId) } catch {}
  }
  const pool = ONLY_BY ? hits.filter(h => h.by === ONLY_BY) : hits
  const todo = pool.filter(h => !done.has(h.recordId)).slice(0, LIMIT || undefined)
  if (ONLY_BY) console.log(`filtered to --by=${ONLY_BY}: ${pool.length} of ${hits.length}`)
  console.log(`linking ${todo.length} songs (${done.size} already done)`)
  const db = await mamSession()
  let ok = 0, fail = 0, skipped = 0
  for (const [i, h] of todo.entries()) {
    try {
      // Only ever FILL AN EMPTY LINK. The worklist may be minutes or days old,
      // and another pass (or the canonical linker) may have filled this song
      // since — re-pointing audio that already plays is not this script's
      // decision to make.
      const live = await getMamFieldData('Songs', h.recordId).catch(() => null)
      if (live && String(live['Audio_Vision_URL'] || '').trim()) {
        skipped++
        appendFileSync(LOG, JSON.stringify({ recordId: h.recordId, ok: true, skipped: 'already linked', ts: new Date().toISOString() }) + '\n')
        continue
      }
      const wrote = await db.patch('Songs', h.recordId, { 'Audio_Vision_URL': h.path, 'Audio_Truth': 'Vision' })
      wrote ? ok++ : fail++
      appendFileSync(LOG, JSON.stringify({ recordId: h.recordId, path: h.path, ok: !!wrote, ts: new Date().toISOString() }) + '\n')
    } catch (e) {
      fail++
      appendFileSync(LOG, JSON.stringify({ recordId: h.recordId, error: e.message, ts: new Date().toISOString() }) + '\n')
    }
    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${todo.length} — ${ok} linked`)
  }
  console.log(`\nlinked ${ok}, skipped (already linked) ${skipped}, failed ${fail} — log ${LOG}`)
}

if (mode === 'scan') scan()
else if (mode === 'apply') await apply()
else { console.error('usage: mam-vision-find-audio.mjs scan | apply [--limit=N]'); process.exit(1) }
