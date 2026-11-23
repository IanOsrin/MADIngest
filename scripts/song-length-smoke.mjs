#!/usr/bin/env node
/**
 * scripts/song-length-smoke.mjs — `npm run song-length:smoke`
 *
 * Guards lib/song-length.js, the one converter every Duration write uses.
 * Offline, no FileMaker.
 *
 * Duration is a FileMaker TIME field: "3:42" or a bare "222" written as-is
 * becomes hours, and the site shows a 3:42 song as 222:00. It happened in
 * June, July and November 2026 (71 tracks on 17 new albums), each time
 * through a path that copied or wrote the value unconverted.
 */
import { songLengthToFmTime, songLengthSeconds } from '../lib/song-length.js'
import { MAP_SONG } from '../lib/publish-album.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}

console.log('good input')
check('M:SS', songLengthToFmTime('3:42'), '00:03:42')
check('MM:SS', songLengthToFmTime('04:12'), '00:04:12')
check('padded HH:MM:SS kept', songLengthToFmTime('00:03:42'), '00:03:42')
check('MAM unpadded H:MM:SS kept', songLengthToFmTime('0:02:53'), '00:02:53')
check('seconds as number', songLengthToFmTime(222), '00:03:42')
check('seconds as string', songLengthToFmTime('222'), '00:03:42')
check('seconds with decimals', songLengthToFmTime('221.6'), '00:03:42')
check('ISO-8601', songLengthToFmTime('PT3M42S'), '00:03:42')
check('spreadsheet day fraction', songLengthToFmTime(222 / 86400), '00:03:42')
check('real seconds on a long track kept', songLengthToFmTime('1:02:03'), '01:02:03')
check('long M:SS mix', songLengthToFmTime('65:30'), '01:05:30')

console.log('already-broken values are repaired, not copied')
check('3:42 stored as 03:42:00', songLengthToFmTime('03:42:00'), '00:03:42')
check('9:53 stored as 9:53:00', songLengthToFmTime('9:53:00'), '00:09:53')
check('4:00 stored as 04:00:00', songLengthToFmTime('04:00:00'), '00:04:00')
check('275 s stored as 275:00:00', songLengthToFmTime('275:00:00'), '00:04:35')
check('under an hour left alone (ambiguous)', songLengthToFmTime('0:20:00'), '00:20:00')

console.log('unreadable → null (caller skips the field)')
check('empty', songLengthToFmTime(''), null)
check('null', songLengthToFmTime(null), null)
check('text', songLengthToFmTime('n/a'), null)
check('bad minutes', songLengthToFmTime('1:75:00'), null)
check('negative', songLengthSeconds(-5), null)

console.log('Publish and the MAM sync carry Duration (and so must convert it)')
check('MAP_SONG maps Duration', MAP_SONG['Duration'], 'Duration')

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall good')
