/**
 * lib/link-album-audio.js — point a MAM album's songs at their Vision files.
 *
 * Uploading only puts bytes on Vision; MAM still has no idea they exist. This
 * closes that gap: list the album's own folder and match its files to the
 * album's tracks.
 *
 * Two rules that matter, both learned the hard way:
 *
 *  1. Match on normalised TITLE, never on position. Vision lists
 *     alphabetically and albums are routinely part-digitised, so "third file"
 *     and "track 3" are unrelated. Position-matching silently mislabels audio.
 *
 *  2. Fill EMPTY links only. An existing Audio_Vision_URL is left alone —
 *     re-pointing audio that already plays is a different decision from
 *     filling a gap, and not one an upload button should make.
 *
 * Anything unmatched or ambiguous is reported, never guessed at.
 */
import { visionListKeys } from './vision-drive.js'
import { visionFolderForAlbum } from './vision-destination.js'

const AUDIO = /\.(wav|flac|aiff?|mp3|m4a)$/i

/** Title normaliser: strip accents, bracketed asides, and all punctuation. */
const tn = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/** Leading track numbers are a filename habit, not part of the title. */
const titleFromFile = f => tn(String(f).replace(AUDIO, '').replace(/^\s*\d{1,3}[\s._-]+/, ''))

function fmBase() {
  return `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
}

async function fmSession() {
  const base = fmBase()
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const s = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
  const token = s?.response?.token
  if (!token) throw Object.assign(new Error('Could not reach Music Arena Master'), { status: 502 })
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  return {
    H,
    async find(layout, query, limit = 500) {
      const r = await fetch(`${base}/layouts/${layout}/_find`, { method: 'POST', headers: H, body: JSON.stringify({ query, limit }) })
      const j = await r.json()
      // 401 = "no records match", which is a normal empty result here
      if (j?.messages?.[0]?.code === '401') return []
      return j?.response?.data || []
    },
    async patch(layout, recordId, fieldData) {
      const r = await fetch(`${base}/layouts/${layout}/records/${recordId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fieldData }) })
      return r.status === 200
    },
    close: () => fetch(base + '/sessions/' + token, { method: 'DELETE', headers: H }).catch(() => {}),
  }
}

/**
 * @param {string} albumID
 * @param {object} [opts]
 * @param {boolean} [opts.apply]  false (default) reports what it would do
 * @returns {Promise<object>} { album, folder, filesFound, linked, alreadyLinked,
 *                              noMatch[], ambiguous[], unusedFiles[], failed }
 */
export async function linkAlbumAudio(albumID, { apply = false } = {}) {
  const db = await fmSession()
  try {
    const rec = (await db.find('Albums', [{ AlbumID: '==' + albumID }], 1))[0]
    if (!rec) throw Object.assign(new Error(`No album ${albumID} in Music Arena Master`), { status: 404 })
    const af = rec.fieldData
    const album = {
      albumID: af.AlbumID, artist: af['Album Artist'], title: af['Album Title'],
      catalogue: af['Album Catalogue Number'] || af['Reference Catalogue Number'],
    }
    const folder = visionFolderForAlbum(album).folder

    // visionListKeys returns a Map of key -> size (NOT an array — .length is undefined)
    const listed = await visionListKeys(folder)
    const files = [...listed.keys()].filter(k => AUDIO.test(k))

    const songs = await db.find('Songs', [{ AlbumID: '==' + albumID }], 500)

    const byTitle = new Map()
    for (const f of files) {
      const t = titleFromFile(f.split('/').pop())
      if (!byTitle.has(t)) byTitle.set(t, [])
      byTitle.get(t).push(f)
    }

    const actions = [], noMatch = [], ambiguous = []
    let alreadyLinked = 0
    for (const s of songs) {
      const g = s.fieldData
      if (String(g['Audio_Vision_URL'] || '').trim()) { alreadyLinked++; continue }
      const cands = byTitle.get(tn(g['Track Name'])) || []
      if (cands.length === 1) actions.push({ recordId: s.recordId, path: cands[0], title: g['Track Name'] })
      else if (cands.length > 1) ambiguous.push({ title: g['Track Name'], matches: cands.length })
      else noMatch.push(g['Track Name'] || '(blank title)')
    }
    const unusedFiles = files.filter(f => !actions.some(a => a.path === f)).map(f => f.split('/').pop())

    const result = {
      album, folder, songs: songs.length, filesFound: files.length,
      alreadyLinked, noMatch, ambiguous, unusedFiles,
      toLink: actions.map(a => ({ title: a.title, file: a.path.split('/').pop() })),
      linked: 0, failed: 0, applied: apply,
    }
    if (!apply) return result

    for (const a of actions) {
      const ok = await db.patch('Songs', a.recordId, { 'Audio_Vision_URL': a.path, 'Audio_Truth': 'Vision' })
      ok ? result.linked++ : result.failed++
    }
    return result
  } finally {
    await db.close()
  }
}

export default linkAlbumAudio
