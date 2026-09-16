#!/usr/bin/env node
/**
 * scripts/gallo-container-to-vision.mjs — recover WAVs that exist only inside
 * Gallo Catalogue's FileMaker container storage, put them on Vision, and link
 * MAM to them.
 *
 * Background (2026-09-15): 2,636 MAM songs had a web address in
 * Audio_Vision_URL. 1,454 were relinked to WAVs already on Vision. The rest
 * have no Vision copy at all — Gallo's Audio File container is a FileMaker
 * streaming copy (digitalcupboard.app/Streaming_SSL/…), so the only master is
 * inside FileMaker. Same approach as the August CMS 2024 recovery.
 *
 * Per song:
 *   1. Gallo record for the song's catalogue, matched on wav_filename = MAM Filename
 *   2. download the container through the Data API session
 *   3. verify: RIFF/WAVE header, and MD5 = Gallo's audio_hash_md5 when Gallo has one
 *   4. upload to /gallo-music-files-wavs/Gallo Recovered WAVs/<L>/<Artist>/<CAT> — <Album>/<Title>.wav
 *      ADD-ONLY (Vision has no trash); a clash with a different file gets " (2)"
 *   5. confirm the uploaded size, then set MAM Songs.Audio_Vision_URL — only if
 *      the link is still what the worklist recorded
 *
 * Journal: one JSON line per song; a re-run skips songs already done.
 *
 * Usage:
 *   node --env-file=.env scripts/gallo-container-to-vision.mjs <worklist.json> [--apply] [--limit N] [--catalogue "TGE 84"]
 * Worklist rows: { "MAM record", Catalogue, Title, Filename, "Current Audio_Vision_URL" }
 * Without --apply it downloads nothing and writes nothing: it lists the plan.
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { findGalloRecordsByCatalogue, fetchContainerData } from '../lib/fm-gallo.js'
import { visionStat, visionUploadFile } from '../lib/vision-drive.js'
import { mamSession } from '../lib/fm-mam-write.js'
import { getMamAlbumRaw } from '../lib/fm-mam.js'

const args = process.argv.slice(2)
const worklistFile = args.find(a => !a.startsWith('--') && a.endsWith('.json'))
const APPLY = args.includes('--apply')
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity
const ONLY_CAT = args.includes('--catalogue') ? args[args.indexOf('--catalogue') + 1] : null
// A Gallo checksum that disagrees is not always a wrong file — Gallo's hash can
// be of an earlier export. With this flag a mismatch is accepted when the WAV's
// length matches MAM's Duration to within 2 s; without it, every mismatch stops.
const ACCEPT_DURATION = args.includes('--accept-duration-match')
if (!worklistFile) { console.error('worklist.json required'); process.exit(1) }

const ROOT = process.env.GALLO_RECOVER_ROOT || '/gallo-music-files-wavs/Gallo Recovered WAVs'
const JOURNAL = process.env.GALLO_RECOVER_LOG ||
  path.join(os.homedir(), 'Downloads', 'Gallo_container_to_Vision_log.jsonl')

const clean = s => String(s || '').normalize('NFC').replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
// Seconds of audio from a WAV's own header (fmt byte rate, data chunk size).
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
const hmsSeconds = v => {
  const m = String(v || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/)
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}
const letterOf = s => { const c = clean(s).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#' }

const done = new Set()
if (existsSync(JOURNAL)) {
  for (const line of readFileSync(JOURNAL, 'utf8').split('\n')) {
    try { const j = JSON.parse(line); if (j.status === 'linked') done.add(String(j.mamRecordId)) } catch {}
  }
}
const log = row => appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')

let work = JSON.parse(readFileSync(worklistFile, 'utf8'))
  .filter(r => !done.has(String(r['MAM record'])))
  .filter(r => !ONLY_CAT || r.Catalogue === ONLY_CAT)
work = work.slice(0, LIMIT)
console.log(`${work.length} song(s) to do${done.size ? ` (${done.size} already linked, skipped)` : ''}${APPLY ? '' : ' — DRY RUN'}`)

const byCat = {}
for (const r of work) (byCat[r.Catalogue] ??= []).push(r)

const counts = {}
const bump = k => { counts[k] = (counts[k] || 0) + 1 }
const db = APPLY ? await mamSession() : null
const t0 = Date.now()
let n = 0

for (const [cat, songs] of Object.entries(byCat)) {
  const mam = await getMamAlbumRaw(cat)
  const af = mam?.album?.fieldData || {}
  const artist = clean(af['Album Artist'] || songs[0].Artist || 'Unknown Artist')
  const album = clean(af['Album Title'] || '')
  const folder = `${ROOT}/${letterOf(artist)}/${artist}/${clean(cat)}${album ? ` — ${album}` : ''}`
  const gallo = await findGalloRecordsByCatalogue(cat).catch(() => [])
  const byFile = new Map((gallo || []).map(g => [String(g.wav_filename || '').toLowerCase(), g]))
  const usedNames = new Set()

  for (const s of songs) {
    n++
    const base = { mamRecordId: String(s['MAM record']), catalogue: cat, title: s.Title, filename: s.Filename }
    const g = byFile.get(String(s.Filename || '').toLowerCase())
    const url = String(g?.audio_container_url || '')
    if (!g) { bump('no Gallo record'); log({ ...base, status: 'skipped', why: 'no Gallo record with this Filename' }); continue }
    if (!/^https?:\/\//i.test(url)) { bump('container is not a streaming copy'); log({ ...base, status: 'skipped', why: 'Gallo container is not a streaming copy', container: url.slice(0, 200) }); continue }

    let name = clean(s.Title) || clean(s.Filename)
    while (usedNames.has(name.toLowerCase())) name = name.replace(/(?: \((\d+)\))?$/, (m, k) => ` (${(Number(k) || 1) + 1})`)
    usedNames.add(name.toLowerCase())
    let dest = `${folder}/${name}.wav`

    if (!APPLY) { bump('planned'); if (counts.planned <= 5) console.log(`  ${cat} "${s.Title}" → ${dest}`); continue }

    let tmp = null
    try {
      const buf = await fetchContainerData(url)
      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        bump('not a WAV'); log({ ...base, status: 'failed', why: `downloaded ${buf.length} bytes, not a WAV` }); continue
      }
      const md5 = crypto.createHash('md5').update(buf).digest('hex').toUpperCase()
      // Gallo stores "?" and other placeholders where it has no checksum — only a
      // real 32-hex MD5 counts as one (21 songs were wrongly refused on "?").
      const rawWant = String(g.audio_hash_md5 || '').trim().toUpperCase()
      const want = /^[0-9A-F]{32}$/.test(rawWant) ? rawWant : ''
      let durationMatched = false
      if (want && want !== md5) {
        const secs = wavSeconds(buf)
        const mamSong = (await (db || await mamSession()).find('Songs', [{ 'Album Catalogue': '==' + cat }], 500))
          .find(x => String(x.recordId) === base.mamRecordId)?.fieldData
        const mamSecs = hmsSeconds(mamSong?.Duration)
        const close = secs != null && mamSecs != null && Math.abs(secs - mamSecs) <= 2
        if (!(ACCEPT_DURATION && close)) {
          bump(close ? 'checksum mismatch, duration matches' : 'checksum mismatch, duration differs')
          log({ ...base, status: 'failed', why: `MD5 ${md5} ≠ Gallo ${want}`, bytes: buf.length,
                wavSeconds: secs && Math.round(secs), mamDuration: mamSong?.Duration || null, durationMatches: close })
          continue
        }
        durationMatched = true
      }

      // Add-only. Same size already there = a previous run's upload; anything else = pick a free name.
      const existing = await visionStat(dest)
      if (existing && existing.size !== buf.length) {
        let k = 2
        while (await visionStat(`${folder}/${name} (${k}).wav`)) k++
        dest = `${folder}/${name} (${k}).wav`
      }
      if (!existing || existing.size !== buf.length) {
        tmp = path.join(os.tmpdir(), `gallo-recover-${process.pid}-${Date.now()}.wav`)
        writeFileSync(tmp, buf)
        await visionUploadFile(dest, tmp, 'audio/wav')
        const st = await visionStat(dest)
        if (!st || st.size !== buf.length) { bump('upload size mismatch'); log({ ...base, status: 'failed', why: `uploaded size ${st?.size} ≠ ${buf.length}`, dest }); continue }
      }

      // Link MAM only if nobody changed the link meanwhile.
      const cur = (await db.find('Songs', [{ 'Album Catalogue': '==' + cat }], 500))
        .find(x => String(x.recordId) === base.mamRecordId)?.fieldData
      if (!cur) { bump('uploaded, MAM song gone'); log({ ...base, status: 'uploaded', why: 'MAM song not found', dest, md5 }); continue }
      if (String(cur.Audio_Vision_URL || '').trim() !== String(s['Current Audio_Vision_URL'] || '').trim()) {
        bump('uploaded, MAM link changed'); log({ ...base, status: 'uploaded', why: `MAM link changed to ${cur.Audio_Vision_URL}`, dest, md5 }); continue
      }
      await db.patch('Songs', base.mamRecordId, { Audio_Vision_URL: dest, Audio_Truth: 'Vision' })
      bump('linked')
      log({ ...base, status: 'linked', before: s['Current Audio_Vision_URL'], dest, bytes: buf.length, md5, hashChecked: !!want && !durationMatched, durationMatched })
    } catch (e) {
      bump('error'); log({ ...base, status: 'failed', why: e.message })
    } finally {
      if (tmp) await unlink(tmp).catch(() => {})
    }
    if (n % 10 === 0) {
      const rate = (Date.now() - t0) / n / 1000
      console.log(`${n}/${work.length} · ${JSON.stringify(counts)} · ${rate.toFixed(1)} s/song · ~${Math.round((work.length - n) * rate / 60)} min left`)
    }
  }
}
console.log('DONE', JSON.stringify(counts), `in ${Math.round((Date.now() - t0) / 1000)} s · journal ${JOURNAL}`)
await db?.logout?.()
process.exit(0)
