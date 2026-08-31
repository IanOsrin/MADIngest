/**
 * Read-only: list a Vision folder and its immediate parent, so loose files can
 * be seen next to correctly-placed ones before anything is decided.
 *
 *   node scripts/list-vision-folder.mjs "/gallo-digital-cupboard/Rendered Files/T/The Meteors"
 */
import 'dotenv/config'
import { visionListKeys } from '../lib/vision-drive.js'

const target = process.argv[2] || '/gallo-digital-cupboard/Rendered Files/T/The Meteors'
console.log(`listing: ${target}\n`)

const keys = await visionListKeys(target)
if (!keys.length) { console.log('  (nothing there)'); process.exit(0) }

// group by the folder each key sits in, relative to the target
const byDir = new Map()
for (const [k, size] of keys) {
  const rel = k.startsWith(target) ? k.slice(target.length).replace(/^\//, '') : k
  const parts = rel.split('/')
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(loose in this folder)'
  if (!byDir.has(dir)) byDir.set(dir, [])
  byDir.get(dir).push({ name: parts[parts.length - 1], size })
}
const mb = n => (n / 1048576).toFixed(1) + 'MB'
for (const [dir, files] of [...byDir.entries()].sort()) {
  const total = files.reduce((s, f) => s + (f.size || 0), 0)
  console.log(`${dir}   — ${files.length} file(s), ${mb(total)}`)
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)) {
    console.log(`    ${f.name}   ${mb(f.size || 0)}`)
  }
  if (files.length > 30) console.log(`    … ${files.length - 30} more`)
  console.log()
}
