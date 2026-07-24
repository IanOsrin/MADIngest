// lib/wav-info.js — technical WAV info from a 64KB header read, formatted to
// match the Media_GetSoundInfo plugin block that Gallo's FileMaker layouts
// have always stored in the Song Files "Audio details" field. The mount and
// the plugin are gone; the numbers now come straight off the Vision object.
import { visionOpen } from './vision-drive.js'

const u32 = (b, o) => b.readUInt32LE(o)
const u16 = (b, o) => b.readUInt16LE(o)

/**
 * Walk the RIFF chunks in a partial WAV buffer. Needs fmt; data size falls
 * back to fileSize minus a canonical 44-byte header when the data chunk
 * header sits beyond the sampled bytes (huge iXML blocks, etc.).
 */
export function parseWavHeader(buf, fileSize) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12, fmt = null, dataSize = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = u32(buf, off + 4)
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = {
        audioFormat:   u16(buf, off + 8),
        channels:      u16(buf, off + 10),
        sampleRate:    u32(buf, off + 12),
        byteRate:      u32(buf, off + 16),
        bitsPerSample: u16(buf, off + 22),
      }
    }
    if (id === 'data') { dataSize = size; break }
    off += 8 + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt) return null
  if (dataSize == null || dataSize === 0xFFFFFFFF) dataSize = Math.max(0, (fileSize || 0) - 44)
  const durationSec = fmt.byteRate ? dataSize / fmt.byteRate : null
  return {
    format:         'WAV',
    audioFormat:    fmt.audioFormat, // 1 = PCM, 0xFFFE = extensible (wraps PCM)
    channels:       fmt.channels,
    sampleSizeBits: fmt.bitsPerSample,
    sampleRateHz:   fmt.sampleRate,
    bitRateKbps:    fmt.byteRate ? Math.round(fmt.byteRate * 8 / 1000) : null,
    durationSec:    durationSec != null ? Math.round(durationSec * 1000) / 1000 : null,
  }
}

/** 279.216 → "000:04:39.216" (the plugin's HHH:MM:SS.mmm shape). */
export function hmsMillis(sec) {
  if (sec == null) return null
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return `${String(h).padStart(3, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

/** ISO timestamp → "09-09-2025 09:35:33" (the plugin's DD-MM-YYYY shape). */
function tsPlugin(iso) {
  if (!iso) return 'N/A'
  const d = new Date(iso)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Reproduce the Media_GetSoundInfo block, populated from the header info.
 * Constants the plugin always emitted for linear PCM are kept verbatim
 * (Volume 256, Sample Format 6C70636D = 'lpcm', Encoder/Compression N/A) so
 * any FM calc parsing the old field keeps working. S3 has no true creation
 * date — the object's modified date fills both slots.
 */
export function buildSoundInfoBlock(info, { modified = null } = {}) {
  const dur = hmsMillis(info.durationSec) ?? 'N/A'
  const ts  = tsPlugin(modified)
  return [
    `Format: ${info.format}`,
    `Track 1`,
    `  Volume: 256`,
    `  Duration (s): ${dur}`,
    `  Creation Date (ts): ${ts}`,
    `  Modification Date (ts): ${ts}`,
    `  Media`,
    `    Media Duration (s): ${dur}`,
    `    Media Creation Date (ts): ${ts}`,
    `    Media Modification Date (ts): ${ts}`,
    `    Media Language: 0`,
    `    Media Quality: 0`,
    `    Sample Description 1`,
    `      Sample Format: 6C70636D`,
    `      Number of Channels: ${info.channels}`,
    `      Sample Size (b): ${info.sampleSizeBits}`,
    `      Sample Rate (Hz): ${info.sampleRateHz}`,
    `      Bit Rate (kbps): ${info.bitRateKbps ?? 'N/A'}`,
    `      Encoder: N/A`,
    `      Compression Type: N/A`,
  ].join('\n')
}

/**
 * One-call helper: read the first 64KB of a Vision object and return
 * { info, fileSize, modified } — or null when the header isn't parseable WAV.
 */
export async function readVisionWavInfo(path) {
  const obj = await visionOpen(path, 'bytes=0-65535')
  const buf = Buffer.from(await obj.Body.transformToByteArray())
  const fileSize = obj.ContentRange
    ? parseInt(String(obj.ContentRange).split('/')[1], 10) || null
    : (obj.ContentLength ?? null)
  const modified = obj.LastModified ? new Date(obj.LastModified).toISOString() : null
  const info = parseWavHeader(buf, fileSize)
  return info ? { info, fileSize, modified } : null
}
