#!/usr/bin/env node
/**
 * scripts/mam-health-smoke.mjs — `npm run health:mam-smoke`
 *
 * The MAM Health checks on fixtures built from real cases (2026-10-19/20):
 * they must flag RPM 5008-style doubled albums, BRS 275's shared ISRCs and the
 * mistyped "RPM 1006-S RPM 1006-S", and must NOT flag versions (English vs
 * Afrikaans Version, Part 1/2, Instrumentaal) or two artists on one title.
 * Offline: no FileMaker, no metadata cache.
 */
import { analyse, cacheDiffer, rowsOf } from '../lib/mam-health.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}
let n = 0
const song = (cat, title, over = {}) => ({ id: String(++n), cat, albumId: '', seq: '', title, artist: 'Artist', version: '',
  isrc: '', duration: '0:03:00', sources: 'cat', audio: true, cacheDiff: null, ...over })
const album = (cat, over = {}) => ({ id: 'A' + cat, cat, ref: cat, albumId: '', title: 'Album', artist: 'Artist',
  upc: '6009555162274', trackCount: '', artwork: true, ...over })
const run = async (songs, albums) => {
  const analysis = await analyse({ songs, albums, cacheLoaded: false }, () => [])
  const get = (code) => Object.assign(rowsOf(analysis, code), { extra: analysis.results.get(code).extra })
  return get
}

console.log('silent on a healthy album')
{
  const r = await run([song('OK 1', 'One', { seq: '1', isrc: 'ZAC032300553' }), song('OK 1', 'Two', { seq: '2', isrc: 'ZAC032300554' })],
                [album('OK 1', { trackCount: '2' })])
  for (const code of ['isrc-shared', 'isrc-missing', 'duplicate-songs', 'album-doubled', 'track-count', 'repeated-sequence', 'songs-without-album', 'catalogue-doubled', 'no-audio'])
    check(`${code} empty`, r(code).length, 0)
}

console.log('RPM 5008: every track twice')
{
  const songs = [
    song('RPM 5008', 'Tritch Tratch Polka', { seq: '1', isrc: 'ZAC032300553', duration: '0:02:26', artist: 'Alabama Studentegeselskap' }),
    song('RPM 5008', 'Tritch Tratch Polka', { seq: '1', isrc: 'ZAC032300553', duration: '0:02:26', artist: 'Alabama Studentegeselskap' }),
    song('RPM 5008', 'Chim Chim Cherree', { seq: '5', duration: '0:02:47', artist: 'Alabama Studentegeselskap' }),
    song('RPM 5008', "Chim Chim Cheree (From 'Mary Poppins')", { seq: '5', isrc: 'ZAC032300557', duration: '0:02:47', artist: 'Alabama Studentegeselskap' }),
  ]
  const r = await run(songs, [album('RPM 5008', { trackCount: '4' })])
  check('album-doubled', r('album-doubled').map((x) => x.catalogue), ['RPM 5008'])
  check('duplicate-songs rows', r('duplicate-songs').length, 4)
  check('repeated-sequence', r('repeated-sequence').length, 1)
}

console.log('versions are not duplicates')
{
  const r = await run([
    song('V 1', 'Paloma Blanca (English Version)'), song('V 1', 'Paloma Blanca (Afrikaans Version)'),
    song('V 1', 'Mkudu Special, Pt. 1'), song('V 1', 'Mkudu Special, Pt. 2'),
    song('V 1', 'Die Brief'), song('V 1', 'Die Brief (Instrumentaal)'),
    song('V 1', 'Anytime Of The Year', { artist: 'Judy Page' }), song('V 1', 'Anytime Of The Year', { artist: 'Murray Campbell' }),
    song('V 1', 'Serenade (Studentprins)'), song('V 1', 'Serenade (The Fair Maid of Perth)'),
  ], [album('V 1')])
  check('no duplicates', r('duplicate-songs').length, 0)
  check('not doubled', r('album-doubled').length, 0)
}

console.log('numbered titles are different tracks (live sweep, 2026-10-20)')
{
  const r = await run([song('N 1', 'Medley 1'), song('N 1', 'Medley 4:'), song('N 1', 'Kwadril Nr. 1'), song('N 1', 'Kwadril Nr. 3'),
                 song('N 1', 'GMVF09690'), song('N 1', 'GMVF09692'), song('N 1', 'Title 01'), song('N 1', 'Title 04')],
                [album('N 1'), album('Penny Penny')])
  check('no duplicates', r('duplicate-songs').length, 0)
  check('"Penny Penny" is not a doubled catalogue', r('catalogue-doubled').length, 0)
}

console.log('singles and albums (2026-10-20)')
{
  const big = (cat, titles) => titles.map((t, i) => song(cat, t[0], { seq: String(i + 1), isrc: t[1] || '', artist: t[2] || 'Artist' }))
  const r = await run([
    song('BB 1023', 'Mamaile', { isrc: 'ZAC032600198' }),
    ...big('4885-90', [['Mamaile', ''], ['Other A'], ['Other B']]),
    song('P 157', 'Elke Tweede Man', { isrc: 'ZAC032310733' }),
    ...big('PLS 7222-2', [['Elke Tweede Man', 'ZAC032399999'], ['X'], ['Y']]),
    song('NKO 67', 'The Way I Do', { isrc: 'ZAC032002172' }),
    ...big('MABC 1', [['The Way I Do', 'ZAC032002172'], ['Q'], ['R']]),
    song('LIVE 1', 'Pata Pata (Live)'),
    ...big('STUDIO 1', [['Pata Pata', 'ZAC000000001'], ['S'], ['T']]),
    song('UNK 1', 'unknown', { artist: 'unknown' }),
    ...big('UNK BIG', [['unknown', '', 'unknown'], ['unknown', '', 'unknown'], ['unknown', '', 'unknown']]),
  ], [album('BB 1023'), album('4885-90', { title: 'Singles' }), album('P 157'), album('PLS 7222-2'), album('NKO 67'),
      album('MABC 1'), album('LIVE 1'), album('STUDIO 1'), album('UNK 1'), album('UNK BIG')])
  check('bundle found', r('singles-bundle').map((x) => [x.catalogue, x.singles]), [['4885-90', 'BB 1023']])
  check('missing ISRC on the bundle copy', r('single-album-isrc-missing').map((x) => [x.catalogue, x.missing_on]), [['4885-90', 'album']])
  check('different ISRCs', r('single-album-isrc-differs').map((x) => x.single_catalogue), ['P 157'])
  check('same ISRC is fine, Live is a different version, "unknown" ignored',
    [...r('single-album-isrc-differs'), ...r('single-album-isrc-missing')].some((x) => ['NKO 67', 'LIVE 1', 'UNK 1'].includes(x.single_catalogue)), false)
}

console.log('spelling slip is still a duplicate')
{
  const r = await run([song('BRS 271', 'Die Boemelaar', { isrc: 'USA2P1441524' }), song('BRS 271', 'Die Boomelaar', { isrc: 'USA2P1441524' })], [album('BRS 271')])
  check('duplicate', r('duplicate-songs').length, 2)
  check('not a shared-ISRC error', r('isrc-shared').length, 0)
}

console.log('BRS 275: one ISRC on two different songs')
{
  const r = await run([song('BRS 275', 'Adios, Adios Paloma', { isrc: 'ZAC032310585' }), song('BRS 275', 'Be My Love', { isrc: 'ZAC032310585' })], [album('BRS 275')])
  check('isrc-shared', r('isrc-shared').length, 2)
  check('not a duplicate', r('duplicate-songs').length, 0)
}

console.log('album records')
{
  const r = await run(
    [song('RPM 1006-S RPM 1006-S', 'A'), song('NO ALBUM 1', 'B'), song('TC 1', 'C'), song('TC 1', 'D')],
    [album('RPM 1006-S RPM 1006-S'), album('TC 1', { trackCount: '24' }), album('EMPTY 1'), album('DUP 1', { id: 'x1' }), album('DUP 1', { id: 'x2' }),
     album('NOUPC 1', { upc: '' }), album('JUNK 1', { upc: '#N/A' })])
  check('catalogue-doubled', r('catalogue-doubled').map((x) => x.catalogue), ['RPM 1006-S RPM 1006-S'])
  check('songs-without-album', r('songs-without-album').map((x) => x.catalogue), ['NO ALBUM 1'])
  check('track-count', r('track-count').map((x) => x.catalogue), ['TC 1'])
  check('albums-without-songs includes EMPTY 1', r('albums-without-songs').some((x) => x.catalogue === 'EMPTY 1'), true)
  check('catalogue-twice', r('catalogue-twice').map((x) => x.catalogue), ['DUP 1'])
  check('upc-missing', r('upc-missing').map((x) => x.catalogue), ['NOUPC 1'])
  check('code-junk UPC', r('code-junk').map((x) => x.value), ['#N/A'])
}

console.log('ISRC shape')
{
  const r = await run([song('I 1', 'A', { isrc: 'ZAC032300553' }), song('I 1', 'B', { isrc: 'ZA-C03-2300554' }), song('I 1', 'C', { isrc: 'ZAC0323' }), song('I 1', 'D', { isrc: '#N/A' })], [album('I 1')])
  check('isrc-format', r('isrc-format').map((x) => x.title), ['C'])
  check('code-junk ISRC', r('code-junk').map((x) => x.title), ['D'])
}

console.log('against the Cache: near titles, ISRCs, songs the Cache does not list')
{
  const cache = { 'BRS 214': [
    { track_name: 'What a Wonderful World', isrc: 'ZAC032207665', seq: 4 },
    { track_name: "Rollin' You Over", isrc: 'ZAC030100420', seq: 1 },
    { track_name: 'The Dream of Olwen', isrc: 'ZAC032312577', seq: 12 },
  ] }
  const differ = cacheDiffer((c) => cache[c] || [])
  const fd = (title, isrc) => ({ 'Track Name': title, ISRC: isrc })
  const near = differ('BRS 214', fd('What A wonderful Wold', 'ZAC032207666'))
  check('near title matched', [near.by, near.cacheTitle], ['near title', 'What a Wonderful World'])
  check('near title ISRC differs', near.fields.includes('ISRC'), true)
  check('leading "The" ignored', differ('BRS 214', fd('Dream Of Owen', 'ZAC032312577')).cacheTitle, 'The Dream of Olwen')
  check('song the Cache does not list', differ('BRS 214', fd('Superman', 'ZAC030100420')), { notListed: true })
  check('album not in Cache', differ('NOPE 1', fd('Superman', 'X')), null)

  const r = await run([
    song('BRS 214', 'What A wonderful Wold', { isrc: 'ZAC032207666', cacheDiff: { fields: ['ISRC', 'Genre'], by: 'near title', cacheTitle: 'What a Wonderful World', cacheIsrc: 'ZAC032207665' } }),
    song('BRS 214', 'Superman', { isrc: 'ZAC030100420', cacheDiff: { notListed: true } }),
    song('BRS 214', 'Twice', { cacheDiff: { fields: ['ISRC'], by: 'title', cacheTitle: 'Twice', cacheIsrc: 'X' } }),
    song('BRS 214', 'Twice', { cacheDiff: { fields: ['ISRC'], by: 'title', cacheTitle: 'Twice', cacheIsrc: 'X' } }),
  ], [album('BRS 214')])
  check('isrc-differs-cache', r('isrc-differs-cache').map((x) => [x.title, x.cache_isrc]), [['What A wonderful Wold', 'ZAC032207665']])
  check('not-in-cache-tracklist', r('not-in-cache-tracklist').map((x) => x.title), ['Superman'])
  check('MAM-duplicated title not reported as differing', r('cache-differs').map((x) => x.title), ['What A wonderful Wold'])
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall mam-health checks passed')
process.exit(failures ? 1 : 0)
