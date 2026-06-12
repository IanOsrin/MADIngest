#!/usr/bin/env node
/**
 * scripts/fix-fm-paths.js
 *
 * Scans every record in the FileMaker layout and ensures that any record
 * with a moviemac: path includes ALL known machine base paths.
 * Records that already have all bases, or that use an S3 URL, are skipped.
 *
 * Usage:
 *   node scripts/fix-fm-paths.js            # live run
 *   node scripts/fix-fm-paths.js --dry-run  # preview only, no writes
 */

import 'dotenv/config'

const {
  GALLO_FM_HOST,
  GALLO_FM_DB,
  GALLO_FM_USER,
  GALLO_FM_PASS,
  GALLO_FM_LAYOUT,
  FM_SERVER_ASSET_PATH,
  FM_SERVER_ASSET_PATH_2,
  FM_SERVER_ASSET_PATH_3
} = process.env

const DRY_RUN    = process.argv.includes('--dry-run')
const SINGLE_ID  = (process.argv.find(a => a.startsWith('--record=')) || '').replace('--record=', '').trim() || null
const BATCH_SIZE = 100

const BASES = [FM_SERVER_ASSET_PATH, FM_SERVER_ASSET_PATH_2, FM_SERVER_ASSET_PATH_3]
  .map(p => (p || '').trim())
  .filter(Boolean)

const fmBase = `${GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(GALLO_FM_DB)}`

// ── FileMaker auth ─────────────────────────────────────────────────────────

let _token = null

async function getToken() {
  if (_token) return _token
  const res  = await fetch(`${fmBase}/sessions`, {
    method:  'POST',
    headers: {
      Authorization:  'Basic ' + Buffer.from(`${GALLO_FM_USER}:${GALLO_FM_PASS}`).toString('base64'),
      'Content-Type': 'application/json',
      Accept:         'application/json'
    },
    body: JSON.stringify({})
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`FM login failed: ${json?.messages?.[0]?.message || res.status}`)
  _token = json.response.token
  return _token
}

async function fmFetch(path, options = {}) {
  const token = await getToken()
  return fetch(`${fmBase}${path}`, {
    ...options,
    headers: {
      Accept:        'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  })
}

// ── Path helpers ───────────────────────────────────────────────────────────

// Strip any known base prefix to get the relative path (artist/album/file.wav)
function extractRelPath(moviemacLine) {
  const full = moviemacLine.replace(/^moviemac:/, '')
  for (const base of BASES) {
    if (full.startsWith(base + '/')) return full.slice(base.length + 1)
  }
  return null
}

// True if the File URL already contains every base
function isComplete(fileUrl) {
  return BASES.every(base => fileUrl.includes(`moviemac:${base}/`))
}

// Rebuild File URL with all bases using the relative path found in the existing entry
function rebuildFileUrl(fileUrl) {
  const lines        = fileUrl.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean)
  const movieLine    = lines.find(l => /^movie:[^/]/.test(l))       // bare filename line
  const moviemacLines = lines.filter(l => l.startsWith('moviemac:'))

  let relPath = null
  for (const line of moviemacLines) {
    relPath = extractRelPath(line)
    if (relPath) break
  }

  if (!relPath) return null

  // Use bare filename from movie: line if present, otherwise take the last segment of the rel path
  const filename = movieLine
    ? movieLine.replace(/^movie:/, '')
    : relPath.split('/').pop()

  const allPaths = BASES.map(base => `moviemac:${base}/${relPath}`).join('\n')
  return `movie:${filename}\n${allPaths}`
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!BASES.length) {
    console.error('ERROR: No FM_SERVER_ASSET_PATH* values found in .env')
    process.exit(1)
  }

  console.log(`Base paths (${BASES.length}):`)
  BASES.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  if (DRY_RUN) console.log('\n⚠️  DRY RUN — no changes will be written\n')
  else         console.log()

  // ── Single-record mode ───────────────────────────────────────────────────
  if (SINGLE_ID) {
    let record

    if (/^\d+$/.test(SINGLE_ID)) {
      // Numeric — use direct record ID endpoint
      const res  = await fmFetch(`/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${SINGLE_ID}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`FM fetch failed: ${json?.messages?.[0]?.message || res.status}`)
      record = json?.response?.data?.[0]
    } else {
      // Non-numeric — find by catalogue number
      const res  = await fmFetch(
        `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/_find`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ query: [{ 'recid': SINGLE_ID }], limit: 1 })
        }
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`FM find failed: ${json?.messages?.[0]?.message || res.status}`)
      record = json?.response?.data?.[0]
      if (!record) throw new Error(`No record found for catalogue number "${SINGLE_ID}"`)
    }

    const internalId = String(record?.recordId || SINGLE_ID)
    const fileUrl    = (record?.fieldData?.['Audio File'] || '').trim()
    const label      = record?.fieldData?.['Track Name'] || record?.fieldData?.['Album Title'] || `record ${SINGLE_ID}`

    console.log(`Record: ${label}`)
    console.log(`Current File URL:\n${fileUrl}\n`)

    if (!fileUrl || !fileUrl.includes('moviemac:')) {
      console.log('No moviemac: path found — nothing to do.')
      return
    }
    if (isComplete(fileUrl)) {
      console.log('Already has all base paths — nothing to do.')
      return
    }

    const newUrl = rebuildFileUrl(fileUrl)
    if (!newUrl) { console.error('Could not extract relative path.'); return }

    console.log(`New File URL:\n${newUrl}\n`)

    if (!DRY_RUN) {
      const patchRes = await fmFetch(
        `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${internalId}`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ fieldData: { 'Audio File': newUrl } })
        }
      )
      const pj = await patchRes.json().catch(() => ({}))
      if (!patchRes.ok) console.error(`✗ Failed: ${pj?.messages?.[0]?.message || patchRes.status}`)
      else              console.log('✓ Updated successfully.')
    } else {
      console.log('(dry run — not written)')
    }
    return
  }

  let offset  = 1
  let total   = null
  let checked = 0, updated = 0, skipped = 0, errors = 0

  while (true) {
    const res  = await fmFetch(
      `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records?_limit=${BATCH_SIZE}&_offset=${offset}`
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`FM fetch failed: ${json?.messages?.[0]?.message || res.status}`)

    if (total === null) {
      total = Number(json?.response?.dataInfo?.totalRecordCount || 0)
      console.log(`Total records in layout: ${total}\n`)
    }

    const records = json?.response?.data || []
    if (!records.length) break

    for (const record of records) {
      checked++
      const recordId = String(record.recordId)
      const fileUrl  = (record.fieldData?.['Audio File'] || '').trim()
      const label    = record.fieldData?.['Track Name'] || record.fieldData?.['Album Title'] || `record ${recordId}`

      // Skip empty, S3 URLs, or records with no moviemac: paths
      if (!fileUrl || !fileUrl.includes('moviemac:')) { skipped++; continue }

      // Skip if all bases already present
      if (isComplete(fileUrl)) { skipped++; continue }

      const newUrl = rebuildFileUrl(fileUrl)
      if (!newUrl) {
        console.warn(`  ⚠️  ${label} — could not extract relative path, skipping`)
        errors++
        continue
      }

      console.log(`  → ${label}`)

      if (!DRY_RUN) {
        const patchRes = await fmFetch(
          `/layouts/${encodeURIComponent(GALLO_FM_LAYOUT)}/records/${recordId}`,
          {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fieldData: { 'Audio File': newUrl } })
          }
        )
        if (!patchRes.ok) {
          const pj = await patchRes.json().catch(() => ({}))
          console.error(`     ✗ Failed: ${pj?.messages?.[0]?.message || patchRes.status}`)
          errors++
        } else {
          updated++
        }
      } else {
        updated++
      }
    }

    offset += records.length
    if (total !== null && offset > total) break
  }

  console.log(`\n──────────────────────────────────────`)
  console.log(`Checked: ${checked}  |  Updated: ${updated}  |  Skipped: ${skipped}  |  Errors: ${errors}`)
  if (DRY_RUN) console.log('(dry run — nothing written)')
}

main().catch(err => { console.error('\nFATAL:', err.message); process.exit(1) })
