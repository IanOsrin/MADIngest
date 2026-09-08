#!/usr/bin/env node
/**
 * scripts/search-merge-smoke.mjs — `npm run search:smoke`
 *
 * Guards the Source tab's cross-database precedence. Offline, no FM.
 *
 * The bug this exists to stop coming back: the merge was first-writer-wins and
 * the source order put Gallo Catalogue first, so Gallo silently won every field
 * it had a value for and an edit made in MadStreamer could never appear in the
 * Source tab. It looked exactly like a caching problem and wasn't.
 */
import { mergeSourceTracks } from '../lib/search-merge.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}

// Ranks as the route defines them: MadStreamer wins, then Gallo, CMS, extract.
const MS    = { key: 'madstreamer', label: 'MadStreamer',      rank: 0 }
const GALLO = { key: 'gallo',       label: 'Gallo Catalogue',  rank: 1 }
const CMS   = { key: 'cms2024',     label: 'CMS 2024',         rank: 2 }
const META  = { key: 'metadata',    label: 'Metadata Extract', rank: 3 }

const track = (over = {}) => ({
  title: 'Transister Twist', artist_name: 'Dana Valery With The Dan Hill Combo',
  album_title: "Everybody's Doin' The Twist", catalogue_no: 'FCL 5216',
  isrc: 'ZAC032302775', sequence_no: 3, ...over,
})

console.log('precedence — MadStreamer wins where databases disagree')
{
  // The real divergence observed on 2026-09-08.
  const [song] = mergeSourceTracks([
    { ...GALLO, tracks: [track({ title: 'Transistor Twist (Collard Greens and Black Eyed Peas)', artist_name: 'The Dan Hill Combo' })] },
    { ...MS,    tracks: [track()] },
  ])
  check('title from MadStreamer',  song.title,  'Transister Twist')
  check('artist from MadStreamer', song.artist, 'Dana Valery With The Dan Hill Combo')
  check('found in both',           song.sources.map(s => s.key).sort(), ['gallo', 'madstreamer'])
}

console.log('precedence does not depend on the order sources finish in')
{
  const gallo = { ...GALLO, tracks: [track({ title: 'Gallo title' })] }
  const ms    = { ...MS,    tracks: [track({ title: 'Streamer title' })] }
  check('MadStreamer first', mergeSourceTracks([ms, gallo])[0].title, 'Streamer title')
  check('Gallo first',       mergeSourceTracks([gallo, ms])[0].title, 'Streamer title')
}

console.log('weaker sources fill blanks but never overwrite')
{
  const [song] = mergeSourceTracks([
    { ...MS,   tracks: [track({ album_title: '', catalogue_no: '' })] },
    { ...CMS,  tracks: [track({ title: 'CMS title', album_title: 'CMS album', catalogue_no: '' })] },
    { ...META, tracks: [track({ catalogue_no: 'META CAT' })] },
  ])
  check('MadStreamer title kept',      song.title,        'Transister Twist')
  check('blank album filled by CMS',   song.album,        'CMS album')
  // Only reached because every stronger source left it blank.
  check('blank cat filled by extract', song.catalogue_no, 'META CAT')
}

console.log('identity')
{
  const two = mergeSourceTracks([
    { ...MS, tracks: [track(), track({ isrc: 'ZAC999', title: 'Another' })] },
  ])
  check('distinct ISRCs stay separate', two.length, 2)

  const noIsrc = mergeSourceTracks([
    { ...MS,    tracks: [track({ isrc: '' })] },
    { ...GALLO, tracks: [track({ isrc: '' })] },
  ])
  check('no ISRC → matched on title+artist', noIsrc.length, 1)

  const renamed = mergeSourceTracks([
    { ...MS,    tracks: [track({ isrc: '', title: 'Renamed In Streamer' })] },
    { ...GALLO, tracks: [track({ isrc: '' })] },
  ])
  // Documents a real limitation: with no ISRC there is no stable identity, so a
  // title edit in one database splits the row instead of updating it.
  check('no ISRC + renamed → splits into two rows', renamed.length, 2)
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall search-merge checks passed')
process.exit(failures ? 1 : 0)
