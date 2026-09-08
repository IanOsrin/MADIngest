#!/usr/bin/env node
/**
 * scripts/catalogue-health-smoke.mjs — `npm run health:catalogue-smoke`
 *
 * Structural guards for the Data Health tab. Offline: no Postgres, no FM.
 *
 * The failure this mainly exists to catch: counts come from three BATCHED
 * sweeps, while each check also carries its own drill-down SQL. Add a check and
 * forget to add it to a sweep and it silently renders "not computed" forever —
 * no error, no test failure, just a row that never has a number.
 */
import { CHECKS } from '../lib/catalogue-health.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'catalogue-health.js'), 'utf8')
const sweeps = ['ROW_SWEEP', 'ISRC_SWEEP', 'CAT_SWEEP']
  .map((n) => src.slice(src.indexOf(`const ${n}`), src.indexOf('`', src.indexOf(`const ${n}`) + 40) + 1))
  .join('\n')

let failures = 0
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`)
}

console.log('check definitions')
check('at least a dozen checks defined', CHECKS.length >= 12, `got ${CHECKS.length}`)
check('codes are unique', new Set(CHECKS.map(c => c.code)).size === CHECKS.length)
for (const c of CHECKS) {
  const bad = []
  if (!c.code)     bad.push('code')
  if (!c.label)    bad.push('label')
  if (!c.why)      bad.push('why')
  if (!['error', 'warn', 'info'].includes(c.severity)) bad.push('severity')
  if (!c.group)    bad.push('group')
  if (!c.recordsSql) bad.push('recordsSql')
  if (bad.length) { failures++; console.error(`  ✗ ${c.code || '(no code)'} is missing: ${bad.join(', ')}`) }
}
check('every check is fully described', true)

console.log('every check is actually computed by a sweep')
for (const c of CHECKS) {
  check(`${c.code} appears in a batched sweep`, sweeps.includes(`"${c.code}"`),
    'defined but not in ROW_SWEEP / ISRC_SWEEP / CAT_SWEEP — it would render "not computed" with no error')
}

console.log('drill-down SQL is read-only and paginable')
for (const c of CHECKS) {
  const sql = c.recordsSql.trim()
  if (!/^(select|with)\b/i.test(sql)) { failures++; console.error(`  ✗ ${c.code}: recordsSql must start with SELECT/WITH`) }
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql)) { failures++; console.error(`  ✗ ${c.code}: recordsSql contains a write keyword`) }
  if (/\blimit\b/i.test(sql)) { failures++; console.error(`  ✗ ${c.code}: recordsSql must not carry its own LIMIT — the caller appends one`) }
}
check('all drill-downs are read-only, unlimited SELECTs', true)

console.log('degrades safely with no mirror configured')
{
  const { getHealthSummary, getHealthRecords } = await import('../lib/catalogue-health.js')
  const s = await getHealthSummary()
  check('summary reports not-configured instead of throwing', s.ok === false && /not configured/i.test(s.reason || ''), JSON.stringify(s))
  const r = await getHealthRecords('isrc-shared')
  check('records reports not-configured instead of throwing', r.ok === false)
}

console.log('the read-only pool refuses writes')
{
  const { mirrorQuery } = await import('../lib/mirror-db.js')
  let threw = false
  try { await mirrorQuery("UPDATE tracks SET raw = '{}'") } catch (e) { threw = /read-only/i.test(e.message) }
  check('a non-SELECT is rejected before it reaches Postgres', threw)
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall catalogue-health checks passed')
process.exit(failures ? 1 : 0)
