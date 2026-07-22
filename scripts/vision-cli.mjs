#!/usr/bin/env node
/**
 * scripts/vision-cli.mjs — the Vision drive from the terminal.
 * Reuses lib/vision-drive.js, so it reads the same VISION_* vars from .env.
 *
 *   npm run vision status                      connection + config check
 *   npm run vision ls [path]                   list a folder (buckets at /)
 *   npm run vision find <term> [path]          recursive filename search
 *   npm run vision get <path> [dest]           download one file
 *   npm run vision get -r <folder> [destDir]   download a whole folder tree
 *
 * (direct form: node scripts/vision-cli.mjs <cmd> …)
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { visionStatus, visionList, visionDownloadTo } from '../lib/vision-drive.js'

const args = process.argv.slice(2)
const cmd = args.shift() || 'help'

const fmtSize = (n) => n == null ? '' :
  n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' :
  n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' :
  n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B'

const die = (msg) => { console.error(`✖ ${msg}`); process.exit(1) }

async function walk(dir, onFile, depth = 0) {
  if (depth > 12) return // sanity rail against pathological nesting
  const { path: cur, entries } = await visionList(dir)
  for (const e of entries) {
    const p = (cur === '/' ? '' : cur) + '/' + e.name
    if (e.type === 'dir') await walk(p, onFile, depth + 1)
    else await onFile(p, e)
  }
}

async function download(remote, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  const out = fs.createWriteStream(dest)
  await visionDownloadTo(remote, out)
  await new Promise((res) => out.close(res))
  return fs.statSync(dest).size
}

try {
  if (cmd === 'status') {
    const st = visionStatus()
    console.log(`protocol: ${st.protocol}   endpoint: ${st.host || '(unset)'}   base: ${st.base}`)
    if (!st.configured) die('not configured — set the VISION_* vars in .env')
    const { entries } = await visionList('/')
    console.log(`✔ connected — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} at /`)

  } else if (cmd === 'ls') {
    const { path: cur, entries } = await visionList(args[0] || '/')
    console.log(`${cur} — ${entries.length} item${entries.length === 1 ? '' : 's'}`)
    for (const e of entries) {
      console.log(`  ${e.type === 'dir' ? 'd' : '-'}  ${fmtSize(e.size).padStart(9)}  ${e.modified ? e.modified.slice(0, 16).replace('T', ' ') : ''.padEnd(16)}  ${e.name}`)
    }

  } else if (cmd === 'find') {
    const term = (args[0] || '').toLowerCase()
    if (!term) die('usage: vision find <term> [path]')
    const root = args[1] || '/'
    let hits = 0
    await walk(root, async (p, e) => {
      if (p.toLowerCase().includes(term)) { hits++; console.log(`  ${fmtSize(e.size).padStart(9)}  ${p}`) }
    })
    console.log(hits ? `${hits} match${hits === 1 ? '' : 'es'}` : 'no matches')

  } else if (cmd === 'get') {
    const recursive = args[0] === '-r' && args.shift()
    const remote = args[0]
    if (!remote) die('usage: vision get [-r] <path> [dest]')

    if (recursive) {
      const destRoot = args[1] || path.basename(remote) || 'vision-download'
      let n = 0, bytes = 0
      await walk(remote, async (p, e) => {
        const rel = p.slice(remote.length).replace(/^\//, '')
        const dest = path.join(destRoot, rel)
        process.stdout.write(`  ${p} → ${dest} …`)
        const size = await download(p, dest)
        n++; bytes += size
        console.log(` ✔ ${fmtSize(size)}`)
      })
      console.log(`✔ ${n} file${n === 1 ? '' : 's'}, ${fmtSize(bytes)} → ${destRoot}/`)
    } else {
      const dest = args[1] || path.basename(remote)
      const size = await download(remote, dest)
      console.log(`✔ ${remote} → ${dest} (${fmtSize(size)})`)
    }

  } else {
    console.log(`vision — browse & download the Vision drive
  status                     connection + config check
  ls [path]                  list a folder (buckets at /)
  find <term> [path]         recursive filename search
  get <path> [dest]          download one file
  get -r <folder> [destDir]  download a whole folder tree`)
  }
} catch (e) {
  die(e.message)
}
