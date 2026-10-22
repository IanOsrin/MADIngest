/**
 * lib/audio-convert.js
 * WAV → MP3 (320 kbps CBR by default) using system ffmpeg.
 *
 * The codebase shells out to ffmpeg rather than bundling ffmpeg-static so we
 * keep the install lean. ffmpeg must be on PATH on the host, or set FFMPEG_BIN
 * in .env to a custom location.
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'

const execFileP = promisify(execFile)

const FFMPEG_BIN  = process.env.FFMPEG_BIN  || 'ffmpeg'
const MP3_BITRATE = process.env.MP3_BITRATE || '320k'

let _ffmpegOk = null

/**
 * Verify ffmpeg is available. Cached after the first successful call.
 * Throws a friendly error if ffmpeg can't be found.
 */
export async function ensureFfmpeg() {
  if (_ffmpegOk === true) return
  try {
    const { stdout } = await execFileP(FFMPEG_BIN, ['-version'])
    _ffmpegOk = true
    const firstLine = String(stdout).split('\n')[0]
    console.log(`[audio-convert] ffmpeg ready: ${firstLine}`)
  } catch (err) {
    _ffmpegOk = false
    const msg = err.code === 'ENOENT'
      ? `ffmpeg not found (looked for "${FFMPEG_BIN}"). Install ffmpeg or set FFMPEG_BIN in .env.`
      : `ffmpeg check failed: ${err.message}`
    throw new Error(msg)
  }
}

/**
 * Convert a WAV (or any ffmpeg-readable) Buffer to an MP3 Buffer at the
 * configured bitrate. Cleans up temp files on success and on failure.
 *
 * @param {Buffer} wavBuffer
 * @param {object} [options]
 * @param {string} [options.bitrate='320k'] — e.g. '320k', '256k', or 'V0' for VBR
 * @returns {Promise<Buffer>}
 */
export async function wavBufferToMp3(wavBuffer, { bitrate = MP3_BITRATE } = {}) {
  await ensureFfmpeg()

  const dir     = await mkdtemp(path.join(tmpdir(), 'galloingest-mp3-'))
  const inFile  = path.join(dir, 'in.wav')
  const outFile = path.join(dir, 'out.mp3')

  try {
    await writeFile(inFile, wavBuffer)

    // VBR shortcut: caller can pass 'V0', 'V2', etc. for LAME quality presets.
    const args = bitrate.startsWith('V')
      ? ['-y', '-i', inFile, '-codec:a', 'libmp3lame', '-q:a', bitrate.slice(1), '-id3v2_version', '3', outFile]
      : ['-y', '-i', inFile, '-codec:a', 'libmp3lame', '-b:a', bitrate, '-id3v2_version', '3', outFile]

    await execFileP(FFMPEG_BIN, args, {
      maxBuffer:  50 * 1024 * 1024,   // ffmpeg only writes to stderr, but be safe
      timeout:    20 * 60_000,        // 20-minute hard cap
    })

    return await readFile(outFile)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Streaming WAV → MP3: write the WAV into `stdin`, read the MP3 from `stdout`.
 * Nothing touches disk and only ffmpeg's small buffers sit in memory, so a whole
 * album can be converted on the 2 GB Render plan while it downloads (the MAM
 * tab's "Download as MP3", 2026-10-22). `tags` become ID3 tags (title, artist,
 * album, track, …). `finished` resolves when ffmpeg has written everything, and
 * rejects if it failed or produced nothing — ffmpeg can exit 0 on bad input.
 */
export function mp3EncodeStream({ bitrate = MP3_BITRATE, tags = {} } = {}) {
  const quality = bitrate.startsWith('V') ? ['-q:a', bitrate.slice(1)] : ['-b:a', bitrate]
  const meta = Object.entries(tags)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .flatMap(([k, v]) => ['-metadata', `${k}=${String(v).trim()}`])
  const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-codec:a', 'libmp3lame', ...quality, '-id3v2_version', '3', ...meta, '-f', 'mp3', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  let out = 0
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
  // Counted in a Transform, not a 'data' listener — that would switch stdout to
  // flowing mode and lose bytes before the reader is attached.
  const stdout = proc.stdout.pipe(new Transform({ transform(c, _e, cb) { out += c.length; cb(null, c) } }))
  // EPIPE when ffmpeg dies mid-write; `finished` carries the real reason.
  proc.stdin.on('error', () => {})
  const exited = new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`ffmpeg not found (looked for "${FFMPEG_BIN}")`) : e))
    proc.on('close', resolve)
  })
  // Both: ffmpeg has exited AND every byte it wrote has gone through the counter.
  const finished = Promise.all([exited, new Promise((r) => stdout.on('finish', r))]).then(([code]) => {
    const why = err.trim().split('\n').pop()
    if (code !== 0) throw new Error(`MP3 conversion failed (ffmpeg exit ${code})${why ? `: ${why}` : ''}`)
    if (out < 1024) throw new Error(`MP3 conversion produced no audio${why ? `: ${why}` : ''}`)
    return out
  })
  // A caller that gives up early (the browser cancelled the download) never
  // awaits this; unhandled, its rejection would take the whole server down.
  finished.catch(() => {})
  return { stdin: proc.stdin, stdout, finished, kill: () => proc.kill('SIGKILL') }
}
