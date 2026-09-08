/**
 * lib/mirror-db.js — read-only pool for the MadStreamer Postgres mirror.
 *
 * The mirror is the MAD website's nightly one-way copy of MadStreamer. It is
 * what makes catalogue-wide data checks possible at all: scanning FileMaker for
 * 67k records is slow and dangerous — repeated heavy reads froze logins across
 * all three FM databases on 2026-08-18 — while the same questions cost a couple
 * of seconds here and cannot touch FileMaker.
 *
 * READ ONLY. Nothing in GalloIngest writes to the mirror; FileMaker is the
 * record keeper and the website's sync job is the only writer.
 *
 * DISABLED-SAFE: with MIRROR_DATABASE_URL (or DATABASE_URL) unset, isMirrorEnabled()
 * is false and every caller degrades to "not configured". GalloIngest must keep
 * working exactly as before without it.
 */
import pg from 'pg'

const RAW = (process.env.MIRROR_DATABASE_URL || process.env.DATABASE_URL || '').trim()
const IS_PG = /^postgres(ql)?:\/\//i.test(RAW)

let pool = null

export function isMirrorEnabled() { return IS_PG }

function getPool() {
  if (!IS_PG) throw new Error('Postgres mirror is not configured (set MIRROR_DATABASE_URL)')
  if (!pool) {
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(RAW)
    pool = new pg.Pool({
      connectionString: RAW,
      // Render's managed Postgres serves a chain Node won't verify by default.
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: Number(process.env.MIRROR_POOL_MAX) || 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (e) => console.error('[mirror] idle client error:', e?.message || e))
    console.log('[mirror] pool created')
  }
  return pool
}

/** Run a read query. Rejects anything that is not a SELECT/WITH — this pool never writes. */
export function mirrorQuery(text, params) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error('mirror-db is read-only')
  return getPool().query(text, params)
}

/** When the mirror was last refreshed from FileMaker — every answer is as of this. */
export async function mirrorFreshness() {
  const r = await mirrorQuery(
    `SELECT last_synced_at, last_status, rows_total FROM sync_state ORDER BY last_synced_at DESC LIMIT 1`)
  return r.rows[0] || null
}

export async function closeMirrorPool() {
  if (!pool) return
  try { await pool.end() } finally { pool = null }
}
