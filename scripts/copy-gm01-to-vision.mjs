/**
 * scripts/copy-gm01-to-vision.mjs — copy the DC Cap Renders audio that Vision lacks from the Gallo Master 01
 * drive to Vision (Ian, 2026-10-13: "Do not copy if a 44.1 file exists"; standard batches first; the other
 * folders keep their own folders).
 *
 * The list is tmp/dc-cap-copy-final.json (5,043 files): not on Vision in any form — no same name+size, no
 * same album folder+song, and no 44.1 kHz render of the same artist's song anywhere on Vision.
 *
 * Where each file goes:
 *   standard  DC Cap Renders/Batch …/<Artist>/<Artist>_<Album>_<CAT>/<Track>.wav
 *             → /gallo-digital-cupboard/Rendered Files/<letter group>/<Artist>/<Artist>_<Album>_<CAT>/<Track>.wav
 *             (the rule in lib/vision-destination.js, same as the To Vision tab)
 *   other     anything else (Database Monthly updates, DC GMVault Renders, Rob Renders …)
 *             → /gallo-digital-cupboard/Rendered Files/Gallo Master 01/<path on the drive>
 *
 * Safety: NEVER overwrites — an existing destination of the same size is skipped as done, of another size is
 * logged as a conflict and left alone. Nothing is deleted. Every upload is read back (size) before it counts.
 * Resumable: tmp/gm01-copy-log.jsonl records each file; a rerun skips what is done.
 *
 *   node scripts/copy-gm01-to-vision.mjs plan          # destinations + counts, writes nothing
 *   node scripts/copy-gm01-to-vision.mjs run [limit]   # copy (standard first, then other)
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { visionUploadFile, visionStat } from '../lib/vision-drive.js'
import { letterGroup } from '../lib/vision-destination.js'

const DRIVE = '/Volumes/Gallo Master 01'
const ROOT = '/gallo-digital-cupboard/Rendered Files'
const LOG = 'tmp/gm01-copy-log.jsonl'
const PROGRESS = 'tmp/gm01-copy-progress.log'
const list = JSON.parse(fs.readFileSync('tmp/dc-cap-copy-final.json', 'utf8')).copy

function plan([rel, size]) {
  const p = rel.split('/')
  const [artist, album] = [p[p.length - 3], p[p.length - 2]]
  const standard = p[0] === 'DC Cap Renders' && /^Batch/i.test(p[1]) && p.length >= 5
    && album.includes('_') && album.toLowerCase().startsWith(artist.toLowerCase().slice(0, 4))   // Artist_Album_CAT or Artist_CAT
  const dest = standard ? `${ROOT}/${letterGroup(artist)}/${artist}/${album}/${p[p.length - 1]}` : `${ROOT}/Gallo Master 01/${rel}`
  return { rel, size, standard, dest }
}
const jobs = list.map(plan).sort((a, b) => (b.standard - a.standard) || a.rel.localeCompare(b.rel))
const say = (m) => { const l = `${new Date().toISOString().slice(0, 19)} ${m}`; console.log(l); fs.appendFileSync(PROGRESS, l + '\n') }

const cmd = process.argv[2]
if (cmd === 'plan') {
  const std = jobs.filter((j) => j.standard), oth = jobs.filter((j) => !j.standard)
  const gb = (x) => (x.reduce((n, j) => n + j.size, 0) / 1e9).toFixed(1)
  console.log(`standard: ${std.length} files ${gb(std)} GB · other: ${oth.length} files ${gb(oth)} GB`)
  for (const j of [...std.slice(0, 3), ...oth.slice(0, 3)]) console.log(`  ${j.standard ? 'STD' : 'OTH'} ${j.rel}\n      → ${j.dest}`)
  process.exit(0)
}
if (cmd !== 'run' && cmd !== 'remaining') { console.log('plan | run [limit] | remaining [out.csv]'); process.exit(0) }

const done = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.result !== 'failed').map((r) => r.rel) : [])
if (cmd === 'remaining') {             // what is still to copy, for copying another way (Ian, 2026-10-13: the run jammed the office line)
  const out = process.argv[3] || 'tmp/gm01-remaining.csv', q = (s) => `"${String(s).replace(/"/g, '""')}"`
  const left = jobs.filter((j) => !done.has(j.rel))
  fs.writeFileSync(out, ['Kind,Size (bytes),On Gallo Master 01,Copy to on Vision', ...left.map((j) => [j.standard ? 'standard' : 'other', j.size, q(path.join(DRIVE, j.rel)), q(j.dest)].join(','))].join('\n') + '\n')
  console.log(`${left.length} files (${(left.reduce((n, j) => n + j.size, 0) / 1e9).toFixed(1)} GB) → ${out}`)
  process.exit(0)
}
const todo = jobs.filter((j) => !done.has(j.rel)).slice(0, Number(process.argv[3]) || Infinity)
const total = todo.reduce((n, j) => n + j.size, 0)
say(`START ${todo.length} files (${(total / 1e9).toFixed(1)} GB) to copy · ${done.size} already handled`)
let n = 0, bytes = 0, copied = 0, skipped = 0, conflicts = 0, failed = 0
const t0 = Date.now()
const log = (j, result, extra = {}) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), rel: j.rel, dest: j.dest, size: j.size, result, ...extra }) + '\n')
async function one(j) {
  try {
    const local = path.join(DRIVE, j.rel)
    if (!fs.existsSync(local)) { failed++; log(j, 'failed', { error: 'not on the drive' }); return }
    const there = await visionStat(j.dest)
    if (there) {
      if (there.size === j.size) { skipped++; log(j, 'already there') } else { conflicts++; log(j, 'conflict — left alone', { visionSize: there.size }) }
      return
    }
    await visionUploadFile(j.dest, local, 'audio/wav')
    const back = await visionStat(j.dest)
    if (back && back.size === j.size) { copied++; log(j, 'copied') } else { failed++; log(j, 'failed', { error: `size after upload ${back?.size ?? 'none'}` }) }
  } catch (e) { failed++; log(j, 'failed', { error: String(e.message || e).slice(0, 200) }) }
  finally {
    n++; bytes += j.size
    if (n % 25 === 0 || n === todo.length) {
      const mbps = bytes / 1e6 / ((Date.now() - t0) / 1000)
      say(`PROGRESS ${n}/${todo.length} · ${(bytes / 1e9).toFixed(1)}/${(total / 1e9).toFixed(1)} GB · ${mbps.toFixed(1)} MB/s · about ${((total - bytes) / 1e6 / Math.max(mbps, 0.01) / 3600).toFixed(1)} h left · copied ${copied}, already there ${skipped}, conflicts ${conflicts}, failed ${failed}`)
    }
  }
}
let i = 0
await Promise.all(Array.from({ length: 2 }, async () => { while (i < todo.length) await one(todo[i++]) }))
say(`DONE copied ${copied}, already there ${skipped}, conflicts ${conflicts}, failed ${failed}`)
process.exit(0)
