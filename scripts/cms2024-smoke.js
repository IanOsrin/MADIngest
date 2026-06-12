/**
 * scripts/cms2024-smoke.js
 * One-shot smoke test for the Gallo CMS 2024 integration.
 *
 *   node scripts/cms2024-smoke.js
 *
 * Verifies:
 *   1. .env wires up CMS2024_FM_* (and credentials inherit from Gallo)
 *   2. Auth against the Data API succeeds (pingCms2024)
 *   3. Layout introspection returns a real field set for CMS2024_FM_LAYOUT
 *
 * Prints non-zero exit code if anything fails so it can be wired into CI.
 */
import 'dotenv/config'
import { pingCms2024, getLayoutFieldMeta, _config } from '../lib/fm-cms2024.js'

const t0 = Date.now()
console.log('[cms2024-smoke] config:', _config)

let ok = true

try {
  const pong = await pingCms2024()
  if (!pong) throw new Error('pingCms2024 returned false')
  console.log(`[cms2024-smoke] ping OK  (${Date.now() - t0}ms)`)
} catch (err) {
  ok = false
  console.error('[cms2024-smoke] ping FAILED:', err.message)
}

if (ok) {
  try {
    const fields = await getLayoutFieldMeta()
    console.log(`[cms2024-smoke] layout "${_config.LAYOUT}" → ${fields.length} fields`)
    // Pass --all (or set VERBOSE=1) to dump every field name; otherwise show a sample.
    const verbose = process.argv.includes('--all') || process.env.VERBOSE === '1'
    if (verbose) {
      const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name))
      for (const f of sorted) {
        console.log(`  ${f.name}  (${f.type}${f.global ? ', global' : ''}${f.not_empty ? ', required' : ''})`)
      }
    } else {
      console.log('  sample:', fields.slice(0, 12).map(f => f.name).join(', '))
      console.log('  (run with --all to dump every field)')
    }
  } catch (err) {
    ok = false
    console.error(`[cms2024-smoke] layout-fields FAILED for "${_config.LAYOUT}":`, err.message)
  }
}

console.log(`[cms2024-smoke] done in ${Date.now() - t0}ms → ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
