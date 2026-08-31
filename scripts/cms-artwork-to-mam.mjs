/**
 * scripts/cms-artwork-to-mam.mjs
 *
 * 801 albums sit in Music Arena Master with no cover while CMS 2024 holds one.
 * This pulls them across: CMS artwork record → S3 (with the _300/_800
 * derivatives the app serves) → Artwork_S3_URL on the MAM album.
 *
 * It avoids making a new copy wherever it can, in this order:
 *   1. CMS already has an Artwork_S3_URL and the object is really there → reuse
 *   2. CMS's Resource reference names a key already in the bucket → reuse that
 *   3. otherwise upload the Picture container under a fresh GMVin code
 * so the bucket does not fill with duplicates of covers it already holds.
 *
 * Runs in batches, resumable from its log — a re-run skips anything already
 * done, so stopping and starting costs nothing.
 *
 *   node scripts/cms-artwork-to-mam.mjs            # next 100
 *   node scripts/cms-artwork-to-mam.mjs --limit 25 --dry-run
 */
import 'dotenv/config'
import fs from 'node:fs'
import { findArtworkByCatalogue as findCmsArtwork } from '../lib/fm-cms2024.js'
import { fetchContainerData } from '../lib/fm-gallo.js'
import { headAnyKey, uploadAnyKey, urlForKey, writeArtworkDerivatives,
         artworkKeyForGmvi, listKeysWithPrefix } from '../lib/s3-imports.js'
import { toJpeg } from '../lib/publish-album.js'

const SC   = '/private/tmp/claude-501/-Users-ianosrin-Downloads/0597787b-013a-4af1-be4b-854e6b947a83/scratchpad/'
const GAP  = SC + 'cms-artwork-gap.json'
const LOG  = SC + 'cms-artwork-to-mam-log.jsonl'
const args = process.argv.slice(2)
const LIMIT = Number((args[args.indexOf('--limit') + 1]) || 0) || 100
const DRY   = args.includes('--dry-run')

const done = new Set()
if (fs.existsSync(LOG)) {
  for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { const e = JSON.parse(l); if (e.status !== 'failed') done.add(e.cat) } catch {}
  }
}
const log = fs.createWriteStream(LOG, { flags: 'a' })

// ── Music Arena Master ─────────────────────────────────────────────────────
const MB = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
let mamToken = null
async function mamAuth() {
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  const j = await (await fetch(MB + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
  mamToken = j?.response?.token
  if (!mamToken) throw new Error('Music Arena Master auth failed')
}
const MH = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + mamToken })
async function mam(path, opts = {}, retry = true) {
  if (!mamToken) await mamAuth()
  const r = await fetch(MB + path, { ...opts, headers: MH() })
  if (r.status === 401 && retry) { mamToken = null; return mam(path, opts, false) }
  return r
}

/** Next free GMVin, read from the bucket — the bucket is the counter. */
let gmvinMax = null
async function nextGmvin() {
  if (gmvinMax === null) {
    gmvinMax = 99999
    for (const k of await listKeysWithPrefix('artwork/GMVin')) {
      const m = k.match(/artwork\/GMVin(\d+)\./)
      if (m) gmvinMax = Math.max(gmvinMax, Number(m[1]))
    }
  }
  return 'GMVin' + (++gmvinMax)
}

const gap = JSON.parse(fs.readFileSync(GAP, 'utf8'))
  .filter(g => g.why === 'album in MAM but no artwork')
const todo = gap.filter(g => !done.has(g.cat)).slice(0, LIMIT)
console.log(`[cms-art] gap ${gap.length}, already done ${done.size}, this run ${todo.length}${DRY ? '  (DRY RUN)' : ''}`)

let reusedS3 = 0, reusedRef = 0, uploaded = 0, failed = 0, noArt = 0, noAlbum = 0
const t0 = Date.now()

for (const [i, g] of todo.entries()) {
  const cat = g.cat || g.single
  const tag = `[${i + 1}/${todo.length}] ${cat}`
  try {
    // the MAM album, and only if it still has no artwork (someone may have
    // filled it since the gap was measured)
    const fj = await (await mam('/layouts/Albums/_find', { method: 'POST',
      body: JSON.stringify({ query: [{ 'Album Catalogue Number': '==' + cat }, { 'Reference Catalogue Number': '==' + cat }], limit: 1 }) })).json()
    const rec = fj?.response?.data?.[0]
    if (!rec) { noAlbum++; log.write(JSON.stringify({ cat, status: 'no-mam-album' }) + '\n'); console.log(`${tag} no MAM album`); continue }
    if (String(rec.fieldData['Artwork_S3_URL'] || '').trim()) {
      log.write(JSON.stringify({ cat, status: 'already-has-artwork' }) + '\n'); console.log(`${tag} already has artwork now — skipped`); continue
    }

    const art = await findCmsArtwork(cat)
    if (!art) { noArt++; log.write(JSON.stringify({ cat, status: 'no-cms-artwork' }) + '\n'); console.log(`${tag} no CMS artwork record`); continue }

    let url = null, how = null
    // 1. an S3 URL CMS already knows, if the object is genuinely there
    if (art.s3_url) {
      const key = art.s3_url.split('.com/')[1]
      if (key && (await headAnyKey(key)).exists) { url = art.s3_url; how = 'reused CMS S3 url'; reusedS3++ }
    }
    // 2. the resource reference as a key already in the bucket
    if (!url && art.resource_reference) {
      const k = artworkKeyForGmvi(String(art.resource_reference).trim(), '.jpg')
      if ((await headAnyKey(k)).exists) { url = urlForKey(k); how = `reused ${art.resource_reference}`; reusedRef++ }
    }
    // 3. upload the container
    if (!url) {
      if (!art.container) { noArt++; log.write(JSON.stringify({ cat, status: 'no-container' }) + '\n'); console.log(`${tag} artwork record has no Picture`); continue }
      if (DRY) { console.log(`${tag} would upload from CMS container`); continue }
      const buf = await fetchContainerData(art.container)
      const { jpeg, width, height } = await toJpeg(buf, `CMS artwork for ${cat}`)
      const code = await nextGmvin()
      const key = artworkKeyForGmvi(code, '.jpg')
      await uploadAnyKey(jpeg, key, 'image/jpeg')
      await writeArtworkDerivatives(key, jpeg)
      url = urlForKey(key); how = `uploaded ${code} (${width}×${height})`; uploaded++
    }

    if (DRY) { console.log(`${tag} would set ${how}`); continue }
    await mam(`/layouts/Albums/records/${rec.recordId}`, { method: 'PATCH', body: JSON.stringify({ fieldData: { 'Artwork_S3_URL': url } }) })
    log.write(JSON.stringify({ cat, albumID: rec.fieldData.AlbumID, url, how, status: 'ok' }) + '\n')
    console.log(`${tag} ${how}`)
  } catch (e) {
    failed++
    log.write(JSON.stringify({ cat, status: 'failed', error: e.message }) + '\n')
    console.log(`${tag} FAILED: ${e.message.slice(0, 110)}`)
  }
}

console.log(`\n[cms-art] uploaded ${uploaded}, reused CMS url ${reusedS3}, reused reference ${reusedRef}, no artwork ${noArt}, no album ${noAlbum}, failed ${failed}  in ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`[cms-art] ${gap.length - done.size - todo.length + failed} still to do after this batch`)
log.end()
