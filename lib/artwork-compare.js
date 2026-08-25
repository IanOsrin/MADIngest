/**
 * lib/artwork-compare.js
 * Side-by-side artwork across the three databases for one catalogue, with
 * copy ("drag") between them. Each database keeps its own display rules:
 *   Gallo Catalogue — Artwork record container + the S3 render copy
 *                     artwork/<Resource reference>.jpg (what layouts show)
 *   CMS 2024        — Artwork record's Picture container
 *   MadStreamer     — artwork/<GMVi> key in the app bucket (site + derivatives)
 * Copying always writes the TARGET's full display set, never half of it.
 */

import {
  findArtworkByCatalogue as galloArtwork,
  createArtworkRecord as createGalloArtwork,
  uploadArtworkImage as uploadGalloArtworkImage,
  fetchContainerData,
} from './fm-gallo.js'
import {
  createArtworkRecord as createStreamerArtwork,
  findArtworkByCatalogue as findStreamerArtwork,
  findRecordsByCatalogue as findStreamerSongs,
} from './madstreamer.js'
import { findGalloRecordsByCatalogue } from './fm-gallo.js'
import { findRecordsByCatalogue as findCmsSongs } from './fm-cms2024.js'
import { uploadAnyKey, headAnyKey, downloadAnyKey, uploadArtworkByGmvi } from './s3-imports.js'
import { visionOpen } from './vision-drive.js'

const F = s => String(s || '').trim()

// ── CMS client (Artwork layout, incl. container upload) ─────────────────────
const CMS_HOST = (process.env.CMS2024_FM_HOST || 'https://digitalcupboard.app').replace(/\/$/, '')
const CMS_DB = process.env.CMS2024_FM_DB || 'Gallo CMS 2024'
const CMS_ART_LAYOUT = process.env.CMS2024_ARTWORK_LAYOUT || 'Artwork'
const cmsBase = `${CMS_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(CMS_DB)}`
let _cmsToken = null
async function cmsToken(force = false) {
  if (_cmsToken && !force) return _cmsToken
  const r = await fetch(cmsBase + '/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(
        `${process.env.CMS2024_FM_USER || process.env.GALLO_FM_USER}:${process.env.CMS2024_FM_PASS || process.env.GALLO_FM_PASS}`
      ).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  _cmsToken = (await r.json())?.response?.token
  if (!_cmsToken) throw new Error('CMS login failed')
  return _cmsToken
}
async function cmsCall(method, path, body, isRetry = false) {
  const token = await cmsToken(isRetry)
  const res = await fetch(cmsBase + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok && (json?.messages?.[0]?.code === '952' || res.status === 401) && !isRetry) {
    return cmsCall(method, path, body, true)
  }
  return { ok: res.ok, code: json?.messages?.[0]?.code, json }
}
async function cmsArtworkRecord(cat) {
  const { ok, code, json } = await cmsCall('POST', `/layouts/${encodeURIComponent(CMS_ART_LAYOUT)}/_find`, {
    query: [{ 'Catalogue Number': `==${cat}` }], limit: 3,
  })
  if (!ok) { if (code === '401') return null; throw new Error(json?.messages?.[0]?.message || 'CMS find failed') }
  return (json?.response?.data || [])[0] || null
}

// The album's MASTER presence per database — artwork without an album is
// almost always a mistake (Ian, 2026-08-25), so both the state view and the
// copy guard know whether the album actually exists there.
export async function albumExists(db, cat) {
  try {
    if (db === 'gallo') return (await findGalloRecordsByCatalogue(cat)).length
    if (db === 'cms') return (await findCmsSongs(cat)).length
    if (db === 'streamer') return (await findStreamerSongs(cat)).length
  } catch { return -1 }   // -1 = could not check
  return 0
}

// ── per-database state + image ──────────────────────────────────────────────

export async function artworkState(cat) {
  const out = {}
  const [gAlbum, cAlbum, sAlbum] = await Promise.all([
    albumExists('gallo', cat), albumExists('cms', cat), albumExists('streamer', cat),
  ])
  // Gallo
  try {
    const rec = (await galloArtwork(cat))[0] || null
    const ref = rec ? F(rec.fieldData?.['Resource reference'] || rec.fieldData?.['Resource Reference']) : ''
    const container = rec ? F(rec.fieldData?.['Picture']) : ''
    const s3 = ref ? (await headAnyKey(`artwork/${ref}.jpg`)).exists : false
    out.gallo = {
      albumSongs: gAlbum,
      exists: !!rec, ref: ref || null,
      hasImage: s3 || container.startsWith('http') || container.startsWith('image:'),
      displays: s3,
      note: !rec ? 'no record' : s3 ? 'renders from S3' : container.startsWith('http') ? 'container only (no S3 copy)' : container.startsWith('image:') ? 'file reference only' : 'record without picture',
    }
  } catch (e) { out.gallo = { error: e.message } }
  // CMS
  try {
    const rec = await cmsArtworkRecord(cat)
    const pic = rec ? F(rec.fieldData?.['Picture']) : ''
    out.cms = {
      albumSongs: cAlbum,
      exists: !!rec, ref: rec ? F(rec.fieldData?.['Resource reference']) || null : null,
      hasImage: pic.startsWith('http'),
      displays: pic.startsWith('http'),
      note: !rec ? 'no record' : pic.startsWith('http') ? 'picture in container' : 'record without picture',
    }
  } catch (e) { out.cms = { error: e.message } }
  // Streamer
  try {
    const rec = await findStreamerArtwork(cat)
    const gmvi = rec?.gmvi ? F(rec.gmvi) : ''
    let key = null
    if (gmvi) {
      for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        if ((await headAnyKey(`artwork/${gmvi}${ext}`)).exists) { key = `artwork/${gmvi}${ext}`; break }
      }
    }
    out.streamer = {
      albumSongs: sAlbum,
      exists: !!rec, ref: gmvi || null,
      hasImage: !!key, displays: !!key, key,
      note: !rec ? 'no record' : key ? 'file in app bucket' : 'record without file',
    }
  } catch (e) { out.streamer = { error: e.message } }
  return out
}

export async function artworkImage(db, cat) {
  if (db === 'gallo') {
    const rec = (await galloArtwork(cat))[0]
    if (!rec) return null
    const ref = F(rec.fieldData?.['Resource reference'] || rec.fieldData?.['Resource Reference'])
    if (ref && (await headAnyKey(`artwork/${ref}.jpg`)).exists) {
      const { buffer } = await downloadAnyKey(`artwork/${ref}.jpg`)
      return { buffer, contentType: 'image/jpeg' }
    }
    const container = F(rec.fieldData?.['Picture'])
    if (container.startsWith('http')) {
      const buffer = await fetchContainerData(container)
      return { buffer, contentType: 'image/jpeg' }
    }
    if (container.startsWith('image:/')) {
      const obj = await visionOpen(container.replace(/^image:/, ''))
      const buffer = Buffer.from(await (obj.Body.transformToByteArray ? obj.Body.transformToByteArray() : new Response(obj.Body).arrayBuffer()))
      return { buffer, contentType: 'image/jpeg' }
    }
    return null
  }
  if (db === 'cms') {
    const rec = await cmsArtworkRecord(cat)
    const url = rec ? F(rec.fieldData?.['Picture']) : ''
    if (!url.startsWith('http')) return null
    const token = await cmsToken()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length > 2000 ? { buffer, contentType: res.headers.get('content-type') || 'image/jpeg' } : null
  }
  if (db === 'streamer') {
    const rec = await findStreamerArtwork(cat)
    const gmvi = rec?.gmvi ? F(rec.gmvi) : ''
    if (!gmvi) return null
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      if ((await headAnyKey(`artwork/${gmvi}${ext}`)).exists) {
        const { buffer } = await downloadAnyKey(`artwork/${gmvi}${ext}`)
        return { buffer, contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' }
      }
    }
    return null
  }
  throw new Error(`unknown db "${db}"`)
}

// ── copy between databases ──────────────────────────────────────────────────

export async function copyArtwork(from, to, cat, opts = {}) {
  if (from === to) throw new Error('source and target are the same database')
  const targetAlbum = await albumExists(to, cat)
  if (targetAlbum === 0 && !opts.force) {
    const err = new Error(`The album ${cat} does not exist in ${to} — artwork would be orphaned. Pass force to copy anyway.`)
    err.code = 'NO_ALBUM'
    throw err
  }
  const img = await artworkImage(from, cat)
  if (!img) throw new Error(`no artwork image available in ${from} for ${cat}`)
  const { buffer } = img
  const filename = `${cat.replace(/[\/\\:*?"<>|]/g, '-')}.jpg`

  if (to === 'gallo') {
    let rec = (await galloArtwork(cat))[0] || null
    if (!rec) {
      await createGalloArtwork({ catalogue_no: cat, image: buffer, filename, contentType: 'image/jpeg' })
      rec = (await galloArtwork(cat))[0]
    } else {
      await uploadGalloArtworkImage(rec.recordId, buffer, filename, 'image/jpeg')
      rec = (await galloArtwork(cat))[0]
    }
    const ref = F(rec?.fieldData?.['Resource reference'] || rec?.fieldData?.['Resource Reference'])
    if (!ref) throw new Error('Gallo artwork record has no Resource reference')
    await uploadAnyKey(buffer, `artwork/${ref}.jpg`, 'image/jpeg')
    return { ok: true, to, ref, wrote: ['container', `artwork/${ref}.jpg`] }
  }

  if (to === 'cms') {
    let rec = await cmsArtworkRecord(cat)
    if (!rec) {
      const { ok, json } = await cmsCall('POST', `/layouts/${encodeURIComponent(CMS_ART_LAYOUT)}/records`, {
        fieldData: { 'Catalogue Number': cat },
      })
      if (!ok) throw new Error(json?.messages?.[0]?.message || 'CMS record create failed')
      rec = await cmsArtworkRecord(cat)
      if (!rec) throw new Error('CMS artwork record not found after create')
    }
    const token = await cmsToken()
    const form = new FormData()
    form.append('upload', new Blob([buffer], { type: 'image/jpeg' }), filename)
    const res = await fetch(`${cmsBase}/layouts/${encodeURIComponent(CMS_ART_LAYOUT)}/records/${rec.recordId}/containers/${encodeURIComponent('Picture')}/1`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(120000),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json?.messages?.[0]?.message || `CMS container upload HTTP ${res.status}`)
    return { ok: true, to, recordId: rec.recordId, wrote: ['Picture container'] }
  }

  if (to === 'streamer') {
    let rec = await findStreamerArtwork(cat)
    if (!rec) rec = await createStreamerArtwork(cat)
    const gmvi = F(rec?.gmvi)
    if (!gmvi) throw new Error('Streamer artwork record has no GMVi')
    const up = await uploadArtworkByGmvi(buffer, gmvi, '.jpg', 'image/jpeg')
    return { ok: true, to, ref: gmvi, wrote: [up.key] }
  }

  throw new Error(`unknown target db "${to}"`)
}
