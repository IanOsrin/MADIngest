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
import { findGalloRecordsByCatalogue, createGalloRecord, createTapeFileRecord, reloadGalloLayoutFields,
         createArtworkRecord, findArtworkByCatalogue } from '../lib/fm-gallo.js'
import { visionOpen } from '../lib/vision-drive.js'

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
    artworkUrl: d.artwork[0]?.url || null,   // first image in resources/ — the cover
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

// DDEX uses 0001-01-01 as a placeholder for "unknown" (seen on 6009551501008).
// Writing that as a real date is worse than leaving the field empty, so it is
// treated as absent along with anything that is not a plausible date.
const realDate = (v) => {
  const s = String(v || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const y = parseInt(s.slice(0, 4), 10)
  return y >= 1900 && y <= 2100 ? s : null
}
// Original release date, per Ian: use the original when stated, otherwise the
// release date in both fields. CCA deliveries carry only one date today.
const datesFor = (t) => {
  const rel  = realDate(t.release_date)
  const orig = realDate(t.original_release_date) || rel
  return { release_date: rel, original_release_date: orig }
}

const trackMeta = (t, rel) => ({
  // Cover art ships inside resources/ as the next numbered item
  // (198704266508_012.jpg). Referenced by Vision path, exactly as Audio_URL
  // references the master rather than copying it.
  artwork_url:        rel.artworkUrl || null,
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
  ...datesFor(t),
  year:               (datesFor(t).original_release_date || '').slice(0, 4) || null,
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
    artwork_url: rel.artworkUrl || null,
    album_artist: f.artist_name, album: f.album_title,
    catalogue_no: rel.catalogue, barcode: rel.barcode,
    year: (datesFor(f).original_release_date || '').slice(0, 4) || null,
    ...datesFor(f),
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
      // Artwork record — Ian's manual flow: new record on the Artwork layout,
      // catalogue number in, image dragged into the Picture container. Send
      // ONLY the catalogue number: 'Resource reference' is auto-enter and
      // FileMaker issues the GMVic serial itself, which a supplied value would
      // override. Skipped when the catalogue already has one, so re-running a
      // batch cannot duplicate them.
      let artwork = null
      if (rel.artworkUrl) {
        try {
          const existingArt = await findArtworkByCatalogue(rel.catalogue)
          if (existingArt.length) {
            artwork = { skipped: true, existing: existingArt[0].recordId }
          } else {
            const img = Buffer.from(await (await visionOpen(rel.artworkUrl)).Body.transformToByteArray())
            const a = await createArtworkRecord({
              catalogue_no: rel.catalogue,
              image: img,
              filename: rel.artworkUrl.split('/').pop(),
              contentType: /\.png$/i.test(rel.artworkUrl) ? 'image/png' : 'image/jpeg',
            })
            artwork = { recordId: a.recordId, bytes: a.bytes }
          }
        } catch (e) {
          // Never fatal: the release and its audio are already in by this point.
          artwork = { error: e.message }
          console.warn(`[cca-import] ${rel.catalogue} artwork failed: ${e.message}`)
        }
      }

      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: failures.length ? 'partial' : 'created',
                 tapeRecordId, created, failed: failures.length, failures, artwork })
      console.log(`[cca-import] ${rel.catalogue}: tape ${tapeRecordId}, ${created}/${rel.tracks.length} songs` +
                  (artwork?.recordId ? `, artwork ${artwork.recordId}` : artwork?.skipped ? ', artwork already present' : ''))
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
