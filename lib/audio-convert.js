/**
 * lib/audio-convert.js
 * WAV → MP3 (320 kbps CBR by default) using system ffmpeg.
 *
 * The codebase shells out to ffmpeg rather than bundling ffmpeg-static so we
 * keep the install lean. ffmpeg must be on PATH on the host, or set FFMPEG_BIN
 * in .env to a custom location.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
