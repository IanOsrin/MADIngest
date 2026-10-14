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
import { Transform } from 'node:stream'
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

// ── Speed limit (Ian, 2026-10-14: "do it in a way that it does not use all my bandwidth") ──────────────────────
// The first run went at ~16 MB/s and jammed the office internet. Uploads now pass through one shared limiter:
// office hours (Mon–Fri 07:00–19:00) use `day`, every other hour `night`, in MB/s. tmp/gm01-speed.json holds the
// numbers and is re-read every 30 s, so they can be changed while the copy runs, e.g. {"day": 2, "night": 12}.
const SPEED = 'tmp/gm01-speed.json'
if (!fs.existsSync(SPEED)) fs.writeFileSync(SPEED, JSON.stringify({ day: 3, night: 12, dayFrom: 7, dayTo: 19 }, null, 1) + '\n')
let speed, speedAt = 0
function rateNow() {
  if (Date.now() - speedAt > 30000) {
    try { speed = { day: 3, night: 12, dayFrom: 7, dayTo: 19, ...JSON.parse(fs.readFileSync(SPEED, 'utf8')) } } catch { speed ||= { day: 3, night: 12, dayFrom: 7, dayTo: 19 } }
    speedAt = Date.now()
  }
  const d = new Date(), wd = d.getDay() >= 1 && d.getDay() <= 5, h = d.getHours()
  const office = wd && h >= speed.dayFrom && h < speed.dayTo
  return { mbps: Math.max(0.2, Number(office ? speed.day : speed.night) || 1), office }
}
let bucket = 0, last = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function take(n) {                              // token bucket, at most 1 s of burst
  for (;;) {
    const rate = rateNow().mbps * 1e6, now = Date.now()
    bucket = Math.min(rate, bucket + ((now - last) / 1000) * rate); last = now
    if (bucket >= n) { bucket -= n; return }
    await sleep(Math.min(1000, Math.ceil(((n - bucket) / rate) * 1000)))
  }
}
const throttled = (src) => src.pipe(new Transform({ transform(chunk, _e, cb) { take(chunk.length).then(() => cb(null, chunk), cb) } }))

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
say(`START ${todo.length} files (${(total / 1e9).toFixed(1)} GB) to copy · ${done.size} already handled · speed limit ${JSON.stringify(rateNow())} (${SPEED})`)
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
    await visionUploadFile(j.dest, local, 'audio/wav', null, { wrap: throttled, queueSize: 1 })
    const back = await visionStat(j.dest)
    if (back && back.size === j.size) { copied++; log(j, 'copied') } else { failed++; log(j, 'failed', { error: `size after upload ${back?.size ?? 'none'}` }) }
  } catch (e) { failed++; log(j, 'failed', { error: String(e.message || e).slice(0, 200) }) }
  finally {
    n++; bytes += j.size
    if (n % 25 === 0 || n === todo.length) {
      const mbps = bytes / 1e6 / ((Date.now() - t0) / 1000)
      const r = rateNow()
      say(`PROGRESS ${n}/${todo.length} · ${(bytes / 1e9).toFixed(1)}/${(total / 1e9).toFixed(1)} GB · ${mbps.toFixed(1)} MB/s average · limit now ${r.mbps} MB/s (${r.office ? 'office hours' : 'after hours'}) · copied ${copied}, already there ${skipped}, conflicts ${conflicts}, failed ${failed}`)
    }
  }
}
let i = 0
await Promise.all(Array.from({ length: 2 }, async () => { while (i < todo.length) await one(todo[i++]) }))
say(`DONE copied ${copied}, already there ${skipped}, conflicts ${conflicts}, failed ${failed}`)
process.exit(0)
