#!/usr/bin/env node
/**
 * ddex-import.mjs
 * Reads a DDEX ERN 3.8.x / 4.1 XML delivery, previews all tracks, then
 * (optionally) pushes records to the Gallo Catalogue FileMaker database
 * via the FileMaker Data API.
 *
 * Usage:
 *   node ddex-import.mjs <path/to/delivery-folder>  [--import]
 *
 *   --import   Actually create records in FileMaker (default is preview-only)
 *
 * FileMaker credentials are read from environment variables or a .env file:
 *   FM_HOST        e.g. your-server.com
 *   FM_DATABASE    e.g. Gallo Catalogue
 *   FM_LAYOUT      Layout name for the track/resource records
 *   FM_USER        FileMaker Data API username
 *   FM_PASS        FileMaker Data API password
 */

import 'dotenv/config'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { parseStringPromise } from 'xml2js'
import { parseDDEXErn41 } from './lib/ddex-ern41.js'

// ── Config ────────────────────────────────────────────────────────────────────

const DELIVERY_FOLDER = process.argv[2] || process.env.DDEX_FOLDER
const DRY_RUN         = !process.argv.includes('--import')

const FM_HOST     = process.env.FM_HOST
const FM_DATABASE = process.env.FM_DATABASE
const FM_LAYOUT   = process.env.FM_LAYOUT   || 'Resources'
const FM_USER     = process.env.FM_USER
const FM_PASS     = process.env.FM_PASS

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!DELIVERY_FOLDER) {
    console.error('Usage: node ddex-import.mjs <path/to/delivery-folder> [--import]')
    process.exit(1)
  }

  // 1. Find the XML file in the delivery folder
  const xmlFile = readdirSync(DELIVERY_FOLDER).find(f => f.toLowerCase().endsWith('.xml'))
  if (!xmlFile) {
    console.error(`No XML file found in: ${DELIVERY_FOLDER}`)
    process.exit(1)
  }
  const xmlPath = path.join(DELIVERY_FOLDER, xmlFile)
  console.log(`\nParsing: ${xmlFile}`)

  // 2. Parse XML
  const xml    = readFileSync(xmlPath, 'utf8')
  const parsed = await parseStringPromise(xml, {
    explicitArray:   false,
    explicitCharkey: true,
    mergeAttrs:      false,
  })

  // xml2js wraps the root element; unwrap whatever top-level key exists
  const root = parsed[Object.keys(parsed)[0]]

  // 3. Build a fileMap so the parser can find audio/artwork buffers if needed
  //    (keyed by lowercase filename → Buffer)
  const resourcesDir = path.join(DELIVERY_FOLDER, 'resources')
  let fileMap = {}
  try {
    readdirSync(resourcesDir).forEach(fname => {
      fileMap[fname.toLowerCase()] = readFileSync(path.join(resourcesDir, fname))
    })
    console.log(`Found ${Object.keys(fileMap).length} resource files`)
  } catch {
    console.warn('No resources/ subfolder found — audio/artwork buffers will be null')
  }

  // 4. Parse DDEX
  const tracks = parseDDEXErn41(root, fileMap)
  console.log(`\nExtracted ${tracks.length} track(s) from DDEX XML:\n`)

  // 5. Preview table
  const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w)
  console.log(
    col('#',  3) + col('ISRC',          14) + col('Title',           28) +
    col('Artist',          22) + col('Genre',      12) + col('Duration', 9) + 'Credits'
  )
  console.log('─'.repeat(110))
  tracks.forEach((t, i) => {
    const dur = t.duration_sec
      ? `${Math.floor(t.duration_sec / 60)}:${String(Math.round(t.duration_sec % 60)).padStart(2, '0')}`
      : '—'
    const creditSummary = t.credits.map(c => `${c.name} (${c.role})`).join('; ').slice(0, 60)
    console.log(
      col(i + 1,          3) + col(t.isrc,         14) + col(t.track_title, 28) +
      col(t.artist_name,  22) + col(t.genre,       12) + col(dur,          9) + creditSummary
    )
  })

  console.log('\nAlbum:  ', tracks[0]?.album_title  ?? '(no album)')
  console.log('Label:  ', tracks[0]?.label_name   ?? '(none)')
  console.log('Rights: ', tracks[0]?.rights_holder ?? '(none)', tracks[0]?.rights_year ?? '')
  console.log('Year:   ', tracks[0]?.year           ?? '—')

  if (DRY_RUN) {
    console.log('\n✓ Preview complete. Run with --import to push to FileMaker.')
    return
  }

  // 6. Push to FileMaker Data API
  if (!FM_HOST || !FM_DATABASE || !FM_USER || !FM_PASS) {
    console.error('\n✗ FileMaker credentials missing. Set FM_HOST, FM_DATABASE, FM_USER, FM_PASS in your .env file.')
    process.exit(1)
  }

  console.log(`\nConnecting to FileMaker: ${FM_HOST} / ${FM_DATABASE} / layout: ${FM_LAYOUT}`)
  const token = await fmLogin()
  console.log('Authenticated ✓\n')

  let created = 0
  for (const track of tracks) {
    const fieldData = buildFieldData(track)
    const recordId  = await fmCreateRecord(token, fieldData)
    console.log(`  Created record ${recordId}: ${track.track_title} — ${track.isrc}`)
    created++
  }

  await fmLogout(token)
  console.log(`\n✓ Done. Created ${created} record(s) in FileMaker.`)
}

// ── FileMaker Data API helpers ────────────────────────────────────────────────

function fmBaseUrl() {
  return `https://${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DATABASE)}`
}

async function fmLogin() {
  const res = await fetch(`${fmBaseUrl()}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64'),
    },
    body: JSON.stringify({}),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`FM login failed: ${JSON.stringify(data.messages)}`)
  return data.response.token
}

async function fmLogout(token) {
  await fetch(`${fmBaseUrl()}/sessions/${token}`, {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
}

async function fmCreateRecord(token, fieldData) {
  const res = await fetch(`${fmBaseUrl()}/layouts/${encodeURIComponent(FM_LAYOUT)}/records`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ fieldData }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`FM create record failed: ${JSON.stringify(data.messages)}`)
  return data.response.recordId
}

/**
 * Map a parsed DDEX track object to FileMaker field names.
 * ── EDIT THIS FUNCTION to match your actual Gallo Catalogue field names ──
 */
function buildFieldData(track) {
  return {
    'Title':          track.track_title   ?? '',
    'ISRC':           track.isrc          ?? '',
    'Artist':         track.artist_name   ?? '',
    'Album':          track.album_title   ?? '',
    'Label':          track.label_name    ?? '',
    'Genre':          track.genre         ?? '',
    'Year':           track.year          ?? '',
    'Duration':       track.duration_sec  ?? '',
    'Language':       track.language      ?? '',
    'Explicit':       track.explicit ? 'Yes' : 'No',
    'RightsHolder':   track.rights_holder ?? '',
    'RightsYear':     track.rights_year   ?? '',
    'Territories':    track.territories   ?? '',
    'Credits':        track.credits.map(c => `${c.name} (${c.role})`).join('\n'),
    'SubmittedBy':    track.submitter_name ?? 'DDEX Import',
    // Add more field mappings as needed
  }
}

main().catch(err => { console.error('\n✗', err.message); process.exit(1) })
