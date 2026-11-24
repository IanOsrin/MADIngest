#!/usr/bin/env node
/**
 * scripts/cms-container-to-vision.mjs — recover WAVs that exist only inside
 * CMS 2024's FileMaker container storage, put them on Vision, and link MAM.
 *
 * The sibling of scripts/gallo-container-to-vision.mjs, which does the same
 * for Gallo Catalogue. That one is now exhausted: of the 27,821 MAM songs
 * with no Vision audio (2026-11-24) only 24 have a Gallo record at all —
 * 27,746 are CMS-only. BL 87 "Papadi Oyakae" is the case in point: Gallo's
 * Audio_URL is empty, MadStreamer has no S3 file, Vision holds nothing for
 * the catalogue, and the only master is in the CMS container.
 *
 * Unlike the August recovery (scripts/cms-vision-recover.mjs) this does NOT
 * need the AudioStorage share mounted — it pulls each container through the
 * CMS Data API, one named record at a time. That is a targeted fetch of
 * records we already know, not a scan of the Song Files layout.
 *
 * Per song:
 *   1. CMS record matched on Filename (the MAM song's own Filename)
 *   2. download the container through a live CMS session
 *   3. verify it is a real RIFF/WAVE, and that its length agrees with MAM's
 *      Duration when MAM has one
 *   4. upload to /gallo-music-files-wavs/CMS Recovered WAVs/<L>/<Artist>/<CAT> — <Album>/<Title>.wav
 *      ADD-ONLY (Vision has no trash); a clash with a different file gets " (2)"
 *   5. confirm the uploaded size, then fill MAM Songs.Audio_Vision_URL —
 *      only when it is still empty
 *
 * Journal: one JSON line per song; a re-run skips songs already linked.
 *
 * Usage:
 *   node --env-file=.env scripts/cms-container-to-vision.mjs --catalogue "bl 87"
 *   node --env-file=.env scripts/cms-container-to-vision.mjs --catalogue "bl 87" --apply
 *   node --env-file=.env scripts/cms-container-to-vision.mjs --worklist tmp/x.json --apply --limit 50
 * Without --apply it downloads nothing and writes nothing: it lists the plan.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findRecord as findCmsRecord, pingCms2024, mapCms2024Record } from '../lib/fm-cms2024.js'
import { visionStat, visionUploadFile } from '../lib/vision-drive.js'
import { mamSession } from '../lib/fm-mam-write.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const CAT = args.includes('--catalogue') ? args[args.indexOf('--catalogue') + 1] : null
const WORKLIST = args.includes('--worklist') ? args[args.indexOf('--worklist') + 1] : null
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity
if (!CAT && !WORKLIST) { console.error('--catalogue "BL 87" or --worklist file.json required'); process.exit(1) }

const ROOT = process.env.CMS_RECOVER_ROOT || '/gallo-music-files-wavs/CMS Recovered WAVs'
const JOURNAL = process.env.CMS_RECOVER_LOG ||
  path.join(os.homedir(), 'Downloads', 'CMS_container_to_Vision_log.jsonl')

const clean = s => String(s || '').normalize('NFC').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
const letterOf = s => { const c = clean(s).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#' }
const hmsSeconds = v => {
  const m = String(v || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/)
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}
function wavSeconds(buf) {
  let off = 12, byteRate = 0, dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16)
    if (id === 'data') { dataSize = Math.min(size, buf.length - off - 8); break }
    off += 8 + size + (size % 2)
  }
  return byteRate && dataSize ? dataSize / byteRate : null
}

/**
 * A FileMaker container URL only answers while the session that produced it is
 * alive, and it redirects through a cookie handshake. pingCms2024() guarantees
 * a live CMS session first; the cookie jar is carried across the redirects.
 */
async function fetchCmsContainer(url) {
  await pingCms2024()
  let current = url, cookies = ''
  for (let i = 0; i <= 5; i++) {
    const res = await fetch(current, { redirect: 'manual', headers: cookies ? { Cookie: cookies } : {} })
    const sc = res.headers.get('set-cookie')
    if (sc) {
      const fresh = sc.split(/,(?=[^ ]+=)/).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')
      cookies = cookies ? `${cookies}; ${fresh}` : fresh
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) throw new Error(`redirect with no Location (HTTP ${res.status})`)
      current = new URL(next, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('too many redirects')
}

const done = new Set()
if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n')) {
    try { const j = JSON.parse(line); if (j.status === 'linked') done.add(String(j.mamRecordId)) } catch {}
  }
}
const log = row => appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')

const db = await mamSession()

// Worklist: either every MAM song of one catalogue, or a supplied file.
let songs
if (WORKLIST) {
  songs = JSON.parse(readFileSync(WORKLIST, 'utf8'))
} else {
  const rows = await db.find('Songs', [{ 'Album Catalogue': '==' + CAT }], 500)
  songs = rows.map(r => ({
    'MAM record': r.recordId, Catalogue: r.fieldData['Album Catalogue'], Title: r.fieldData['Track Name'],
    Artist: r.fieldData['Track Artist'], Filename: r.fieldData['Filename'],
    Duration: r.fieldData['Duration'], 'Current Audio_Vision_URL': r.fieldData['Audio_Vision_URL'] || '',
  }))
}
songs = songs
  .filter(s => !done.has(String(s['MAM record'])))
  .filter(s => !String(s['Current Audio_Vision_URL'] || '').trim())   // fill empty links only
  .slice(0, LIMIT)
console.log(`${songs.length} song(s) to do${done.size ? ` (${done.size} already linked, skipped)` : ''}${APPLY ? '' : ' — DRY RUN'}`)

// One folder per catalogue, named from MAM's own album row.
const byCat = {}
for (const s of songs) (byCat[s.Catalogue] ??= []).push(s)

const counts = {}
const bump = k => { counts[k] = (counts[k] || 0) + 1 }
const t0 = Date.now()

for (const [cat, list] of Object.entries(byCat)) {
  const alb = (await db.find('Albums', [{ 'Album Catalogue Number': '==' + cat }, { 'Reference Catalogue Number': '==' + cat }], 2))[0]
  const af = alb?.fieldData || {}
  const artist = clean(af['Album Artist'] || list[0].Artist || 'Unknown Artist')
  const album = clean(af['Album Title'] || '')
  const folder = `${ROOT}/${letterOf(artist)}/${artist}/${clean(cat)}${album ? ` — ${album}` : ''}`
  const used = new Set()

  for (const s of list) {
    const base = { mamRecordId: String(s['MAM record']), catalogue: cat, title: s.Title, filename: s.Filename }
    try {
      const rec = s.Filename ? await findCmsRecord({ Filename: '==' + s.Filename }).catch(() => null) : null
      if (!rec) { bump('no CMS record'); log({ ...base, status: 'skipped', why: 'no CMS record with this Filename' }); continue }
      const url = String(mapCms2024Record(rec)?.audio_container_url || '')
      if (!/^https?:\/\//i.test(url)) { bump('no container'); log({ ...base, status: 'skipped', why: 'CMS container is empty or not a streaming copy', container: url.slice(0, 120) }); continue }

      let name = clean(s.Title) || clean(s.Filename)
      while (used.has(name.toLowerCase())) name = name.replace(/(?: \((\d+)\))?$/, (m, k) => ` (${(Number(k) || 1) + 1})`)
      used.add(name.toLowerCase())
      let dest = `${folder}/${name}.wav`

      if (!APPLY) { bump('planned'); console.log(`  ${cat} "${s.Title}" → ${dest}`); continue }

      const buf = await fetchCmsContainer(url)
      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        bump('not a WAV'); log({ ...base, status: 'failed', why: `downloaded ${buf.length} bytes, not a WAV` }); continue
      }
      // CMS has no checksum to compare, so the length is the sanity check.
      const secs = wavSeconds(buf), want = hmsSeconds(s.Duration)
      if (want && secs != null && Math.abs(secs - want) > 3) {
        bump('duration differs')
        log({ ...base, status: 'failed', why: `WAV ${Math.round(secs)}s vs MAM ${s.Duration}`, bytes: buf.length })
        continue
      }

      const existing = await visionStat(dest)
      if (existing && existing.size !== buf.length) {
        let k = 2
        while (await visionStat(`${folder}/${name} (${k}).wav`)) k++
        dest = `${folder}/${name} (${k}).wav`
      }
      if (!existing || existing.size !== buf.length) {
        const tmp = path.join(os.tmpdir(), `cms-recover-${process.pid}-${Date.now()}.wav`)
        writeFileSync(tmp, buf)
        try {
          await visionUploadFile(dest, tmp, 'audio/wav')
          const st = await visionStat(dest)
          if (!st || st.size !== buf.length) { bump('upload size mismatch'); log({ ...base, status: 'failed', why: `uploaded ${st?.size} ≠ ${buf.length}`, dest }); continue }
        } finally { try { unlinkSync(tmp) } catch {} }
      }

      const ok = await db.patch('Songs', String(s['MAM record']), { 'Audio_Vision_URL': dest, 'Audio_Truth': 'Vision' })
      if (!ok) { bump('link failed'); log({ ...base, status: 'failed', why: 'uploaded but MAM link failed', dest }); continue }
      bump('linked')
      log({ ...base, status: 'linked', dest, bytes: buf.length, seconds: secs && Math.round(secs) })
      console.log(`  ✓ "${s.Title}" → ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`)
    } catch (e) {
      bump('error'); log({ ...base, status: 'failed', why: e.message })
      console.warn(`  ✗ "${s.Title}": ${e.message}`)
    }
  }
}
console.log(`DONE ${JSON.stringify(counts)} in ${Math.round((Date.now() - t0) / 1000)} s · journal ${JOURNAL}`)
