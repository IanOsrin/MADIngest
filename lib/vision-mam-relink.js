/**
 * lib/vision-mam-relink.js — keep MAM's audio links pointing at renamed files.
 *
 * MAM Songs.Audio_Vision_URL holds the full Vision path of the master
 * ("/gallo-music-files-wavs/…/02 Don't Cry On My Shoulder.wav"). Renaming or
 * moving that file on the Vision tab used to orphan the link: MAM still pointed
 * at a path that no longer existed, so MP3 making and publishing failed for the
 * song. After a rename, every moved audio file's old path is looked up in MAM
 * and repointed at the new one.
 */
import { mamSession } from './fm-mam-write.js'

const AUDIO_RE = /\.(wav|flac|aiff?|mp3|m4a|ogg)$/i
const MAX_FILES = 3000

// FileMaker find operators, escaped so a path is matched literally. Gallo paths
// are full of apostrophes, commas and ampersands (harmless) and the odd "#",
// "@" or "*" (not harmless).
const fmLiteral = s => String(s)
  .replace(/[\\@*#?!=<>"~]/g, c => '\\' + c)
  .replace(/\.\./g, '\\.\\.')
  .replace(/\/\//g, '\\/\\/')

/**
 * @param {string} bucket  Vision bucket name
 * @param {{from: string, to: string}[]} items  moved object keys (without bucket)
 * @returns {{ audioFiles, relinked, failed, skipped?, songs: {recordId, from, to}[] }}
 */
export async function relinkMamAfterRename(bucket, items) {
  const audio = (items || []).filter(i => AUDIO_RE.test(i.from))
  const out = { audioFiles: audio.length, relinked: 0, failed: 0, songs: [], errors: [] }
  if (!audio.length) return out
  if (audio.length > MAX_FILES) {
    return { ...out, skipped: `${audio.length} audio files moved — too many to relink from here (limit ${MAX_FILES})` }
  }

  const db = await mamSession()
  try {
    for (const it of audio) {
      const oldPath = `/${bucket}/${it.from}`
      const newPath = `/${bucket}/${it.to}`
      // Accented names can be stored composed or decomposed; try both spellings.
      const spellings = [...new Set([oldPath.normalize('NFC'), oldPath.normalize('NFD'), oldPath])]
      let hits = []
      for (const sp of spellings) {
        hits = await db.find('Songs', [{ 'Audio_Vision_URL': '==' + fmLiteral(sp) }], 50)
        if (hits.length) break
      }
      for (const h of hits) {
        try {
          await db.patch('Songs', h.recordId, { 'Audio_Vision_URL': newPath })
          out.relinked++
          out.songs.push({ recordId: String(h.recordId), title: h.fieldData?.['Track Name'], from: oldPath, to: newPath })
        } catch (e) {
          out.failed++
          out.errors.push(`${h.fieldData?.['Track Name'] || h.recordId}: ${e.message}`)
        }
      }
    }
  } finally { await db.logout?.() }
  return out
}
