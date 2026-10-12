// routes/comments-admin.js — the Comments tab: moderate MAD's timed comments (2026-10-12).
//
//   GET  /api/comments-admin?view=look|recent|hidden|blocked&q=   → { ok, stats, comments: [...] }
//   POST /api/comments-admin/:id/hide | /:id/show                  → { ok }
//   POST /api/comments-admin/author/block   { email, hideAll }      → { ok, hid }
//   POST /api/comments-admin/author/unblock { email }               → { ok }
// The writes are in lib/comments-admin.js (comment tables only; nothing is deleted).
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { commentsAdminAvailable, listComments, stats, setVisible, setBlocked } from '../lib/comments-admin.js'

const router = Router()
const fail = (res, status, error) => res.status(status).json({ ok: false, error })
const ID = /^\d{1,15}$/

router.use(adminAuth, (_req, res, next) => (commentsAdminAvailable() ? next() : fail(res, 503, 'The MAD database isn’t configured here (MIRROR_DATABASE_URL).')))

router.get('/', async (req, res) => {
  try {
    const [s, comments] = await Promise.all([stats(), listComments({ view: String(req.query.view || 'look'), q: String(req.query.q || '').slice(0, 100) })])
    res.json({ ok: true, stats: s, comments })
  } catch (err) {
    const missing = /relation .*track_comments.* does not exist/i.test(err.message)
    fail(res, missing ? 503 : 502, missing ? 'The comment tables don’t exist yet in MAD’s database.' : err.message)
  }
})

for (const [path, visible] of [['hide', false], ['show', true]]) {
  router.post(`/:id/${path}`, async (req, res) => {
    if (!ID.test(req.params.id)) return fail(res, 400, 'Bad comment id')
    try { res.json({ ok: await setVisible(req.params.id, visible) }) } catch (err) { fail(res, 502, err.message) }
  })
}

router.post('/author/:act(block|unblock)', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email.includes('@')) return fail(res, 400, 'Bad author')
  try { res.json(await setBlocked(email, req.params.act === 'block', !!req.body?.hideAll)) } catch (err) { fail(res, 502, err.message) }
})

export default router
