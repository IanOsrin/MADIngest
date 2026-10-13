/**
 * scripts/fetch-metadata-json.mjs — copy the metadata cache's S3 store (metadata/Gallo_Metadata_Extract.json) to a
 * local file, showing bytes as they arrive and giving up if nothing arrives for 60 s. Read-only on S3.
 * Then a script can read it with METADATA_S3=off METADATA_FILE=<file>.
 *
 *   node scripts/fetch-metadata-json.mjs [tmp/metadata-extract.json]
 */
import 'dotenv/config'
import fs from 'node:fs'
import { headAnyKey } from '../lib/s3-imports.js'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const OUT = process.argv[2] || 'tmp/metadata-extract.json'
const KEY = process.env.METADATA_S3_KEY || 'metadata/Gallo_Metadata_Extract.json'
const head = await headAnyKey(KEY)
console.log(`${KEY}: ${head ? (head.ContentLength ?? head.size ?? '?') : 'not found'} bytes, modified ${head?.LastModified?.toISOString?.() || '?'}`)

// same client + bucket as lib/s3-imports.js
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-north-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID || '', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '' } })
const ctl = new AbortController()
const res = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_IMPORTS_BUCKET || 'mass-music-audio-files', Key: KEY }), { abortSignal: ctl.signal })
let got = 0, last = Date.now(), lastShown = 0
const idle = setInterval(() => { if (Date.now() - last > 60000) { console.log(`no data for 60 s at ${got} bytes — giving up`); ctl.abort(); process.exit(1) } }, 5000)
const tmp = OUT + '.part', f = fs.createWriteStream(tmp)
for await (const chunk of res.Body) {
  got += chunk.length; last = Date.now(); f.write(chunk)
  if (got - lastShown > 10e6) { lastShown = got; console.log(`  ${(got / 1e6).toFixed(0)} MB`) }
}
await new Promise((r) => f.end(r)); clearInterval(idle)
JSON.parse(fs.readFileSync(tmp, 'utf8'))          // whole and valid before it replaces anything
fs.renameSync(tmp, OUT)
console.log(`saved ${(got / 1e6).toFixed(1)} MB → ${OUT}`)
process.exit(0)
