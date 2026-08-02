#!/usr/bin/env node
/**
 * scripts/gallo-local-genre-cleanup.mjs
 * Normalise the Gallo Catalogue's `Local Genre` field to the agreed taxonomy.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *
 *   node scripts/gallo-local-genre-cleanup.mjs              # report only
 *   node scripts/gallo-local-genre-cleanup.mjs --apply
 *   node scripts/gallo-local-genre-cleanup.mjs --rollback <file>
 *
 * ONLY `Local Genre` IS TOUCHED. NEVER `Genre`.
 * `Genre` carries the DDEX/Ingrooves controlled vocabulary — their exact
 * spelling ("afro-folk") is a delivery requirement. Normalising it would break
 * Ingrooves deliveries. `Local Genre` is the MadStreamer-facing value and the
 * only one we own. If you find yourself editing this script to also write
 * `Genre`, stop.
 *
 * THROTTLING
 * Gallo FileMaker is shared with the live GalloIngest app and the MadStreamer
 * sync. Writes go one at a time with a pause. Run it off-peak.
 *
 * ROLLBACK
 * Writes data/gallo-localgenre-rollback-<stamp>.json (recordId -> previous
 * value) before each change, flushed as it goes, so a run that dies halfway
 * still leaves a complete record of what changed.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeGenre, isCanonicalGenre } from '../lib/genre-taxonomy.js'

const LAYOUT = process.env.GALLO_FM_LAYOUT || 'API_Album_Songs'
const FIELD  = 'Local Genre'
const PAGE   = 500
const PAUSE  = Number.parseInt(process.env.GALLO_GENRE_PAUSE_MS || '', 10) || 120

const args     = process.argv.slice(2)
const APPLY    = args.includes('--apply')
const ROLLBACK = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null })()
const sleep    = (ms) => new Promise(r => setTimeout(r, ms))
const stamp    = new Date().toISOString().replace(/[:.]/g, '-')

// fm-gallo.js keeps galloFetch private, so we re-implement the two calls we
// need against the same env. Read-only in dry run; single-record PATCH on apply.
const { GALLO_FM_HOST, GALLO_FM_DB, GALLO_FM_USER, GALLO_FM_PASS } = process.env
const base = `${GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(GALLO_FM_DB)}`
let _token = null

async function token() {
  if (_token) return _token
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${GALLO_FM_USER}:${GALLO_FM_PASS}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`login failed: ${j?.messages?.[0]?.message || res.status}`)
  _token = j.response.token
  return _token
}

async function fm(pathname, options = {}) {
  const t = await token()
  return fetch(`${base}${pathname}`, {
    ...options,
    headers: { Accept: 'application/json', Authorization: `Bearer ${t}`, ...(options.headers || {}) }
  })
}

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK)

  console.log(`\nLayout: ${LAYOUT}   Field: ${FIELD}   (Genre is NOT touched)`)
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***\n' : 'DRY RUN — nothing will be written\n')

  const rollbackPath = path.join('data', `gallo-localgenre-rollback-${stamp}.json`)
  const rollback = []
  const tally = new Map()
  let scanned = 0, toChange = 0, written = 0, failed = 0, skipped = 0, blank = 0

  let offset = 1, total = null
  while (true) {
    const res = await fm(`/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=${PAGE}&_offset=${offset}`)
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`page at ${offset} failed: ${j?.messages?.[0]?.message || res.status}`)
    if (total === null) {
      total = Number(j?.response?.dataInfo?.totalRecordCount || 0)
      console.log(`scanning ${total} records…\n`)
    }
    const data = j?.response?.data || []
    if (!data.length) break

    for (const r of data) {
      scanned++
      const current = String(r.fieldData?.[FIELD] ?? '').trim()
      if (!current) { blank++; continue }              // blanks are a separate job
      if (isCanonicalGenre(current)) continue          // already right
      const target = normalizeGenre(current)
      if (!target) { skipped++; continue }             // unmappable — leave alone
      if (target === current) continue

      toChange++
      tally.set(`${current} -> ${target}`, (tally.get(`${current} -> ${target}`) || 0) + 1)

      if (APPLY) {
        rollback.push({ recordId: r.recordId, field: FIELD, from: current, to: target })
        fs.mkdirSync('data', { recursive: true })
        fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2))
        try {
          const up = await fm(`/layouts/${encodeURIComponent(LAYOUT)}/records/${r.recordId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fieldData: { [FIELD]: target } })
          })
          if (!up.ok) {
            const uj = await up.json().catch(() => ({}))
            throw new Error(uj?.messages?.[0]?.message || `HTTP ${up.status}`)
          }
          written++
          if (written % 250 === 0) console.log(`   … ${written} written`)
        } catch (err) {
          failed++
          console.error(`   FAILED #${r.recordId}: ${err.message}`)
        }
        await sleep(PAUSE)
      }
    }

    offset += data.length
    if (total && scanned >= total) break
    if (!APPLY) await sleep(40)
  }

  console.log(`\n${'-'.repeat(64)}`)
  console.log('Changes by mapping:')
  ;[...tally.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`))
  console.log(`\nscanned ${scanned} | to change ${toChange} | blank ${blank} (untouched) | unmappable ${skipped} (untouched)`)
  if (APPLY) {
    console.log(`written ${written} | failed ${failed}`)
    console.log(`rollback: ${rollbackPath}`)
    console.log(`\nTo undo:  node scripts/gallo-local-genre-cleanup.mjs --rollback ${rollbackPath}`)
  } else {
    console.log(`\nNothing written. Re-run with --apply.`)
    console.log(`At ${PAUSE}ms/record an apply run takes roughly ${Math.ceil((toChange * PAUSE) / 60000)} minute(s).`)
  }
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`\nRolling back ${entries.length} record(s) from ${file}`)
  let ok = 0, bad = 0
  for (const e of entries) {
    try {
      const res = await fm(`/layouts/${encodeURIComponent(LAYOUT)}/records/${e.recordId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldData: { [e.field]: e.from } })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      ok++
    } catch (err) { bad++; console.error(`  FAILED #${e.recordId}: ${err.message}`) }
    await sleep(PAUSE)
  }
  console.log(`Restored ${ok}, failed ${bad}`)
}

main().catch((err) => { console.error('\nFATAL:', err.message); process.exitCode = 1 })
