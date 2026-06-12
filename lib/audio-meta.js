import { parseBuffer } from 'music-metadata'

/**
 * Derive a human-readable song title from an audio filename.
 *
 * Handles the standard Gallo naming convention:
 *   ArtistName_SongTitle_CatalogNumber.ext
 *
 * Strips the extension, drops the first segment (artist name) and the last
 * segment (catalogue number), then joins whatever remains with spaces.
 * Gracefully degrades for filenames that don't match the pattern:
 *   - 2 segments  → returns the second (assumes Artist_Title)
 *   - 1 segment   → returns the bare basename
 */
export function titleFromFilename(filename) {
  const base  = filename.replace(/\.[^.]+$/, '').trim()          // strip extension
  const parts = base.split('_').map(p => p.trim()).filter(Boolean)
  if (parts.length >= 3) return parts.slice(1, -1).join(' ')     // Artist_Title_CatNo
  if (parts.length === 2) return parts[1]                         // Artist_Title
  return base                                                      // bare name
}

/**
 * Extract metadata from an audio file buffer.
 * Returns a normalised object mapped to catalog field names.
 * Never throws — returns partial data + errors array on failure.
 */
export async function extractAudioMeta(buffer, mimeType) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    const { common, format, native } = await parseBuffer(buf, { mimeType })

    const technical = {
      duration_sec:  format.duration         ? Math.round(format.duration) : null,
      sample_rate:   format.sampleRate        || null,
      bit_depth:     format.bitsPerSample     || null,
      channels:      format.numberOfChannels  || null,
      bitrate_kbps:  format.bitrate           ? Math.round(format.bitrate / 1000) : null,
      codec:         format.codec             || null,
      container:     format.container         || null  // 'WAVE', 'MPEG', etc.
    }

    // EBU R128 loudness from BWF bext chunk (professional WAVs from DAWs often have this)
    const riffTags = native?.['riff'] || []
    const bextTag  = riffTags.find(t => t.id === 'bext')
    const loudness_lufs = bextTag?.value?.loudnessValue != null
      ? bextTag.value.loudnessValue / 100   // stored as int × 100
      : null

    const meta = {
      title:        common.title                          || null,
      artist:       common.artist ?? common.artists?.[0] ?? null,
      album:        common.album                          || null,
      year:         common.year                           || null,
      genre:        common.genre?.[0]                     || null,
      isrc:         common.isrc                           || null,
      bpm:          common.bpm         ? Math.round(common.bpm) : null,
      key_sig:      common.key                            || null,
      track_number: common.track?.no                      || null,
      language:     common.language                       || null,
      comment:      (Array.isArray(common.comment) ? common.comment[0]?.text : common.comment) || null,
      artwork:      common.picture?.[0]
        ? { data: common.picture[0].data, mime: common.picture[0].format }
        : null
    }

    return { meta, technical, loudness_lufs, errors: [] }
  } catch (err) {
    return { meta: {}, technical: {}, loudness_lufs: null, errors: [err.message] }
  }
}

/**
 * Detect audio format from buffer magic bytes.
 * Returns 'wav' | 'mp3' | 'flac' | 'aiff' | 'unknown'
 */
export function detectAudioFormat(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'   // RIFF
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)                           return 'mp3'   // MPEG sync
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)                   return 'mp3'   // ID3 header
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'flac'  // fLaC
  if (b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D) return 'aiff'  // FORM
  return 'unknown'
}

/**
 * Generate human-readable warnings for the submission form UI.
 */
export function generateWarnings(technical = {}, format = '', meta = {}) {
  const warnings = []

  if (technical.sample_rate && technical.sample_rate < 44100) {
    warnings.push(`Low sample rate (${technical.sample_rate} Hz)`)
  }
  if (technical.bit_depth && technical.bit_depth < 16) {
    warnings.push(`Low bit depth (${technical.bit_depth}-bit)`)
  }
  if (technical.channels === 1) {
    warnings.push('Mono file — confirm this is intentional')
  }
  if (format === 'mp3' || format === 'aiff') {
    warnings.push('Non-standard format — special approval required')
  }
  if (format === 'mp3' && technical.bitrate_kbps && technical.bitrate_kbps < 320) {
    warnings.push(`Lossy source at low bitrate (${technical.bitrate_kbps} kbps)`)
  }
  if (technical.duration_sec && technical.duration_sec < 60) {
    warnings.push(`Very short track (${technical.duration_sec}s) — confirm`)
  }
  if (technical.duration_sec && technical.duration_sec > 720) {
    warnings.push(`Long track (${Math.round(technical.duration_sec / 60)} min) — confirm`)
  }
  if (!meta?.isrc) {
    warnings.push('No ISRC found — please enter manually')
  }

  return warnings
}
