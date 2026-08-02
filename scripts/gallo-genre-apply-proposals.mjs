#!/usr/bin/env node
/**
 * scripts/gallo-genre-apply-proposals.mjs
 * Apply the proposals produced by gallo-genre-propose.mjs to `Local Genre`.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply.
 *
 *   node scripts/gallo-genre-apply-proposals.mjs
 *   node scripts/gallo-genre-apply-proposals.mjs --apply
 *   node scripts/gallo-genre-apply-proposals.mjs --apply --tier album-unanimous
 *   node scripts/gallo-genre-apply-proposals.mjs --rollback <file>
 *
 * SAFETY: re-checks that each record is STILL blank before writing.
 * The proposals were computed at a point in time. If someone has since tagged
 * an album by hand (e.g. in the new Gallo Genre tab), that human decision must
 * win over a stale inference — so anything no longer blank is skipped, not
 * overwritten.
 *
 * `Local Genre` only. `Genre` (Ingrooves) is never touched.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { galloFindEmptyLocalGenre, updateGalloRecord } from '../lib/fm-gallo.js'
import { normalizeGenre } from '../lib/genre-taxonomy.js'

const FIELD = 'Local Genre'
const IN    = process.env.GENRE_PROPOSAL_IN || '/Users/ianosrin/Downloads/gallo-genre-proposals.json'
const PAUSE = Number.parseInt(process.env.GALLO_GENRE_PAUSE_MS || '', 10) || 120

const args     = process.argv.slice(2)
const APPLY    = args.includes('--apply')
const TIER     = (() => { const i = args.indexOf('--tier'); return i !== -1 ? args[i + 1] : null })()
const ROLLBACK = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null })()
const sleep    = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK)

  const all = JSON.parse(fs.readFileSync(IN, 'utf8'))
  const proposals = TIER ? all.filter(p => p.tier === TIER) : all
  if (!proposals.length) { console.error(`No proposals${TIER ? ` for tier "${TIER}"` : ''}`); process.exit(1) }

  console.log(`\nproposals file : ${IN}`)
  console.log(`proposals      : ${proposals.length}${TIER ? ` (tier ${TIER})` : ''}`)
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***\n' : 'DRY RUN — nothing will be written\n')

  // One find gives us every record that is still blank — far cheaper than
  // re-reading 3,329 records individually.
  console.log('checking which records are still untagged…')
  const stillBlank = new Set((await galloFindEmptyLocalGenre()).map(r => String(r.recordId)))
  console.log(`  ${stillBlank.size} records currently have an empty ${FIELD}\n`)

  const todo = [], skipped = [], invalid = []
  for (const p of proposals) {
    const target = normalizeGenre(p.propose)
    if (!target) { invalid.push(p); continue }
    if (!stillBlank.has(String(p.recordId))) { skipped.push(p); continue }
    todo.push({ ...p, target })
  }

  const byTier = new Map()
  for (const p of todo) byTier.set(p.tier, (byTier.get(p.tier) || 0) + 1)
  console.log('to write, by confidence tier:')
  for (const [t, n] of [...byTier.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${t}`)
  if (skipped.length) console.log(`\nskipped (already tagged since proposals were made): ${skipped.length}`)
  if (invalid.length) console.log(`skipped (proposed value not in taxonomy): ${invalid.length}`)

  if (!APPLY) {
    console.log(`\nNothing written. Re-run with --apply.`)
    console.log(`At ${PAUSE}ms/record this takes roughly ${Math.ceil((todo.length * PAUSE) / 60000)} minute(s).`)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rollbackPath = path.join('data', `gallo-proposals-rollback-${stamp}.json`)
  const journal = []
  let written = 0, failed = 0

  for (const p of todo) {
    // from is '' by definition — these were blank. Recorded anyway so rollback
    // is a plain restore rather than a delete-if-equal special case.
    journal.push({ recordId: String(p.recordId), field: FIELD, from: '', to: p.target, tier: p.tier })
    fs.mkdirSync('data', { recursive: true })
    fs.writeFileSync(rollbackPath, JSON.stringify(journal, null, 2))
    try {
      await updateGalloRecord(String(p.recordId), { [FIELD]: p.target })
      written++
      if (written % 250 === 0) console.log(`   … ${written}/${todo.length}`)
    } catch (e) {
      failed++
      console.error(`   FAILED #${p.recordId}: ${e.message}`)
    }
    await sleep(PAUSE)
  }

  console.log(`\nwritten ${written} | failed ${failed}`)
  console.log(`rollback: ${rollbackPath}`)
  console.log(`\nTo undo:  node scripts/gallo-genre-apply-proposals.mjs --rollback ${rollbackPath}`)
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`\nRolling back ${entries.length} record(s) from ${file}`)
  let ok = 0, bad = 0
  for (const e of entries) {
    try { await updateGalloRecord(String(e.recordId), { [e.field]: e.from }); ok++ }
    catch (err) { bad++; console.error(`  FAILED #${e.recordId}: ${err.message}`) }
    await sleep(PAUSE)
  }
  console.log(`Restored ${ok}, failed ${bad}`)
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exitCode = 1 })
