/**
 * research/fingerprint/make-queries.mjs — the attacks a fingerprinter must survive.
 *
 * Every query is a 10-second excerpt (5 seconds for the short test) taken 40%
 * into the track, then damaged in one specific way. One damage per file: when a
 * detector fails we need to know WHICH thing broke it, not that "something" did.
 *
 * The set is deliberately harsher than a clean re-upload, because the job Gallo
 * cares about is a sample buried in someone else's production.
 *
 *   clean10, clean5    the excerpt itself — anything that fails here is broken
 *   mp3_96, mp3_64     transcode loss, the everyday case
 *   eq                 a heavy-handed radio/club EQ curve
 *   speed_p4, speed_m4 ±4% tempo, no pitch change (DJ / broadcast pitch-up)
 *   pitch_p2, pitch_m2 ±2 semitones, tempo held (the sampler's first move)
 *   noise              white noise at roughly 18 dB SNR
 *   speech             a voice over the top, as in a video or a radio bed
 *   under_beat         mixed 12 dB UNDER another vault track — the sample case
 *   phone              300–3400 Hz band + 64k mp3, the worst realistic capture
 *
 * NEGATIVES matter as much: index-building holds tracks back, and queries cut
 * from held-back tracks must NOT match anything. Without them a detector that
 * says yes to everything scores 100% recall.
 *
 * Audio stays on the Bandlab volume; nothing here touches the repo.
 */
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const LAB = process.env.FP_LAB || '/Volumes/Bandlab/fingerprint-lab'
const REFS = `${LAB}/refs`
const OUT = `${LAB}/queries`
const CLIP = 10          // seconds
const AT = 0.40          // start 40% in: past the intro, before the fade
const CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 2))

const corpus = JSON.parse(readFileSync(`${LAB}/corpus.json`, 'utf8'))
mkdirSync(OUT, { recursive: true })

const ff = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 24 })
const duration = async (file) => {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return parseFloat(stdout.trim()) || 0
}

// A voice bed, made once: macOS `say`, because ffmpeg here has no speech filter.
const SPEECH = `${LAB}/speech.wav`
async function ensureSpeech() {
  if (existsSync(SPEECH)) return
  const aiff = path.join(os.tmpdir(), 'fp-speech.aiff')
  await run('say', ['-o', aiff, '-r', '180',
    'This recording comes from the Gallo vault in Johannesburg. The catalogue covers a hundred years of South African music, from marabi and kwela through mbaqanga and bubblegum to kwaito and amapiano.'])
  await ff(['-i', aiff, '-ac', '2', '-ar', '44100', SPEECH])
}

// The "someone else's production" a sample gets buried in: a few busy tracks
// held out of the reference set so they cannot themselves be matched.
const HOSTS = corpus.slice(-6).map(r => `${REFS}/${r.filename}.mp3`)

/** One 10 s excerpt, 40% into the track, as clean 44.1k stereo WAV. */
async function excerpt(src, dest, seconds = CLIP) {
  const dur = await duration(src)
  if (dur < seconds + 6) return false
  const start = Math.max(1, Math.min(dur - seconds - 1, dur * AT))
  await ff(['-ss', String(start.toFixed(2)), '-t', String(seconds), '-i', src, '-ac', '2', '-ar', '44100', dest])
  return true
}

/** Pitch shift keeping tempo: resample (which shifts both) then undo the tempo. */
const pitchArgs = (semitones) => {
  const r = Math.pow(2, semitones / 12)
  return ['-filter:a', `asetrate=44100*${r.toFixed(6)},aresample=44100,atempo=${(1 / r).toFixed(6)}`]
}

const ATTACKS = {
  clean10:   (i, o) => ff(['-i', i, '-c', 'copy', o]),
  mp3_96:    (i, o) => ff(['-i', i, '-b:a', '96k', o.replace(/\.wav$/, '.mp3')]),
  mp3_64:    (i, o) => ff(['-i', i, '-b:a', '64k', o.replace(/\.wav$/, '.mp3')]),
  eq:        (i, o) => ff(['-i', i, '-filter:a', 'equalizer=f=80:t=q:w=1:g=9,equalizer=f=1000:t=q:w=2:g=-6,equalizer=f=8000:t=q:w=1:g=7', o]),
  speed_p4:  (i, o) => ff(['-i', i, '-filter:a', 'atempo=1.04', o]),
  speed_m4:  (i, o) => ff(['-i', i, '-filter:a', 'atempo=0.96', o]),
  pitch_p2:  (i, o) => ff(['-i', i, ...pitchArgs(2), o]),
  pitch_m2:  (i, o) => ff(['-i', i, ...pitchArgs(-2), o]),
  noise:     (i, o) => ff(['-i', i, '-filter_complex',
                 'anoisesrc=color=white:amplitude=0.06:sample_rate=44100[n];[0:a][n]amix=inputs=2:duration=first:weights=1 1[a]',
                 '-map', '[a]', o]),
  phone:     (i, o) => ff(['-i', i, '-filter:a', 'highpass=f=300,lowpass=f=3400', '-b:a', '64k', o.replace(/\.wav$/, '.mp3')]),
}

async function speechOver(i, o) {
  await ensureSpeech()
  await ff(['-i', i, '-i', SPEECH, '-filter_complex',
    '[1:a]atrim=0:10,volume=1.6[v];[0:a][v]amix=inputs=2:duration=first:weights=1 1[a]', '-map', '[a]', o])
}

async function underBeat(i, o, hostIdx) {
  const host = HOSTS[hostIdx % HOSTS.length]
  if (!existsSync(host)) return
  // The sample sits 12 dB under the host track — the level a producer would use.
  await ff(['-i', i, '-ss', '30', '-t', '10', '-i', host, '-filter_complex',
    '[0:a]volume=0.25[s];[1:a]volume=1.0[h];[s][h]amix=inputs=2:duration=first:weights=1 1[a]', '-map', '[a]', o])
}

const results = []
const queue = corpus.map((row, i) => ({ row, i }))
let made = 0, skipped = 0

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const { row, i } = queue.shift()
    const src = `${REFS}/${row.filename}.mp3`
    if (!existsSync(src) || statSync(src).size < 100_000) { skipped++; continue }
    const base = `${OUT}/${row.filename}`
    try {
      const ten = `${base}__src10.wav`
      if (!(await excerpt(src, ten))) { skipped++; continue }
      await excerpt(src, `${base}__clean5.wav`, 5)
      results.push({ filename: row.filename, attack: 'clean5', file: `${row.filename}__clean5.wav` })

      for (const [name, fn] of Object.entries(ATTACKS)) {
        const out = `${base}__${name}.wav`
        await fn(ten, out)
        const actual = existsSync(out) ? out : out.replace(/\.wav$/, '.mp3')
        results.push({ filename: row.filename, attack: name, file: path.basename(actual) })
      }
      await speechOver(ten, `${base}__speech.wav`)
      results.push({ filename: row.filename, attack: 'speech', file: `${row.filename}__speech.wav` })
      await underBeat(ten, `${base}__under_beat.wav`, i)
      if (existsSync(`${base}__under_beat.wav`)) results.push({ filename: row.filename, attack: 'under_beat', file: `${row.filename}__under_beat.wav` })
      made++
      if (made % 10 === 0) console.log(`  ${made} tracks attacked (${results.length} queries)`)
    } catch (e) {
      console.warn(`  ${row.filename}: ${e.message.split('\n')[0].slice(0, 90)}`)
      skipped++
    }
  }
}))

writeFileSync(`${LAB}/queries.json`, JSON.stringify(results, null, 1))
const byAttack = results.reduce((m, r) => (m[r.attack] = (m[r.attack] || 0) + 1, m), {})
console.log(`\n${made} tracks attacked, ${skipped} skipped · ${results.length} query files`)
console.log(Object.entries(byAttack).map(([k, v]) => `${k}:${v}`).join(' · '))
console.log('queries.json written to', LAB)
