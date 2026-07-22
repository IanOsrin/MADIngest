/**
 * lib/gallo-vision.js — bridge Gallo Catalogue records to their audio on Vision.
 *
 * Gallo stores audio as a FileMaker container reference whose `moviemac:` line
 * is a machine-specific local path from when the file was linked through a
 * Mountain Duck mount, e.g.
 *
 *   movie:12 Bengilele La.wav
 *   moviemac:/Macintosh HD/Users/fmserver/Documents/Vision.localized/gallo-music-files-wavs/…/12 Bengilele La.wav
 *
 * The machine prefix varies wildly (fmserver/Documents, Mountain Duck's
 * Volumes.noindex, other users), but EVERY path contains the anchor
 * `Vision.localized/` followed by `<bucket>/<key>`. That tail is the same on
 * every machine, so splitting on the anchor yields a mount-independent Vision
 * address — no Mountain Duck required, ever.
 *
 * This module only PARSES (pure string work) and, optionally, checks existence
 * on Vision. It never writes to FileMaker.
 */
import { visionStat } from './vision-drive.js'

const ANCHOR = 'Vision.localized/'
// Vision's buckets. Some container paths omit the Vision.localized/ anchor and
// begin straight at the bucket (moviemac:/gallo-music-files-wavs/…), so we also
// match these names directly. Extend if new buckets appear.
const KNOWN_BUCKETS = ['gallo-music-files-wavs', 'gallo-digital-cupboard']

/** Pull the first `moviemac:` line out of a FileMaker container reference. */
function firstMoviemac(containerValue) {
  if (!containerValue) return null
  for (const line of String(containerValue).split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('moviemac:')) return t.slice('moviemac:'.length).trim()
  }
  return null
}

/** A local Vision path → { bucket, key }. Returns null if it lacks the anchor. */
function pathToBucketKey(localPath) {
  if (!localPath) return null

  // Locate where the Vision portion begins: after the Vision.localized/ mount
  // anchor if present, else at a known bucket name (paths that skip the anchor
  // and start straight at /gallo-music-files-wavs/…).
  let rel = null
  const a = localPath.indexOf(ANCHOR)
  if (a >= 0) {
    rel = localPath.slice(a + ANCHOR.length)
  } else {
    for (const b of KNOWN_BUCKETS) {
      const bi = localPath.indexOf(b + '/')
      if (bi >= 0) { rel = localPath.slice(bi); break }
    }
  }
  if (rel == null) return null

  // macOS/FileMaker store accented characters DECOMPOSED (NFD: "e"+combining
  // accent), but S3 object keys are COMPOSED (NFC: "é"). Normalise to NFC or
  // every path with an accent (Gé Korsten, …) fails to match its object.
  rel = rel.replace(/^\/+/, '').normalize('NFC')
  const slash = rel.indexOf('/')
  if (slash < 0) return null // bucket with no key
  const bucket = rel.slice(0, slash)
  const key = rel.slice(slash + 1)
  if (!bucket || !key) return null
  return { bucket, key }
}

/**
 * Resolve a Gallo record's audio to a Vision location.
 * @param {object} fieldData  raw FileMaker fieldData for the record
 * @returns {object} one of:
 *   { ok:true, bucket, key, path:'/bucket/key', filename, source }
 *   { ok:false, reason, source }        // couldn't resolve
 */
export function resolveGalloAudio(fieldData = {}) {
  const f = fieldData || {}

  // Source priority: the canonical audio_Url field FIRST (once the backfill
  // populates it, it is authoritative and the mount-era container is no longer
  // consulted — so the container can be retired). Then the live container, the
  // pending-import path, and other legacy homes. Any of these may hold a Vision
  // path (with or without the Vision.localized anchor) or an http(s) URL.
  const candidates = [
    ['audio_Url', f['audio_Url'] || f['Audio_Url'] || f['audio_url']],
    ['Audio File', f['Audio File']],
    ['Pending Audio Path', f['Pending Audio Path']],
    ['Audio Container', f['Audio Container']],
    ['WAV', f['WAV']],
  ]

  for (const [source, val] of candidates) {
    if (!val) continue
    const mac = firstMoviemac(val) || String(val) // some fields hold a bare path
    const bk = pathToBucketKey(mac)
    if (bk) {
      const filename = bk.key.split('/').pop() || null
      return { ok: true, kind: 'vision', bucket: bk.bucket, key: bk.key, path: `/${bk.bucket}/${bk.key}`, filename, source }
    }
    // Some containers hold an http(s) streaming URL instead of a mount path —
    // e.g. digitalcupboard.app/Streaming_SSL/… (an older audio home). Real,
    // just not on Vision yet; the audio endpoint can still serve/redirect it.
    const m = String(mac).match(/https?:\/\/\S+/)
    if (m) {
      const url = m[0].trim()
      return { ok: true, kind: 'url', url, filename: url.split('/').pop() || null, source }
    }
  }

  // A stored S3/HTTP URL on a dedicated field (rare today — File URL is empty).
  const url = f['File URL'] || f['Audio URL'] || f['S3 URL']
  if (url && /^https?:\/\//i.test(url)) {
    return { ok: true, kind: 'url', url: String(url).trim(), filename: String(url).split('/').pop() || null, source: 'File URL' }
  }

  // Nothing usable. Distinguish "no audio field at all" from "present but
  // couldn't parse a Vision address" so the audit can bucket them separately.
  const anyAudioField = candidates.some(([, v]) => v && String(v).trim())
  return { ok: false, reason: anyAudioField ? 'unparseable-path' : 'no-audio-field',
           source: anyAudioField ? candidates.find(([, v]) => v && String(v).trim())[0] : null }
}

/** Resolve + confirm the object actually exists on Vision (one HEAD-ish call). */
export async function resolveAndVerify(fieldData) {
  const r = resolveGalloAudio(fieldData)
  if (!r.ok || r.url) return { ...r, exists: r.ok ? 'skipped-url' : false }
  try {
    const stat = await visionStat(r.path)
    return { ...r, exists: !!stat, size: stat?.size ?? null }
  } catch (e) {
    return { ...r, exists: false, error: e.message }
  }
}
