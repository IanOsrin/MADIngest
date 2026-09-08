#!/usr/bin/env node
/**
 * scripts/data-health-smoke.mjs — `npm run health:smoke`
 *
 * The checks are advisory, which makes them easy to get subtly wrong without
 * anyone noticing. Two failure modes matter:
 *   - silent on bad data  → the whole point is lost
 *   - noisy on good data  → people stop reading it, which is worse
 * Both are covered here. Offline, no FM, no Postgres.
 */
import { checkDataHealth } from '../lib/data-health.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}
const codes = (f) => f.map(x => x.code).sort()

const MS    = { key: 'madstreamer', label: 'MadStreamer',     rank: 0 }
const GALLO = { key: 'gallo',       label: 'Gallo Catalogue', rank: 1 }
const t = (over = {}) => ({
  fm_record_id: '1', title: 'A Song', artist_name: 'An Artist', album_title: 'An Album',
  catalogue_no: 'CAT 1', isrc: 'ZAC0000001', sequence_no: 1,
  upc: '6009555162274', artwork_url: 'https://x/a.jpg', audio_url: 'https://x/a.mp3', ...over,
})

console.log('silent on healthy data')
check('a clean album reports nothing', checkDataHealth([
  { ...MS, tracks: [t(), t({ title: 'B Song', isrc: 'ZAC0000002', sequence_no: 2 })] },
]), [])
check('two databases agreeing report nothing', checkDataHealth([
  { ...MS,    tracks: [t()] },
  { ...GALLO, tracks: [t({ title: 'a  SONG' })] },   // same after normalisation
]), [])
check('no sources at all', checkDataHealth([]), [])

console.log('identity faults')
check('one ISRC on two songs of the SAME album is an error', codes(checkDataHealth([
  { ...MS, tracks: [t(), t({ title: 'Different Song', sequence_no: 2 })] },
])), ['isrc-shared'])
// An ISRC identifies a recording, so one code across an original album and a
// compilation is correct — and the titles usually differ only in spelling.
// Calling that an error made 254 of 543 catalogue findings false.
check('the same recording on DIFFERENT albums is not an error', codes(checkDataHealth([
  { ...MS, tracks: [
    t({ title: 'Pata Pata',     catalogue_no: 'CAT 1', album_title: 'Grand Masters' }),
    t({ title: 'Phatha Phatha', catalogue_no: 'CAT 2', album_title: 'The Best Of', sequence_no: 2 }),
  ] },
])), ['isrc-across-albums'])
check('…and it is only an INFO', checkDataHealth([
  { ...MS, tracks: [
    t({ title: 'Pata Pata',     catalogue_no: 'CAT 1', album_title: 'Grand Masters' }),
    t({ title: 'Phatha Phatha', catalogue_no: 'CAT 2', album_title: 'The Best Of', sequence_no: 2 }),
  ] },
])[0].severity, 'info')
check('the SAME song twice is not an ISRC fault', codes(checkDataHealth([
  { ...MS, tracks: [t(), t({ sequence_no: 2 })] },
])), ['repeated-track'])
check('placeholder codes are caught', codes(checkDataHealth([
  { ...MS, tracks: [t({ isrc: '#N/A' })] },
])).includes('junk-code'), true)

console.log('invisible on the site')
check('missing UPC hides the track', codes(checkDataHealth([
  { ...MS, tracks: [t({ upc: '' })] },
])), ['hidden-from-site'])
check('a container path is not a cover', codes(checkDataHealth([
  { ...MS, tracks: [t({ artwork_url: 'image:/vol/x.jpg' })] },
])), ['hidden-from-site'])
check('only checked on the database the site reads', codes(checkDataHealth([
  { ...GALLO, tracks: [t({ upc: '' })] },
])), [])

console.log('album coherence')
check('one catalogue, two album titles', codes(checkDataHealth([
  { ...MS, tracks: [t(), t({ title: 'B', isrc: 'ZAC2', album_title: 'An Album Deluxe', sequence_no: 2 })] },
])), ['catalogue-split-title'])
check('a repeated track number', codes(checkDataHealth([
  { ...MS, tracks: [t(), t({ title: 'B', isrc: 'ZAC2', sequence_no: 1 })] },
])), ['repeated-sequence'])
check('a compilation is NOT flagged for many artists', checkDataHealth([
  { ...MS, tracks: [
    t({ artist_name: 'Brenda Fassie' }),
    t({ title: 'B', isrc: 'ZAC2', sequence_no: 2, artist_name: 'Yvonne Chaka Chaka' }),
    t({ title: 'C', isrc: 'ZAC3', sequence_no: 3, artist_name: 'Sipho Mabuse' }),
  ] },
]), [])
check('inconsistent spelling of ONE artist is flagged', codes(checkDataHealth([
  { ...MS, tracks: [
    t({ artist_name: 'Dan Hill and His Orchestra' }),
    t({ title: 'B', isrc: 'ZAC2', sequence_no: 2, artist_name: 'Dan Hill And His Orchestra and Singers' }),
    t({ title: 'C', isrc: 'ZAC3', sequence_no: 3, artist_name: 'Dan Hill' }),
  ] },
])), ['artist-spelling'])

console.log('cross-database disagreement')
check('genuinely different text is reported', codes(checkDataHealth([
  { ...MS,    tracks: [t({ title: 'Transister Twist' })] },
  { ...GALLO, tracks: [t({ title: 'Transistor Twist (Collard Greens)' })] },
])), ['cross-db-disagreement'])
{
  // A database with the same ISRC on several of ITS OWN songs must not look
  // like it is disagreeing with itself — that is the shared-ISRC fault.
  const f = checkDataHealth([
    { ...MS,    tracks: [t(), t({ title: 'Another Song', sequence_no: 2 })] },
    { ...GALLO, tracks: [t()] },
  ])
  check('own duplicates are not a cross-db disagreement',
    f.some(x => x.code === 'cross-db-disagreement'), false)
  check('…they are reported as a shared ISRC instead',
    f.some(x => x.code === 'isrc-shared'), true)
}

console.log('severity')
check('same-album shared ISRC is an error', checkDataHealth([
  { ...MS, tracks: [t(), t({ title: 'Different', sequence_no: 2 })] },
])[0].severity, 'error')
check('errors sort before warnings', checkDataHealth([
  { ...MS, tracks: [t({ upc: '' }), t({ title: 'B', isrc: 'ZAC2', album_title: 'Other', sequence_no: 2 })] },
]).map(f => f.severity), ['error', 'warn'])

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall data-health checks passed')
process.exit(failures ? 1 : 0)
