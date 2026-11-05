#!/usr/bin/env node
/**
 * scripts/vision-index-save-smoke.mjs — `npm run vision-index:smoke`
 *
 * Guards the Vision index's S3 upload. Offline: the upload is a stand-in.
 *
 * The bug this exists to stop coming back: all 45 MB went to S3 after every
 * 15-minute pass whether or not anything had changed, which used up Render's
 * monthly bandwidth in 4.5 days (2026-11-05).
 */
import zlib from 'zlib'
import { saveVisionIndexToS3 } from '../lib/gallo-vision-link.js'

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log(`  ✓ ${name}`); return }
  failures++
  console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`)
}

const HOUR = 60 * 60 * 1000
const file = name => ({ path: `/b/f/${name}`, size: 1, name })
const index = (names, stamp) => ({
  buckets: ['b'], builtAtEpoch: stamp, builtFiles: names.length, builtOthers: 0,
  files: names.map(file), others: [],
  folders: { 'b/f': { files: names.map(file), others: [], indexedAtEpoch: stamp, count: names.length } },
})

const sent = []
const upload = async (body, key, type) => { sent.push({ body, key, type }) }
const save = (idx, now) => saveVisionIndexToS3(idx, { upload, now }).then(r => r.uploaded)

const t = 1_000_000_000_000
check('first save uploads', await save(index(['a.wav'], t), t), true)
check('same files, new timestamps: no upload', await save(index(['a.wav'], t + HOUR), t + HOUR), false)
check('a new file uploads', await save(index(['a.wav', 'b.wav'], t + HOUR), t + HOUR), true)
check('a removed file uploads', await save(index(['b.wav'], t + HOUR), t + HOUR), true)
check('unchanged at 5 hours: no upload', await save(index(['b.wav'], t), t + 6 * HOUR), false)
check('unchanged at 6 hours: upload, keeps the stamps', await save(index(['b.wav'], t), t + 7 * HOUR), true)

const last = sent.at(-1)
check('goes to the gzipped key', last.key, 'metadata/vision-audio-index.json.gz')
const stored = JSON.parse(zlib.gunzipSync(last.body).toString('utf8'))
check('stored file reads back', stored.folders['b/f'].files.map(f => f.name), ['b.wav'])
check('flattened lists are not stored', [stored.files, stored.others], [undefined, undefined])

const failing = async () => { throw new Error('S3 down') }
const threw = await saveVisionIndexToS3(index(['c.wav'], t), { upload: failing, now: t + 7 * HOUR }).then(() => false, () => true)
check('a failed upload is reported', threw, true)
check('a failed upload is retried on the next pass', await save(index(['c.wav'], t), t + 7 * HOUR), true)

console.log(failures ? `\n${failures} failure(s)` : '\nAll passed')
process.exit(failures ? 1 : 0)
