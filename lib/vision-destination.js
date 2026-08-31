/**
 * lib/vision-destination.js — where an album's WAVs belong on Vision.
 *
 * Rendered Files is organised by the artist's initial:
 *
 *   /gallo-digital-cupboard/Rendered Files/<group>/<Artist>/<Artist>_<Album>_<CAT>/<Track>.wav
 *
 * Ten groups (A-D, E-H, I-K, L, M, N-P, Q-R, S, T, U-Z) covering 18,917 of
 * 18,994 existing files — the 77 that sit outside their group are historical
 * and Ian's instruction is to follow the rule, not them. A-D also has a second
 * single-letter layer on some albums; that is an inconsistency, not the rule,
 * so nothing new is written that way.
 *
 * Computing this removes the step that was going wrong: the upload tab took a
 * hand-typed destination, and because it maps a picked folder's CONTENTS (not
 * the folder itself) onto that path, a mistyped level dropped every file loose
 * into the parent. Deriving the path means the album folder always exists and
 * is always named the same way as the other 18,000.
 */

const ROOT = process.env.VISION_RENDERED_ROOT || '/gallo-digital-cupboard/Rendered Files'

// The groups actually in use, in order. A letter outside them all (a digit or
// symbol, e.g. the "004's" folder) falls back to the first group, which is
// where such names already live.
const GROUPS = ['A-D', 'E-H', 'I-K', 'L', 'M', 'N-P', 'Q-R', 'S', 'T', 'U-Z']

export function letterGroup(artist) {
  const first = String(artist || '').trim().replace(/^["'`]+/, '').charAt(0).toUpperCase()
  if (!/[A-Z]/.test(first)) return GROUPS[0]
  for (const g of GROUPS) {
    const lo = g[0], hi = g[g.length - 1]
    if (first >= lo && first <= hi) return g
  }
  return GROUPS[GROUPS.length - 1]
}

/** Vision forbids nothing much, but a slash would invent a folder level. */
export function safeSegment(s) {
  return String(s || '')
    .replace(/[\/\\]/g, '-')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The album folder name, matching the existing convention:
 *   Artist_Album_CAT      e.g. "Chris Blignaut_Die Juweel Jare_CDTGE 74"
 *
 * The three slots are always present, so an album with no title keeps its empty
 * slot — "4 Jacks & A Jill__PD 1151a" is how ~1,000 existing folders read, and
 * collapsing it would make new folders sort and match differently from old
 * ones. A trailing separator (no catalogue) is trimmed, since nothing on Vision
 * ends in an underscore.
 */
export function albumFolderName({ artist, title, catalogue }) {
  const a = safeSegment(artist), t = safeSegment(title), c = safeSegment(catalogue)
  if (!a && !t && !c) return null
  return `${a}_${t}_${c}`.replace(/_+$/, '')
}

/**
 * Full destination folder for an album. Returns { folder, group, artistDir,
 * albumDir } so a caller can show the operator exactly where files will land
 * BEFORE anything is written.
 */
export function visionFolderForAlbum({ artist, title, catalogue }) {
  const a = safeSegment(artist)
  if (!a) throw new Error('an album artist is required to place the folder')
  const album = albumFolderName({ artist, title, catalogue })
  if (!album) throw new Error('an album title or catalogue number is required')
  const group = letterGroup(a)
  return {
    group, artistDir: a, albumDir: album,
    folder: `${ROOT}/${group}/${a}/${album}`,
  }
}
