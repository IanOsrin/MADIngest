/**
 * lib/genre-fix-log.js — permanent history of Genre Fix re-tags.
 *
 * The tab's Status column only lives in the operator's browser and vanishes on
 * reload, and the server's console line only survives as long as the log does
 * (Render keeps very little). This keeps every Apply in S3 so the local and
 * hosted instances share one history.
 *
 * ONE OBJECT PER APPLY (metadata/genre-fix-log/<iso>-<rand>.json) rather than a
 * single appended file: two instances (local + Render) writing at once could
 * otherwise read-modify-write over each other and silently drop entries.
 * Entries are immutable, so each is downloaded once and cached in memory.
 */
import { randomBytes } from 'node:crypto'
import { uploadAnyKey, downloadAnyKey, listKeysWithPrefix } from './s3-imports.js'

const PREFIX = 'metadata/genre-fix-log/'
const _cache = new Map()            // key → entry (immutable once written)

/** Store one Apply. Throws on S3 failure — the caller decides how loud to be. */
export async function logGenreFix(entry) {
  const at = new Date().toISOString()
  const key = `${PREFIX}${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`
  const full = { at, ...entry }
  await uploadAnyKey(Buffer.from(JSON.stringify(full)), key, 'application/json')
  _cache.set(key, full)
  return full
}

/** Every logged Apply, newest first. */
export async function listGenreFixLog() {
  const keys = (await listKeysWithPrefix(PREFIX)).filter(k => k.endsWith('.json'))
  const missing = keys.filter(k => !_cache.has(k))
  // Small parallel batches — first load may fetch a few hundred tiny objects.
  for (let i = 0; i < missing.length; i += 16) {
    await Promise.all(missing.slice(i, i + 16).map(async k => {
      try { _cache.set(k, JSON.parse((await downloadAnyKey(k)).buffer.toString('utf8'))) }
      catch (e) { console.error(`[genre-fix-log] unreadable ${k}: ${e.message}`) }
    }))
  }
  return keys.map(k => _cache.get(k)).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))
}
