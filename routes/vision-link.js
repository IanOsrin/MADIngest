// routes/vision-link.js — album search and MAM audio linking.
//
// Split out of vision-upload.js so it is NOT behind VISION_UPLOAD_ENABLED.
// That flag exists because uploading reads this Mac's filesystem, which Render
// does not have. These two routes touch no local filesystem at all — they read
// Vision and write Music Arena Master — so they work hosted, and linking the
// backlog need not be done from one particular Mac.
//
// Mounted at the same /api/vision-upload base, so the admin page calls the same
// URLs whether or not uploading is enabled.
import { Router } from 'express'
import express from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { visionFolderForAlbum } from '../lib/vision-destination.js'
import { linkAlbumAudio } from '../lib/link-album-audio.js'

const router = Router()

/**
 * Search Music Arena Master and return, for each album, the folder its files
 * belong in. Picking an album is the safest way to fill an upload destination:
 * a typed path one level too high scatters the album loose into the parent,
 * because the planner maps the picked folder's CONTENTS onto it.
 */
router.get('/album-search', adminAuth, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.status(400).json({ error: 'Type at least two characters' })
  const base = `${process.env.GALLO_FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent('Music Arena Master')}`
  const auth = 'Basic ' + Buffer.from(`${process.env.GALLO_FM_USER}:${process.env.GALLO_FM_PASS}`).toString('base64')
  let token
  try {
    const s = await (await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: '{}' })).json()
    token = s?.response?.token
    if (!token) throw new Error('Could not reach Music Arena Master')
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    const j = await (await fetch(base + '/layouts/Albums/_find', { method: 'POST', headers: H,
      body: JSON.stringify({
        query: [{ 'Album Artist': `*${q}*` }, { 'Album Title': `*${q}*` },
                { 'Album Catalogue Number': `*${q}*` }, { 'Reference Catalogue Number': `*${q}*` }],
        limit: 25,
      }) })).json()
    const albums = (j?.response?.data || []).map(r => {
      const f = r.fieldData
      const catalogue = f['Album Catalogue Number'] || f['Reference Catalogue Number']
      let folder = null, why = null
      try { folder = visionFolderForAlbum({ artist: f['Album Artist'], title: f['Album Title'], catalogue }).folder }
      catch (e) { why = e.message }
      return { albumID: f.AlbumID, artist: f['Album Artist'], title: f['Album Title'],
               catalogue, tracks: f['Track Count'], folder, why }
    })
    res.json({ ok: true, count: albums.length, albums })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  } finally {
    if (token) await fetch(base + '/sessions/' + token, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {})
  }
})

/**
 * Link an album that is already on Vision — the backlog case, and the repair
 * path when an upload linked nothing. Defaults to a dry run: pass apply:true to
 * write. Only empty Audio_Vision_URL fields are ever filled.
 */
router.post('/link-album', adminAuth, express.json(), async (req, res) => {
  try {
    const albumID = String(req.body?.albumID || '').trim()
    if (!albumID) return res.status(400).json({ error: 'albumID is required' })
    const link = await linkAlbumAudio(albumID, { apply: req.body?.apply === true })
    res.json({ ok: true, link })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

export default router
