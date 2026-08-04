// routes/cca-import.js — CCA DDEX deliveries → Gallo Catalogue.
//
// Follows Add Album's shape (find → preview → create) but takes its metadata
// from the delivery's own ERN rather than the metadata cache. For CCA releases
// the ERN IS the source of truth: it carries ISRC, hash sum, resource
// references and P/C lines that the Ingrooves extract does not cover at all
// (the CCA_ prefix is absent from that export entirely).
//
// Read-only endpoints here. Creation is separate and deliberate.

import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { listBatches, listReleases, loadRelease } from '../lib/cca-ddex.js'
import { findGalloRecordsByCatalogue, createGalloRecord, createTapeFileRecord, reloadGalloLayoutFields } from '../lib/fm-gallo.js'

const router = Router()

router.get('/batches', adminAuth, async (_req, res) => {
  try { res.json({ ok: true, batches: await listBatches() }) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

router.get('/releases', adminAuth, async (req, res) => {
  const batch = String(req.query.batch || '').trim()
  if (!batch) return res.status(400).json({ error: 'batch path required' })
  try { res.json({ ok: true, releases: await listReleases(batch) }) }
  catch (e) { res.status(502).json({ error: e.message }) }
})

/**
 * Plan one release: parse its ERN, pair resources with audio, and check whether
 * the catalogue already exists in Gallo.
 *
 * `status` is the thing the caller acts on:
 *   ready   — nothing in Gallo yet, safe to create
 *   exists  — already imported; skipped, not an error
 *   error   — unreadable delivery (empty folders do occur — 193483268613 in
 *             batch 20260408110014377 has no XML and no audio at all)
 */
async function planRelease(releasePath) {
  let d
  try {
    d = await loadRelease(releasePath)
  } catch (e) {
    return { path: releasePath, barcode: releasePath.split('/').pop(), status: 'error', error: e.message }
  }

  const first     = d.tracks[0] || {}
  const catalogue = first.catalogue_no || null
  let existing = []
  if (catalogue) {
    existing = await findGalloRecordsByCatalogue(catalogue).catch(() => [])
  }

  return {
    path: d.path,
    barcode: d.barcode,
    catalogue,
    album: first.album_title || null,
    artist: first.artist_name || null,
    ern_version: d.ern_version,
    trackCount: d.tracks.length,
    matchedCount: d.matchedCount,
    artwork: d.artwork.map(a => a.name),
    unmatchedFiles: d.unmatchedFiles,
    existingCount: existing.length,
    status: existing.length ? 'exists' : 'ready',
    tracks: d.tracks,
  }
}

/** Preview a single release — full track detail. */
router.post('/preview', adminAuth, async (req, res) => {
  const release = String(req.body?.release || '').trim()
  if (!release) return res.status(400).json({ error: 'release path required' })
  try { res.json({ ok: true, ...(await planRelease(release)) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

/**
 * Scan a whole batch. Sequential on purpose: each release costs an FM lookup
 * and several Vision listings, and a 141-release batch fired in parallel would
 * hammer both. `limit`/`offset` let the UI page through rather than block.
 */
router.post('/scan', adminAuth, async (req, res) => {
  const batch  = String(req.body?.batch || '').trim()
  const limit  = Math.min(parseInt(req.body?.limit, 10) || 25, 200)
  const offset = parseInt(req.body?.offset, 10) || 0
  if (!batch) return res.status(400).json({ error: 'batch path required' })

  try {
    const all   = await listReleases(batch)
    const slice = all.slice(offset, offset + limit)
    const results = []
    for (const r of slice) {
      const p = await planRelease(r.path)
      const { tracks, ...summary } = p        // summary only — full detail via /preview
      results.push(summary)
    }
    res.json({
      ok: true, batch, total: all.length, offset, limit,
      returned: results.length,
      done: offset + slice.length >= all.length,
      summary: {
        ready:  results.filter(r => r.status === 'ready').length,
        exists: results.filter(r => r.status === 'exists').length,
        error:  results.filter(r => r.status === 'error').length,
      },
      releases: results,
    })
  } catch (e) { res.status(502).json({ error: e.message }) }
})

// ── DDEX track -> Gallo record ───────────────────────────────────────────────
// createGalloRecord already accepts every one of these keys, including
// audio_hash_md5, resource_reference and technical_resource — the Gallo writer
// was built for them, they simply had no source until the ERN was parsed.
const hhmmss = (sec) => {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return null
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), Math.floor(n % 60)]
    .map(x => String(x).padStart(2, '0')).join(':')
}
// FileMaker will not take a JS boolean — the lesson from DB Sync, 2026-08-03.
const parentalOf = (v) => v === true ? 'Explicit' : v === false ? 'NotExplicit' : null

const trackMeta = (t, rel) => ({
  title:              t.track_title,
  artist:             t.artist_name,
  album_artist:       t.artist_name,
  album:              t.album_title,
  catalogue_no:       t.catalogue_no || rel.catalogue,
  isrc:               t.isrc,
  barcode:            t.barcode || rel.barcode,
  sequence_no:        t.track_number,
  duration:           hhmmss(t.duration_sec),
  genre:              t.genre,
  sub_genre:          t.subgenre,
  language:           t.language,
  label:              t.label_name,
  p_line:             t.pline_text,
  c_line:             t.cline_text,
  release_date:       t.release_date,
  year:               t.release_date ? String(t.release_date).slice(0, 4) : null,
  parental:           parentalOf(t.explicit),
  rights_territories: t.territories,
  // Country only when the territory really is one. DDEX TerritoryCode carries
  // rights scope, and CCA deliveries say "Worldwide" — which is not a country
  // and must not be written into a Country field. An ISO 3166 alpha-2 code
  // passes; anything else is left empty rather than approximated.
  country:            /^[A-Z]{2}$/.test(String(t.territories || '').trim()) ? String(t.territories).trim() : null,
  audio_url:          t.audio_url,
  wav_filename:       t.file_name,
  // Straight from the ERN. Add Album streams the whole WAV to compute this;
  // a DDEX delivery states it, so a 141-release batch need not re-read
  // hundreds of gigabytes to learn what the XML already says.
  audio_hash_md5:     t.hash_sum,
  resource_reference: t.resource_reference,
  technical_resource: t.technical_resource,
})

const tapeMeta = (rel) => {
  const f = rel.tracks[0] || {}
  return {
    album_artist: f.artist_name, album: f.album_title,
    catalogue_no: rel.catalogue, barcode: rel.barcode,
    year: f.release_date ? String(f.release_date).slice(0, 4) : null,
    release_date: f.release_date, original_release_date: f.release_date,
    genre: f.genre, language: f.language,
    rights_territories: f.territories, parental: parentalOf(f.explicit),
    label: f.label_name, p_line: f.pline_text, c_line: f.cline_text,
  }
}

/**
 * Import releases. DRY RUN unless apply:true — this writes to live FileMaker
 * and a batch is 85-141 releases.
 *
 * Per release: skip if the catalogue already exists, create the Tape Files
 * Master, then the song records. A bad release is recorded and the run
 * continues — one empty delivery folder must not stop the other 84.
 */
router.post('/create', adminAuth, async (req, res) => {
  const paths = Array.isArray(req.body?.releases) ? req.body.releases : []
  const apply = req.body?.apply === true
  if (!paths.length) return res.status(400).json({ error: 'releases array required' })

  if (apply) reloadGalloLayoutFields()
  const out = []

  for (const rp of paths) {
    const rel = await planRelease(rp)
    if (rel.status !== 'ready') {
      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: rel.status,
                 error: rel.error, existingCount: rel.existingCount, created: 0 })
      continue
    }
    if (!apply) {
      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: 'would-create',
                 wouldCreate: rel.tracks.length, matched: rel.matchedCount })
      continue
    }
    try {
      const { tapeRecordId } = await createTapeFileRecord(tapeMeta(rel))
      let created = 0
      const failures = []
      for (const t of rel.tracks) {
        try { await createGalloRecord(trackMeta(t, rel)); created++ }
        catch (e) { failures.push({ title: t.track_title, error: e.message }) }
      }
      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: failures.length ? 'partial' : 'created',
                 tapeRecordId, created, failed: failures.length, failures })
      console.log(`[cca-import] ${rel.catalogue}: tape ${tapeRecordId}, ${created}/${rel.tracks.length} songs`)
    } catch (e) {
      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: 'error', error: e.message, created: 0 })
      console.warn(`[cca-import] ${rel.barcode} FAILED: ${e.message}`)
    }
  }

  res.json({
    ok: true, applied: apply, releases: out,
    summary: {
      created: out.filter(r => r.status === 'created').length,
      partial: out.filter(r => r.status === 'partial').length,
      skipped: out.filter(r => r.status === 'exists').length,
      errors:  out.filter(r => r.status === 'error').length,
      wouldCreate: out.filter(r => r.status === 'would-create').length,
    },
  })
})

export default router
