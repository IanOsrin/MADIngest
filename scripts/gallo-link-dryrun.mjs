#!/usr/bin/env node
/**
 * DRY RUN — for a catalogue, show how its CMS 2024 tracks would map to audio
 * files on Vision (what audio_Url would be written to each Gallo record).
 * Writes NOTHING. Builds/caches a flat Vision index on first run.
 *
 *   node scripts/gallo-link-dryrun.mjs "CYL 1054" [--refresh-index]
 */
import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import { findRecordsByCatalogue as cmsFind } from '../lib/fm-cms2024.js'
import { buildVisionIndex, loadVisionIndex, filesForCatalogue, matchTracksToFiles } from '../lib/gallo-vision-link.js'

const catalogue = process.argv[2]
if (!catalogue) { console.error('usage: gallo-link-dryrun.mjs "<catalogue>" [--refresh-index]'); process.exit(1) }
const refresh = process.argv.includes('--refresh-index')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cacheFile = path.join(__dirname, '..', 'tmp', 'vision-index.json')
const mb = (n) => n == null ? '' : (n / 1e6).toFixed(1) + ' MB'

console.log(`\n── DRY RUN: link "${catalogue}" ──  (no writes)\n`)

// 1. Tracks from CMS 2024 (the metadata that pull-catalogue-to-gallo would create)
const tracks = await cmsFind(catalogue)
console.log(`CMS 2024: ${tracks.length} track(s)`)
if (!tracks.length) { console.log('Nothing to do — no CMS 2024 records for this catalogue.'); process.exit(0) }

// 2. Vision index → files for this catalogue (load cache/S3, or build if asked)
process.stdout.write('Vision index… ')
let index = refresh ? null : await loadVisionIndex({ cacheFile })
if (!index) index = await buildVisionIndex({ cacheFile, onProgress: (b, n) => process.stdout.write(`\rVision index… ${b}: ${n}   `) })
console.log(`\rVision index: ${index.builtFiles} audio files across ${index.buckets.join(', ')}        `)
const files = filesForCatalogue(index, catalogue)
console.log(`Files whose path contains "${catalogue}": ${files.length}`)
if (files.length) console.log(`Folder(s): ${[...new Set(files.map(f => f.path.replace(/\/[^/]+$/, '')))].join('\n           ')}`)

// 3. Match
const { matched, tracksNoAudio, filesNoTrack } = matchTracksToFiles(tracks, files)

console.log(`\n── Proposed audio links (${matched.length}/${tracks.length}) ──`)
for (const m of matched) {
  console.log(`  ✓ seq ${String(m.track.sequence_no ?? '?').padStart(2)} "${m.track.title}"`)
  console.log(`      → ${m.audio_Url}   (${mb(m.file.size)})`)
}
if (tracksNoAudio.length) {
  console.log(`\n── Tracks with NO audio on Vision (record created, no audio_Url) ──`)
  for (const t of tracksNoAudio) console.log(`  ·  seq ${String(t.sequence_no ?? '?').padStart(2)} "${t.title}"`)
}
if (filesNoTrack.length) {
  console.log(`\n── Vision files that matched NO track (review — naming mismatch?) ──`)
  for (const f of filesNoTrack) console.log(`  ?  ${f.name}`)
}

console.log(`\n── Summary ──`)
console.log(`  CMS tracks:        ${tracks.length}`)
console.log(`  Would create:      ${tracks.length} Gallo record(s) + album master  (via pull-catalogue-to-gallo)`)
console.log(`  Would set audio_Url on: ${matched.length}`)
console.log(`  Left without audio:     ${tracksNoAudio.length}   (link later when digitised)`)
console.log(`  Unmatched Vision files: ${filesNoTrack.length}`)
console.log(`\n(dry run — nothing written)\n`)
process.exit(0)
