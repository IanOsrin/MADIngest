/**
 * lib/cover-maker.js — the Make Cover tab (Ian, 2026-10-15: let the client make generated covers themselves instead of
 * asking for batches). Same steps as scripts/generate-covers.mjs, one album at a time:
 *
 *   find an album in MAM → pick a style (jazz · gospel · vintage · vinyl) → preview → save.
 *
 * Saving goes ONLY through lib/album-cover.js setAlbumCover (GMVi JPEG → S3 → MAM + MADStreamer, original archived in
 * the "Generated covers" Vision folder), then MAM Albums.Comment gets "Artwork Done", exactly as the batches did.
 * An album that already has a cover is only replaced when the caller says so (the tab asks first).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderStyled, styleFor } from './cover-styles.js'
import { isRealCatalogue } from './cover-template.js'
import { setAlbumCover } from './album-cover.js'
import { findMamAlbumRecords, countMamAlbumsWithCatalogue, getMamFieldData, updateMamAlbum } from './fm-mam.js'

export const COVER_STYLES = ['jazz', 'gospel', 'vintage', 'vinyl']
const GENERATED_FOLDER = '/gallo-music-files-wavs/Digital Sleeves/Generated covers'

// The designs are drawn with macOS fonts. The hosted Linux server has free look-alikes instead (fonts/cover-fonts, wired in
// by the Dockerfile); a server with neither would draw covers in a fallback font, so saving is refused there.
const BUNDLED_CONF = '/etc/fonts/conf.d/60-gallo-covers.conf'
const FONT_FILES = ['Didot.ttc', 'Avenir Next Condensed.ttc', 'Bodoni 72.ttc', 'Bodoni 72 Smallcaps Book.ttf', 'Rockwell.ttc', 'Copperplate.ttc', 'DIN Condensed Bold.ttf', 'Bodoni Ornaments.ttf']
const FONT_DIRS = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')]
export function coverFonts() {
  const missing = FONT_FILES.filter(f => !FONT_DIRS.some(d => fs.existsSync(path.join(d, f))))
  if (!missing.length) return { ok: true, fonts: 'mac', missing }
  if (fs.existsSync(BUNDLED_CONF)) return { ok: true, fonts: 'look-alike', missing: [] }
  return { ok: false, missing }
}

const blank = (v) => v == null || String(v).trim() === ''
const albumInput = (a) => ({ title: a['Album Title'], artist: a['Album Artist'], catalogue: a['Album Catalogue Number'], year: a['Year of Release'], label: a.Label, genre: a.Genre })

/** What the tab shows about one MAM album, and whether a cover may be made for it. */
function describe(recordId, a) {
  const cat = String(a['Album Catalogue Number'] || '').trim()
  const hasCover = !blank(a.Artwork_S3_URL) || !blank(a.Artwork_Vision_URL)
  return {
    recordId: String(recordId), catalogue: cat, title: a['Album Title'] || '', artist: a['Album Artist'] || '',
    genre: a.Genre || '', year: a['Year of Release'] || '', label: a.Label || '', comment: a.Comment || '',
    suggestedStyle: styleFor(a.Genre) || 'vinyl',
    cover: hasCover ? {
      s3: a.Artwork_S3_URL || '', vision: a.Artwork_Vision_URL || '',
      generated: /Generated covers/i.test(a.Artwork_Vision_URL || ''),
    } : null,
    problem: !cat ? 'This album has no catalogue number in MAM, so a cover cannot be filed for it.'
      : !isRealCatalogue(cat) ? `The catalogue number "${cat}" looks like Artist_Title text — fix it in MAM first.`
      : null,
  }
}

export async function searchAlbums(term) {
  const rows = await findMamAlbumRecords(term)
  return rows.map(r => describe(r.recordId, r.fieldData))
}

async function readAlbum(recordId) {
  const a = await getMamFieldData('Albums', recordId)
  if (!a) throw Object.assign(new Error('That album is no longer in MAM'), { status: 404 })
  return a
}

export async function getAlbum(recordId) { return describe(recordId, await readAlbum(recordId)) }

/** A small JPEG of the cover, for the preview — nothing is saved. */
export async function previewCover(recordId, style, size = 900) {
  if (!COVER_STYLES.includes(style)) throw Object.assign(new Error('Unknown style'), { status: 400 })
  return renderStyled(albumInput(await readAlbum(recordId)), { style, size, quality: 85 })
}

/**
 * Make and save the cover. `replace` must be true when the album already has a cover.
 * Returns what happened on each side (MAM, MADStreamer, Vision, Comment) for the tab to show.
 */
export async function saveCover(recordId, style, { replace = false } = {}) {
  if (!COVER_STYLES.includes(style)) throw Object.assign(new Error('Unknown style'), { status: 400 })
  const fonts = coverFonts()
  if (!fonts.ok) throw Object.assign(new Error('This server does not have the cover fonts, so covers can only be made on the office Mac.'), { status: 409 })

  // Live read — the record may have changed since the page loaded it.
  const a = await readAlbum(recordId)
  const info = describe(recordId, a)
  if (info.problem) throw Object.assign(new Error(info.problem), { status: 409 })
  if (info.cover && !replace) throw Object.assign(new Error('This album already has a cover. Tick “replace” to overwrite it.'), { status: 409 })
  const same = await countMamAlbumsWithCatalogue(info.catalogue)
  if (same !== 1) throw Object.assign(new Error(`${same} MAM albums share the catalogue ${info.catalogue}, so the cover could land on the wrong one. Sort the duplicate out first.`), { status: 409 })

  const jpg = await renderStyled(albumInput(a), { style })
  const res = await setAlbumCover(info.catalogue, jpg, { label: 'generated cover', visionFolder: GENERATED_FOLDER })
  const out = {
    catalogue: info.catalogue, style, gmvi: res.gmvi, url: res.url, replaced: res.replaced,
    mam: res.mam?.ok ? 'updated' : (res.mam?.reason || 'not updated'),
    // No Tape Files record = the album is not on the website yet: normal for MAM-only albums, not a fault.
    madstreamer: res.madstreamer?.ok ? 'updated'
      : (!res.madstreamer?.reason || /no Tape Files/i.test(res.madstreamer.reason)) ? 'not on the website yet' : res.madstreamer.reason,
    vision: res.vision?.ok ? res.vision.path : (res.vision?.reason || 'not archived'),
  }
  // Only mark the album when MAM took the cover on THIS record.
  if (!res.mam?.ok || String(res.mam.recordId) !== String(recordId)) {
    out.comment = 'left alone — MAM was not updated on this album'
    return out
  }
  const now = await readAlbum(recordId)
  const comment = blank(now.Comment) ? 'Artwork Done' : (/Artwork Done/.test(now.Comment) ? now.Comment : `${now.Comment}\nArtwork Done`)
  if (comment !== now.Comment) await updateMamAlbum(recordId, { Comment: comment })
  const back = await readAlbum(recordId)
  out.comment = /Artwork Done/.test(back.Comment || '') ? 'Artwork Done' : 'NOT written — check MAM'
  out.checked = back.Artwork_S3_URL === res.url && /Artwork Done/.test(back.Comment || '')
  return out
}
