/**
 * lib/cca-ddex.js
 * Reads CCA DDEX deliveries straight off the Vision drive.
 *
 * Layout (confirmed against real deliveries, 2026-08-04):
 *   CCA DDEX/
 *     20260408110014377/            batch — timestamp name, 85–141 releases
 *       198704266508/               one folder per release, named by barcode
 *         198704266508.xml          the ERN (3.8.3)
 *         resources/
 *           198704266508_001_001.wav
 *           …
 *           198704266508_012.jpg    cover art ships HERE, numbered next in sequence
 *
 * The existing DDEX entry points take a ZIP or an XML string. Only the oldest
 * batch has ZIPs beside the folders; the recent ones have none, so reading the
 * folder directly is the only route that works across the set.
 */

import { visionList, visionOpen } from './vision-drive.js'
import { parseDDEXXml } from './ddex.js'
import { fuzzyScore } from './fuzzy-match.js'

export const CCA_ROOT = process.env.CCA_DDEX_ROOT || '/gallo-music-files-wavs/CCA DDEX'

const AUDIO_RE = /\.(wav|flac|aif|aiff|mp3|m4a)$/i
const IMAGE_RE = /\.(jpe?g|png|webp|tiff?)$/i
const FUZZY_MIN = 0.72

const ls = async (path) => {
  const r = await visionList(path)
  return Array.isArray(r) ? r : (r.entries || r.items || r.files || [])
}
const dirs  = (items) => items.filter(e => e.type === 'dir')
const files = (items) => items.filter(e => e.type !== 'dir')

/** Batch folders, newest first. Artwork siblings are folded in, not listed. */
export async function listBatches() {
  const items = dirs(await ls(CCA_ROOT))
  const artworkOf = new Map()
  for (const d of items) {
    const m = d.name.match(/^(\d{10,})[\s_-]*artwork$/i)
    if (m) artworkOf.set(m[1], d.name)
  }
  return items
    .filter(d => !/artwork$/i.test(d.name))
    .map(d => ({ name: d.name, path: `${CCA_ROOT}/${d.name}`, artworkFolder: artworkOf.get(d.name) || null }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

/** Release folders inside a batch. Each is named for its barcode. */
export async function listReleases(batchPath) {
  return dirs(await ls(batchPath)).map(d => ({
    barcode: d.name,
    path: `${batchPath.replace(/\/+$/, '')}/${d.name}`,
  }))
}

/**
 * Read one release: parse its ERN and pair each SoundRecording with its audio.
 *
 * Matching is far stronger here than in Add Album — DDEX names the file for
 * every resource, so it is normally an exact hit. ISRC and fuzzy title are
 * fallbacks for deliveries that do not honour their own FileName.
 */
export async function loadRelease(releasePath) {
  const items   = await ls(releasePath)
  const barcode = releasePath.replace(/\/+$/, '').split('/').pop()

  const xmlFile = files(items).find(f => /\.xml$/i.test(f.name))
  if (!xmlFile) throw new Error(`No ERN XML in ${releasePath}`)

  const resDir = dirs(items).find(d => /^resources$/i.test(d.name))
  const resItems = resDir ? await ls(`${releasePath}/${resDir.name}`) : []
  const audio   = files(resItems).filter(f => AUDIO_RE.test(f.name))
  const artwork = files(resItems).filter(f => IMAGE_RE.test(f.name))

  const xml = await (await visionOpen(`${releasePath}/${xmlFile.name}`)).Body.transformToString('utf8')
  const { version, tracks } = await parseDDEXXml(xml)

  const folder  = resDir ? `${releasePath}/${resDir.name}` : releasePath
  const claimed = new Set()
  const norm    = (s) => String(s || '').toLowerCase().trim()

  const matched = tracks.map(t => {
    let file = null, method = null, score = null

    if (t.file_name) {
      const hit = audio.find(f => !claimed.has(f.name) && norm(f.name) === norm(t.file_name))
      if (hit) { file = hit; method = 'filename'; score = 1 }
    }
    if (!file && t.isrc) {
      const hit = audio.find(f => !claimed.has(f.name) && norm(f.name).includes(norm(t.isrc)))
      if (hit) { file = hit; method = 'isrc'; score = 1 }
    }
    if (!file && t.track_title) {
      let best = null
      for (const f of audio) {
        if (claimed.has(f.name)) continue
        const s = fuzzyScore(t.track_title, f.name.replace(AUDIO_RE, ''))
        if (s >= FUZZY_MIN && (!best || s > best.s)) best = { f, s }
      }
      if (best) { file = best.f; method = 'fuzzy'; score = Math.round(best.s * 100) / 100 }
    }
    if (file) claimed.add(file.name)

    return {
      ...t,
      audio_file: file ? file.name : null,
      audio_url:  file ? `${folder}/${file.name}`.normalize('NFC') : null,
      audio_size: file ? (file.size ?? null) : null,
      match_method: method,
      match_score:  score,
    }
  })

  return {
    barcode, path: releasePath, ern_version: version,
    xml_file: xmlFile.name,
    tracks: matched,
    artwork: artwork.map(a => ({ name: a.name, url: `${folder}/${a.name}` })),
    unmatchedFiles: audio.filter(f => !claimed.has(f.name)).map(f => f.name),
    matchedCount: matched.filter(t => t.audio_file).length,
  }
}
