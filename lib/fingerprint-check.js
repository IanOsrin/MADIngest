// lib/fingerprint-check.js — the Check Audio tab: does this audio contain a Gallo recording? (Ian, 2026-10-11)
//
// Works where the fingerprint index is: Ian's Mac with the Bandlab drive (FP_LAB, default
// /Volumes/Bandlab/fingerprint-lab). Since 2026-10-15 it checks the WHOLE catalogue (65,337 recordings)
// with the two-step check — full-sample8/ (1 in 8 fingerprint words, ~3.7 GB, in memory) names the
// candidates, each is then checked against all its fingerprints from full/clean/ (the peaks store) with
// the full index's stop words (full-index/stop.u32). Without those folders it falls back to the 10k
// test index in scale/. On Render none of it is there and the tab says so.
//
// One check = a job:
//   1. the audio — an uploaded file, a direct audio link, or a YouTube/TikTok/… page through yt-dlp
//   2. its landmark peaks — research/fingerprint/peaks_cli.py (the same code that built the index)
//   3. the whole-song scan — research/fingerprint/fp-rust `fp_match serve2` (full catalogue) or `serve`
//      (10k), a long-lived process: loading takes ~15–20 s, so it starts on the first check and stops
//      after IDLE_MS quiet. A whole song takes ~5 s against the full catalogue.
//   4. catalogue details for every Gallo file found, from the Postgres mirror
// A stretch is reported only with ≥ 20 votes inside 10 s — 0 false alarms over 20 stranger songs and
// 260 stranger clips against the 10k index. Audio is deleted when the job is cleared (JOB_TTL_MS).
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMirrorEnabled, mirrorQuery } from './mirror-db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const RESEARCH = path.join(here, '..', 'research', 'fingerprint')
const LAB = process.env.FP_LAB || '/Volumes/Bandlab/fingerprint-lab'
const INDEX = path.join(LAB, 'scale')                       // the 10k test index (fallback)
const SAMPLE = path.join(LAB, 'full-sample8')                // the full catalogue, two-step check
const STOP = path.join(LAB, 'full-index', 'stop.u32')
const STORE = path.join(LAB, 'full', 'clean')
const useFull = () => existsSync(path.join(SAMPLE, 'rows.u64')) && existsSync(STOP) && existsSync(path.join(STORE, 'peaks.idx'))
const BIN = process.env.FP_MATCH_BIN || path.join(RESEARCH, 'fp-rust', 'target', 'release', 'fp_match')
const PEAKS = path.join(RESEARCH, 'peaks_cli.py')
const TMP = path.join(os.tmpdir(), 'gallo-fpcheck')
const MEDIA = process.env.FP_MEDIA || 'https://media.musicafricadirect.com/mp3'
export const MAX_BYTES = 300 * 1024 * 1024
const MAX_SECONDS = 1200          // the matcher packs query time in 16 bits; 20 minutes are scanned
const IDLE_MS = 20 * 60 * 1000
const JOB_TTL_MS = 2 * 60 * 60 * 1000
// Pages yt-dlp fetches the audio from (anything else is treated as a direct audio link).
const PAGE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|soundcloud\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|vimeo\.com|mixcloud\.com|audiomack\.com|bandcamp\.com)$/i

export function availability() {
  if (!useFull() && !existsSync(path.join(INDEX, 'hash.u32'))) return { ok: false, reason: `Check Audio works on the office Mac: the fingerprint index (${INDEX}) isn’t here — is the Bandlab drive plugged in?` }
  if (!existsSync(BIN)) return { ok: false, reason: 'The matcher isn’t built yet: run  cargo build --release  in research/fingerprint/fp-rust.' }
  if (!existsSync(PEAKS)) return { ok: false, reason: 'research/fingerprint/peaks_cli.py is missing.' }
  return { ok: true }
}

// ── the matcher process ────────────────────────────────────────────────────────────────────────────
let proc = null, state = 'stopped', loaded = null, idleTimer = null, info = null
const pending = new Map()

function namesFile() {          // fp_match wants a plain JSON array of the index's file names
  const p = path.join(INDEX, 'names.json')
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(JSON.parse(readFileSync(path.join(INDEX, 'meta.json'), 'utf8')).names))
  return p
}

function startMatcher() {
  if (loaded) return loaded
  state = 'loading'
  loaded = new Promise((resolve, reject) => {
    const full = useFull()
    proc = spawn(BIN, full ? ['serve2', SAMPLE, STOP, STORE] : ['serve', INDEX, namesFile()], { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stderr.on('data', (d) => console.log(String(d).trim()))
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg; try { msg = JSON.parse(line) } catch { return }
      if (msg.ready) {   // tracks that never downloaded are named in the index but have no fingerprints
        let failed = 0; if (!full) try { failed = JSON.parse(readFileSync(path.join(INDEX, 'failures.json'), 'utf8')).length } catch {}
        state = 'ready'; info = { tracks: msg.tracks - failed, rows: msg.rows }; resolve(); return
      }
      const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p.resolve(msg) }
    })
    proc.on('exit', (code) => {
      console.log(`[fpcheck] matcher stopped (${code ?? 'signal'})`)
      const err = new Error('The matcher stopped unexpectedly.')
      for (const p of pending.values()) p.reject(err)
      pending.clear(); proc = null; loaded = null; state = 'stopped'
      reject(err)
    })
    proc.on('error', reject)
  })
  return loaded
}

function touch() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (proc && !pending.size) { console.log('[fpcheck] idle — stopping the matcher'); proc.kill() } }, IDLE_MS)
  idleTimer.unref?.()
}

async function match(peaksFile) {
  await startMatcher()
  touch()
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.stdin.write(`${id}\t${peaksFile}\n`)
  })
}

export function matcherState() { return { state, ...(info || {}) } }

// ── jobs ───────────────────────────────────────────────────────────────────────────────────────────
const jobs = new Map()
const run = (cmd, args, timeout) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? reject(new Error((String(stderr).trim().split('\n').pop() || err.message).slice(0, 300))) : resolve(String(stdout))))

export function newJob(source) {
  const id = randomUUID(), dir = path.join(TMP, id)
  mkdirSync(dir, { recursive: true })
  const job = { id, dir, created: Date.now(), status: 'working', stage: 'Starting…', source, audio: null, result: null, error: null }
  jobs.set(id, job)
  setTimeout(() => dropJob(id), JOB_TTL_MS).unref?.()
  return job
}
export function getJob(id) { return jobs.get(id) || null }
export function publicJob(j) {
  return { id: j.id, status: j.status, stage: j.stage, source: j.source, error: j.error, result: j.result, hasAudio: !!j.audio }
}
function dropJob(id) {
  const j = jobs.get(id); if (!j) return
  jobs.delete(id); try { rmSync(j.dir, { recursive: true, force: true }) } catch {}
}

/** Stream an upload (an http request body) into the job's folder, at most MAX_BYTES. */
export async function saveUpload(job, req, name) {
  const ext = (path.extname(String(name || '')).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.audio'])[0]
  const file = path.join(job.dir, `upload${ext}`)
  let n = 0
  const cap = new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > MAX_BYTES ? new Error('That file is over 300 MB.') : null, chunk) } })
  await pipeline(req, cap, createWriteStream(file))
  if (!n) throw new Error('The upload was empty.')
  job.audio = file
}

async function fetchLink(job, url) {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be checked.')
  if (PAGE_HOSTS.test(u.hostname)) {
    job.stage = `Fetching the audio from ${u.hostname.replace(/^www\./, '')}…`
    const args = ['--no-playlist', '--no-simulate', '-f', 'bestaudio/best', '--max-filesize', '300M',
      '--match-filter', 'duration <= 3600', '-o', path.join(job.dir, 'link.%(ext)s'), '-O', 'title', '-O', 'after_move:filepath', url]
    // YouTube refuses about 1 download in 3 with "HTTP Error 403" and lets the same one through on the
    // next try (measured 2026-10-15) — so a 403 is retried, up to 4 tries in all.
    let out
    for (let attempt = 1; ; attempt++) {
      try { out = await run('yt-dlp', args, 5 * 60 * 1000); break }
      catch (err) {
        if (attempt >= 4 || !/HTTP Error 403/.test(err.message)) throw err
        job.stage = `${u.hostname.replace(/^www\./, '')} refused the download — trying again (${attempt + 1} of 4)…`
      }
    }
    const lines = out.trim().split('\n').filter(Boolean)
    const file = lines.pop()
    if (!file || !existsSync(file)) throw new Error('No audio came back from that page (private, removed or longer than an hour?).')
    job.audio = file
    job.source.title = lines.pop() || job.source.title
    return
  }
  job.stage = 'Downloading the audio…'
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(3 * 60 * 1000) })
  if (!r.ok || !r.body) throw new Error(`That link answered ${r.status}.`)
  if (Number(r.headers.get('content-length')) > MAX_BYTES) throw new Error('That file is over 300 MB.')
  const file = path.join(job.dir, 'link.audio')
  let n = 0
  const cap = new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > MAX_BYTES ? new Error('That file is over 300 MB.') : null, chunk) } })
  await pipeline(Readable.fromWeb(r.body), cap, createWriteStream(file))
  job.audio = file
  job.source.title = job.source.title || decodeURIComponent(u.pathname.split('/').pop() || u.hostname)
}

async function catalogue(files) {
  const by = new Map(files.map((f) => [f, { file: f }]))
  if (!files.length || !isMirrorEnabled()) return by
  try {
    const { rows } = await mirrorQuery(
      `SELECT DISTINCT ON (raw->>'Filename') raw->>'Filename' AS file, track_title, track_artist, album_title, album_artist,
              catalogue_no, release_year, raw->>'ISRC' AS isrc
         FROM tracks WHERE raw->>'Filename' = ANY($1) ORDER BY raw->>'Filename', fm_record_id`, [files])
    for (const r of rows) by.set(r.file, { ...by.get(r.file), title: r.track_title, artist: r.track_artist, album: r.album_title,
      albumArtist: r.album_artist, catalogue: r.catalogue_no, year: r.release_year, isrc: r.isrc })
  } catch (err) { console.warn('[fpcheck] catalogue lookup failed:', err.message) }
  return by
}

/** Run a job to the end (never throws: a failure lands in job.error). */
export async function runJob(job, link) {
  try {
    if (link) await fetchLink(job, link)
    job.stage = 'Finding the fingerprints in your audio…'
    const peaksFile = path.join(job.dir, 'peaks.bin')
    const meta = JSON.parse(await run('python3', [PEAKS, job.audio, peaksFile, String(MAX_SECONDS)], 5 * 60 * 1000))
    if (meta.seconds < 3) throw new Error('That audio is shorter than 3 seconds — too short to check.')
    job.stage = state === 'ready' ? 'Comparing with the catalogue…' : 'Loading the catalogue fingerprints (first check only, about 30 seconds)…'
    const loading = state !== 'ready'
    const res = await match(peaksFile)
    if (loading) job.stage = 'Comparing with the catalogue…'
    if (!res.ok) throw new Error(res.error || 'The matcher could not read the audio.')
    const cat = await catalogue([...new Set(res.matches.map((m) => m.file))])
    job.result = {
      seconds: meta.seconds, scanned: meta.scanned, indexTracks: info?.tracks || null, ms: res.ms,
      matches: res.matches.map((m) => ({ ...m, track: cat.get(m.file) || { file: m.file }, audioUrl: `${MEDIA}/${encodeURIComponent(m.file)}.mp3` })),
    }
    job.status = 'done'; job.stage = 'Done'
  } catch (err) {
    job.status = 'error'; job.error = err.message || String(err); job.stage = 'Stopped'
    console.warn('[fpcheck] job failed:', job.error)
  }
}
