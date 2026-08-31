/**
 * Does the computed destination reproduce folders that already exist on Vision?
 * Takes real Rendered Files paths, derives artist/album/cat from them, and
 * checks the rule rebuilds the same folder. Anything it cannot rebuild is a
 * case the rule does not cover — worth seeing before it is used to write.
 */
import fs from 'node:fs'
import { visionFolderForAlbum, letterGroup } from '../lib/vision-destination.js'

const idx = JSON.parse(fs.readFileSync('tmp/vision-index.json', 'utf8'))
const paths = []
;(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk)
  if (o && typeof o === 'object') {
    if (typeof o.path === 'string') paths.push(o.path)
    return Object.values(o).forEach(walk)
  }
})(idx)

const ROOT = '/gallo-digital-cupboard/Rendered Files/'
const GROUPS = new Set(['A-D', 'E-H', 'I-K', 'L', 'M', 'N-P', 'Q-R', 'S', 'T', 'U-Z'])

// folders shaped <group>/<Artist>/<Artist>_<Album>_<CAT>/file
const folders = new Map()
for (const p of paths) {
  if (!p.startsWith(ROOT)) continue
  const parts = p.slice(ROOT.length).split('/')
  if (parts.length !== 4) continue
  const [g, artist, album] = parts
  if (!GROUPS.has(g)) continue
  folders.set(`${ROOT}${g}/${artist}/${album}`, { g, artist, album })
}
console.log(`album folders at the standard shape: ${folders.size.toLocaleString()}`)

let ok = 0, wrongGroup = 0, wrongName = 0
const examples = []
for (const [folder, { g, artist, album }] of folders) {
  // the folder name is Artist_Album_CAT — split it back
  const rest = album.startsWith(artist + '_') ? album.slice(artist.length + 1) : null
  if (rest === null) { wrongName++; if (examples.length < 4) examples.push(['name not Artist_…', folder]); continue }
  const bits = rest.split('_')
  const catalogue = bits.length > 1 ? bits[bits.length - 1] : ''
  const title = bits.length > 1 ? bits.slice(0, -1).join('_') : bits[0]
  let built
  try { built = visionFolderForAlbum({ artist, title, catalogue }).folder }
  catch { wrongName++; continue }
  if (built === folder) ok++
  else if (letterGroup(artist) !== g) { wrongGroup++; if (examples.length < 8) examples.push(['group differs', `${folder}\n        rule says: ${built}`]) }
  else { wrongName++; if (examples.length < 8) examples.push(['rebuilt differently', `${folder}\n        rule says: ${built}`]) }
}
console.log(`  rebuilt exactly      : ${ok.toLocaleString()}`)
console.log(`  different group      : ${wrongGroup.toLocaleString()}  (the known exceptions)`)
console.log(`  name did not round-trip: ${wrongName.toLocaleString()}`)
console.log('\nexamples:')
for (const [why, e] of examples) console.log(`   ${why}: ${e}`)

console.log('\nletter group spot-check:')
for (const a of ['ABBA', 'Chris Blignaut', 'Henry Ate', 'Lucky Dube', 'Mahlathini', 'Noma Jakes',
                 'Quentin', 'Stimela', 'The Meteors', 'Umoja', 'Zanusi', "004's"]) {
  console.log(`   ${a.padEnd(18)} -> ${letterGroup(a)}`)
}
