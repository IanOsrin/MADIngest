/**
 * research/fingerprint/fetch-corpus.mjs — pull the evaluation corpus.
 *
 * The vault mp3s come from media.musicafricadirect.com (the CDN in front of the
 * audio bucket), not the private S3 origin. Resumable: a file already on disk
 * with a sane size is left alone, so re-running costs nothing.
 *
 * Audio lives on /Volumes/Bandlab/fingerprint-lab, never in the repo.
 */
import { readFileSync, existsSync, statSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const LAB = process.env.FP_LAB || '/Volumes/Bandlab/fingerprint-lab'
const MEDIA = process.env.FP_MEDIA || 'https://media.musicafricadirect.com/mp3'
const corpus = JSON.parse(readFileSync(`${LAB}/corpus.json`, 'utf8'))
const CONCURRENCY = 6

let done = 0, skipped = 0, failed = []
async function fetchOne(row) {
  const dest = `${LAB}/refs/${row.filename}.mp3`
  if (existsSync(dest) && statSync(dest).size > 100_000) { skipped++; return }
  const url = `${MEDIA}/${encodeURIComponent(row.filename)}.mp3`
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) { failed.push({ filename: row.filename, status: res.status }); return }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  done++
}

const queue = [...corpus]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const row = queue.shift()
    try { await fetchOne(row) } catch (e) { failed.push({ filename: row.filename, error: e.message }) }
    if ((done + skipped) % 20 === 0) console.log(`  ${done + skipped}/${corpus.length} (${failed.length} failed)`)
  }
}))
console.log(`downloaded ${done}, already had ${skipped}, failed ${failed.length}`)
if (failed.length) console.log(JSON.stringify(failed.slice(0, 10)))
