/**
 * Synthetic test for the new DDEX builder.
 * Reconstructs a Snake_Uyakitazeka-shaped release from canned FM data and verifies:
 *   1. XML is well-formed (xmllint --noout)
 *   2. The same structural elements as the working reference are present
 *   3. MD5 hashes are populated
 *
 * Run with: node scripts/test-ddex-build.mjs
 */

import { buildDdexPackage } from '../lib/ddex-build.js'
import { writeFile, mkdir, rm } from 'fs/promises'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.TEST_OUT_DIR || path.join(__dirname, '..', 'tmp', 'test-ddex-out')

// ── Synthetic FM data — modelled on Snake_Uyakitazeka ────────────────────────
const tracks = [
  {
    isrc: 'ZAC032403129', asset_number: 'GMVD4226', wav_filename: 'GMVD4226.wav',
    resource_reference: 'AGMVD4226', technical_resource: 'TGMVD4226',
    audio_hash_md5: 'A9845CFFDD2B3D95385B133755E1184E',
    title: 'Uyakitazeka', artist_name: 'Snake', album_artist: 'Snake',
    album_title: 'Uyakitazeka', catalogue_no: 'MCGMP 40521', barcode: '6009555145185',
    sequence_no: 1, year: '1994', release_date: '2025-11-11',
    original_release_date: '1994-08-12', genre: 'Afro Pop', language: 'zu',
    duration_sec: 241, explicit: false, label: 'The Gallo Record Company Vault',
    pline_text: '(P) 1994 The Gallo Record Company Vault',
    cline_text: '(C) 1994 The Gallo Record Company Vault',
    composers: ['Snake'], producers: ['Hamilton Nzimande'],
    publishers: 'Gallo Music Publishers [SAMRO]',
    image_asset_number: 'GMVi6506',
  },
  {
    isrc: 'ZAC032403130', asset_number: 'GMVD4227', wav_filename: 'GMVD4227.wav',
    resource_reference: 'AGMVD4227', technical_resource: 'TGMVD4227',
    audio_hash_md5: '7D3CB7EFC4098A30A0C5AFA459897C88',
    title: 'Van Die One', artist_name: 'Snake', album_artist: 'Snake',
    album_title: 'Uyakitazeka', catalogue_no: 'MCGMP 40521', barcode: '6009555145185',
    sequence_no: 2, year: '1994', release_date: '2025-11-11',
    original_release_date: '1994-08-12', genre: 'Afro Pop', language: 'zu',
    duration_sec: 212, explicit: false, label: 'The Gallo Record Company Vault',
    pline_text: '(P) 1994 The Gallo Record Company Vault',
    cline_text: '(C) 1994 The Gallo Record Company Vault',
    composers: ['Snake'], producers: ['Hamilton Nzimande'],
    publishers: 'Gallo Music Publishers [SAMRO]',
    image_asset_number: 'GMVi6506',
  },
]

// Fake WAV (RIFF/WAVE magic + a few bytes) and JPEG (FF D8 FF + a few bytes)
const fakeWav = (n) => {
  const b = Buffer.alloc(64)
  b.write('RIFF', 0); b.writeUInt32LE(56, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(176400, 28)
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(20, 40)
  b[44] = n // make each fake file unique-ish so MD5s differ
  return b
}
const fakeJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00])

// ── Run build ────────────────────────────────────────────────────────────────
const result = buildDdexPackage({
  tracks,
  audioBufs: [fakeWav(1), fakeWav(2)],
  artworkBuf: fakeJpg,
  artworkExt: 'jpg',
})

// ── Write to disk ────────────────────────────────────────────────────────────
const safePart = (s) => (s || '').trim().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
const folderName = `${safePart(result.album.artist)}_${safePart(result.album.title)}`
await rm(OUT, { recursive: true, force: true })
await mkdir(path.join(OUT, folderName, 'resources'), { recursive: true })
await writeFile(path.join(OUT, folderName, `${folderName}.xml`), result.xml, 'utf8')
for (const f of result.files) {
  await writeFile(path.join(OUT, folderName, f.path), f.buffer)
}

console.log(`\nWrote test output to: ${OUT}/${folderName}/`)
console.log(`Files: ${result.files.length + 1}`)
if (result.validation.warnings.length) {
  console.log('\nValidation warnings:')
  result.validation.warnings.forEach(w => console.log(`  ! ${w}`))
}

// ── Check 1: well-formed XML ─────────────────────────────────────────────────
const xmlPath = path.join(OUT, folderName, `${folderName}.xml`)
const lint = spawnSync('xmllint', ['--noout', xmlPath], { encoding: 'utf8' })
if (lint.status !== 0) {
  console.error('\n✗ xmllint failed:')
  console.error(lint.stderr)
  process.exit(1)
}
console.log('\n✓ xmllint: well-formed XML')

// ── Check 2: structural elements vs reference ───────────────────────────────
const required = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  'MessageSchemaVersionId="ern/382"',
  'xmlns="http://ddex.net/xml/ern/382"',
  '<MessageRecipient>',
  'PADPIDA2011092301N',
  '<UpdateIndicator',
  'OriginalMessage',
  '<SoundRecording>',
  '<ProprietaryId',
  '<ResourceReference>AGMVD4226',
  '<TechnicalResourceDetailsReference>TGMVD4226',
  '<AudioCodecType>PCM',
  '<BitRate>2116',
  '<NumberOfChannels>2',
  '<IsPreview>false',
  '<HashSum>A9845CFFDD2B3D95385B133755E1184E',
  '<HashSumAlgorithmType>MD5',
  '<FileName>GMVD4226.wav',
  '<FilePath>resources/',
  '<Image>',
  '<ImageType>FrontCoverImage',
  '<FileName>GMVi6506.jpg',
  '<Release IsMainRelease="true">',
  '<ICPN>6009555145185',
  '<CatalogNumber',
  'LabelNameType="DisplayLabelName"',
  '<Title TitleType="FormalTitle">',
  '<Title TitleType="DisplayTitle">',
  '<ResourceGroup>',
  '<TitleText>Disc 1',
  '<ReleaseType>TrackRelease',
  '<OriginalReleaseDate>1994-08-12',
  '<CommercialModelType>SubscriptionModel',
  '<CommercialModelType>AdvertisementSupportedModel',
  '<UseType>Stream',
  '<UseType>ConditionalDownload',
  '<TerritoryCode>Worldwide',
  '<EffectiveDate>',
]
const missing = required.filter(s => !result.xml.includes(s))
if (missing.length) {
  console.error('\n✗ Missing required structural elements:')
  missing.forEach(m => console.error(`  - ${m}`))
  process.exit(1)
}
console.log(`✓ All ${required.length} structural checks passed`)

// ── Check 3: encoding is UTF-8, no BOM ──────────────────────────────────────
const buf = Buffer.from(result.xml, 'utf8')
if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
  console.error('✗ Output has UTF-8 BOM — must be removed')
  process.exit(1)
}
console.log('✓ UTF-8, no BOM')

// ── Check 4: prolog on the very first line ──────────────────────────────────
if (!result.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
  console.error('✗ XML prolog is not the first thing in the file')
  process.exit(1)
}
console.log('✓ Prolog is first')

console.log('\n✅ All checks passed.\n')
