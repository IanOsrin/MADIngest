#!/usr/bin/env node
/**
 * scripts/artwork-keys-smoke.mjs — `npm run artwork:smoke`
 *
 * Guards the artwork key rules. Offline, no S3, no FileMaker.
 *
 * These are the two mistakes that would quietly break covers again:
 *   1. a prefix match handing GMVi5276 a neighbour's cover (GMVi5270, GMVi52760)
 *   2. the wrong key winning "which cover is current", so a replacement is
 *      uploaded and the site keeps showing the superseded image
 */
import { selectArtworkKeys, artworkKeyForGmvi, artworkKeyForGmviStamped } from '../lib/s3-imports.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}

console.log('artwork key shapes')
check('bare key', artworkKeyForGmvi('GMVi5276', '.jpg'), 'artwork/GMVi5276.jpg')
check('extension normalised', artworkKeyForGmvi('GMVi5276', 'PNG'), 'artwork/GMVi5276.png')
check('stamped key shape',
  /^artwork\/GMVi5276-\d{8}-\d{6}\.jpg$/.test(artworkKeyForGmviStamped('GMVi5276', '.jpg')), true)

console.log('selectArtworkKeys — newest first, neighbours excluded')
check('picks the newest stamp, bare key last', selectArtworkKeys('GMVi5276', [
  'artwork/GMVi5276.jpg',
  'artwork/GMVi5276-20260904-115116.jpg',
  'artwork/GMVi5276-20260908-101500.png',
]), [
  'artwork/GMVi5276-20260908-101500.png',
  'artwork/GMVi5276-20260904-115116.jpg',
  'artwork/GMVi5276.jpg',
])

check('never matches a neighbouring GMVi', selectArtworkKeys('GMVi5276', [
  'artwork/GMVi5270.jpg', 'artwork/GMVi52760.jpg', 'artwork/GMVi5276x.jpg',
]), [])

check('never matches a derivative', selectArtworkKeys('GMVi5276', [
  'artwork/resized/GMVi5276_300.webp', 'artwork/resized/GMVi5276_800.webp',
]), [])

check('ignores malformed stamps and stray suffixes', selectArtworkKeys('GMVi5276', [
  'artwork/GMVi5276-2026.jpg', 'artwork/GMVi5276.jpg.bak', 'artwork/GMVi5276.jpg',
]), ['artwork/GMVi5276.jpg'])

check('a GMVi that is a prefix of others matches only itself',
  selectArtworkKeys('GMVi527', ['artwork/GMVi5270.jpg', 'artwork/GMVi5276.jpg']), [])

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall artwork key checks passed')
process.exit(failures ? 1 : 0)
