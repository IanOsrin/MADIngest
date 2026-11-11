#!/usr/bin/env node
/**
 * scripts/vision-index-lock-smoke.mjs
 *
 * Guards "index a folder while a refresh pass is running". Offline: Vision and
 * S3 are stand-ins, so nothing is listed or written anywhere.
 *
 *   node --experimental-test-module-mocks scripts/vision-index-lock-smoke.mjs
 *
 * The case it exists for: the pass is part-way through a long listing of a big
 * folder when an album lands inside it. Indexing that album must work at once,
 * and the pass must not wipe it out when its own (older) listing comes back.
 */
import { mock } from 'node:test'

// ── A pretend Vision drive ───────────────────────────────────────────────────
const drive = {
  'Big/Old/a.wav': 1,
  'Small/s.wav': 1,
}
let holdBig = null          // while set, a whole-folder listing of Big/ waits on it
let failBig = false

const keysUnder = prefix => Object.keys(drive).filter(k => k.startsWith(prefix))
  .map(key => ({ path: `/b/${key}`, key, size: drive[key] }))

mock.module(new URL('../lib/vision-drive.js', import.meta.url).href, {
  namedExports: {
    visionList: async rel => rel === '/'
      ? { entries: [{ type: 'dir', name: 'b' }] }
      : { entries: [...new Set(Object.keys(drive).map(k => k.split('/')[0]))].map(name => ({ type: 'dir', name })) },
    visionAllKeys: async (_bucket, { prefix }) => {
      if (prefix === 'Big/') {
        if (failBig) throw new Error('Expected closing tag')
        const seen = keysUnder(prefix)   // what the listing saw BEFORE it stalled
        if (holdBig) await holdBig
        return seen
      }
      return keysUnder(prefix)
    },
  },
})
mock.module(new URL('../lib/s3-imports.js', import.meta.url).href, {
  namedExports: {
    uploadAnyKey: async () => {},
    downloadAnyKey: async () => { throw new Error('none') },
    headAnyKey: async () => ({ exists: false }),
  },
})

const { refreshVisionIndex, reindexVisionPath, loadVisionIndex, indexBuilding } =
  await import('../lib/gallo-vision-link.js')

let failed = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`)
}
const names = async () => (await loadVisionIndex({})).files.map(f => f.name).sort()
const opts = { persist: false, budgetMs: Infinity }

await refreshVisionIndex(opts)
check('first pass indexes both folders', await names(), ['a.wav', 's.wav'])

// A pass starts and stalls inside Big/, having already read its listing.
let release
holdBig = new Promise(r => { release = r })
const pass = refreshVisionIndex(opts)
await new Promise(r => setTimeout(r, 20))
check('a pass is running', indexBuilding(), true)

// An album lands in Big/ and in Small/ while it is stalled.
drive['Big/New/x.wav'] = 1
drive['Small/New/y.wav'] = 1
const r1 = await reindexVisionPath('/b/Big/New', { persist: false })
const r2 = await reindexVisionPath('/b/Small/New', { persist: false })
check('indexing a folder is not refused during a pass', [r1.ok, r1.audio, r2.ok, r2.audio], [true, 1, true, 1])
check('both are searchable at once', await names(), ['a.wav', 's.wav', 'x.wav', 'y.wav'])
check('the pass still reports itself as running', indexBuilding(), true)

release(); holdBig = null
await pass
check('the pass does not wipe them out when it finishes', await names(), ['a.wav', 's.wav', 'x.wav', 'y.wav'])
check('no file is listed twice', (await names()).length, new Set(await names()).size)

// A later pass that lists Big/ afresh is the truth again: a removed album goes.
delete drive['Big/New/x.wav']
await refreshVisionIndex(opts)
check('a later pass drops a file that has gone', await names(), ['a.wav', 's.wav', 'y.wav'])

// A listing that fails keeps what was there, including a splice made meanwhile.
failBig = true
drive['Big/Newer/z.wav'] = 1
const failing = refreshVisionIndex(opts)
await reindexVisionPath('/b/Big/Newer', { persist: false })
await failing
failBig = false
check('a failed listing keeps the old files and the new album', await names(), ['a.wav', 's.wav', 'y.wav', 'z.wav'])
check('nothing is left marked as running', indexBuilding(), false)

console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
