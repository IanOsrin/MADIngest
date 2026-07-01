/**
 * scripts/convert-metadata.js
 * Build-time conversion: Gallo_Metadata_Extract.xlsx → normalised JSON.
 *
 * Parsing the 60MB+ xlsx with SheetJS needs ~500MB RSS, so we do it once at
 * Docker build time (build machines have plenty of memory) and ship only the
 * JSON. At runtime lib/metadata-cache.js loads the JSON directly (~150MB RSS),
 * which lets the service run on Render's 512MB starter plan.
 *
 * Usage: node scripts/convert-metadata.js <input.xlsx> <output.json>
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { parseXlsxBuffer } from '../lib/metadata-cache.js'

const [, , src, dest] = process.argv
if (!src || !dest) {
  console.error('Usage: node scripts/convert-metadata.js <input.xlsx> <output.json>')
  process.exit(1)
}

const buffer = await readFile(src)
const rows   = parseXlsxBuffer(buffer)
if (!rows.length) {
  console.error(`No rows parsed from ${src} — aborting`)
  process.exit(1)
}
await mkdir(path.dirname(dest), { recursive: true })
await writeFile(dest, JSON.stringify(rows))
console.log(`Converted ${rows.length} rows: ${src} → ${dest}`)
