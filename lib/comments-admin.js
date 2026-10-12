// lib/comments-admin.js — moderation for MAD's timed comments (2026-10-12).
//
// MAD stores comments in the same Postgres as the catalogue mirror (tables comment_authors,
// track_comments, comment_reports, track_reactions — madmusicv2.1/db/schema.sql). lib/mirror-db.js stays
// strictly read-only; this module has its own small pool and EXACTLY the writes moderation needs:
// hide / show a comment, block / unblock an author (blocking can also hide everything they wrote).
// Nothing is ever deleted from here. MAD's per-song cache refreshes within a minute.
import pg from 'pg'
import { mirrorQuery, isMirrorEnabled } from './mirror-db.js'

const RAW = (process.env.MIRROR_DATABASE_URL || process.env.DATABASE_URL || '').trim()
let pool = null
function write(text, params) {
  if (!pool) {
    pool = new pg.Pool({ connectionString: RAW, ssl: /@(localhost|127\.0\.0\.1)/.test(RAW) ? false : { rejectUnauthorized: false }, max: 2 })
    pool.on('error', (e) => console.warn('[comments-admin] pool:', e.message))
  }
  return pool.query(text, params)
}

export function commentsAdminAvailable() { return isMirrorEnabled() }

/**
 * views: 'look' — hidden by listeners' reports, or reported and still showing (the queue)
 *        'recent' — everything, newest first · 'hidden' — everything hidden · 'blocked' — blocked authors' comments
 */
export async function listComments({ view = 'look', q = '', limit = 200 } = {}) {
  const where = {
    look: `(c.status = 'hidden' AND c.hidden_reason = 'reports') OR (c.status = 'visible' AND c.reports > 0)`,
    recent: `c.status <> 'deleted'`,
    hidden: `c.status = 'hidden'`,
    blocked: `a.banned AND c.status <> 'deleted'`,
  }[view] || `c.status <> 'deleted'`
  const params = []
  let search = ''
  if (q.trim()) { params.push(`%${q.trim().toLowerCase()}%`); search = ` AND (lower(c.body) LIKE $1 OR lower(a.display_name) LIKE $1 OR lower(c.author_email) LIKE $1 OR lower(t.track_title) LIKE $1)` }
  params.push(Math.min(500, Math.max(1, limit)))
  const { rows } = await mirrorQuery(
    `SELECT c.id, c.track_id, c.at_ms, c.body, c.status, c.reports, c.hidden_reason, c.created_at,
            a.display_name, a.email, a.banned, t.track_title, t.track_artist, t.catalogue_no
       FROM track_comments c
       JOIN comment_authors a ON a.email = c.author_email
       LEFT JOIN LATERAL (SELECT track_title, track_artist, catalogue_no FROM tracks WHERE fm_record_id = c.track_id LIMIT 1) t ON true
      WHERE (${where})${search}
      ORDER BY c.created_at DESC LIMIT $${params.length}`, params)
  return rows.map((r) => ({
    id: String(r.id), trackId: r.track_id, atMs: r.at_ms, body: r.body, status: r.status, reports: r.reports,
    hiddenReason: r.hidden_reason, createdAt: r.created_at, name: r.display_name, email: r.email, banned: r.banned,
    track: r.track_title ? `${r.track_title}${r.track_artist ? ' — ' + r.track_artist : ''}` : `record ${r.track_id}`, catalogue: r.catalogue_no || '',
  }))
}

export async function stats() {
  const { rows } = await mirrorQuery(
    `SELECT (SELECT count(*) FROM track_comments WHERE status = 'visible')::int AS showing,
            (SELECT count(*) FROM track_comments WHERE status = 'hidden')::int AS hidden,
            (SELECT count(*) FROM track_comments WHERE created_at > now() - interval '7 days' AND status <> 'deleted')::int AS week,
            (SELECT count(*) FROM track_comments WHERE (status = 'hidden' AND hidden_reason = 'reports') OR (status = 'visible' AND reports > 0))::int AS look,
            (SELECT count(*) FROM comment_authors)::int AS authors,
            (SELECT count(*) FROM comment_authors WHERE banned)::int AS blocked`)
  return rows[0]
}

/** hide: 'hidden' by the team · show: visible again (and its reports cleared, so it leaves the queue) */
export async function setVisible(id, visible) {
  const { rowCount } = visible
    ? await write(`UPDATE track_comments SET status = 'visible', hidden_reason = NULL, reports = 0, updated_at = now() WHERE id = $1 AND status <> 'deleted'`, [id])
    : await write(`UPDATE track_comments SET status = 'hidden', hidden_reason = 'team', updated_at = now() WHERE id = $1 AND status <> 'deleted'`, [id])
  if (visible && rowCount) await write(`DELETE FROM comment_reports WHERE comment_id = $1`, [id])
  return rowCount > 0
}

/** Block (or unblock) an author: they can no longer post. hideAll also hides everything they wrote. */
export async function setBlocked(email, blocked, hideAll = false) {
  const { rowCount } = await write(`UPDATE comment_authors SET banned = $2, updated_at = now() WHERE email = $1`, [email, blocked])
  let hid = 0
  if (blocked && hideAll && rowCount) {
    hid = (await write(`UPDATE track_comments SET status = 'hidden', hidden_reason = 'team', updated_at = now() WHERE author_email = $1 AND status = 'visible'`, [email])).rowCount
  }
  return { ok: rowCount > 0, hid }
}
