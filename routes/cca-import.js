// routes/cca-import.js — CCA DDEX deliveries → Music Arena Master.
//
// Follows Add Album's shape (find → preview → create) but takes its metadata
// from the delivery's own ERN rather than the metadata cache. For CCA releases
// the ERN IS the source of truth: it carries ISRC, hash sum, resource
// references and P/C lines that the Ingrooves extract does not cover at all
// (the CCA_ prefix is absent from that export entirely).
//
// Target: MAM is the canonical catalogue, so imports land there by default.
// Gallo Catalogue remains reachable with target:'gallo' rather than being
// deleted — the code was working and losing it would be a one-way door.
//
// Read-only endpoints here. Creation is separate and deliberate.

import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { listBatches, listReleases, loadRelease } from '../lib/cca-ddex.js'
import { findGalloRecordsByCatalogue, findGalloCataloguesPresent, createGalloRecord, createTapeFileRecord,
         reloadGalloLayoutFields, createArtworkRecord, findArtworkByCatalogue } from '../lib/fm-gallo.js'
import { visionOpen } from '../lib/vision-drive.js'
import { mamSession, makeIdAllocator, albumIdFor, findMamAlbum, findMamCataloguesPresent,
         albumIdTaken, createMamAlbum, createMamSong } from '../lib/fm-mam-write.js'
import { findMamRecordsByCatalogue } from '../lib/fm-mam.js'

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
async function planRelease(releasePath, target = 'mam') {
  let d
  try {
    d = await loadRelease(releasePath)
  } catch (e) {
    return { path: releasePath, barcode: releasePath.split('/').pop(), status: 'error', error: e.message }
  }

  const first     = d.tracks[0] || {}
  const catalogue = first.catalogue_no || null
  // "Already imported?" has to be asked of the database we are about to write
  // to — asking Gallo while writing MAM would happily import everything twice.
  let existing = []
  if (catalogue) {
    existing = target === 'gallo'
      ? await findGalloRecordsByCatalogue(catalogue).catch(() => [])
      : await findMamRecordsByCatalogue(catalogue).catch(() => [])
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
    target,
    status: existing.length ? 'exists' : 'ready',
    tracks: d.tracks,
  }
}

/** Preview a single release — full track detail. */
router.post('/preview', adminAuth, async (req, res) => {
  const release = String(req.body?.release || '').trim()
  const target = req.body?.target === 'gallo' ? 'gallo' : 'mam'
  if (!release) return res.status(400).json({ error: 'release path required' })
  try { res.json({ ok: true, ...(await planRelease(release, target)) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

/**
 * Scan a whole batch. Sequential on purpose: each release costs an FM lookup
 * and several Vision listings, and a 141-release batch fired in parallel would
 * hammer both. `limit`/`offset` let the UI page through rather than block.
 */
router.post('/scan', adminAuth, async (req, res) => {
  const batch  = String(req.body?.batch || '').trim()
  const target = req.body?.target === 'gallo' ? 'gallo' : 'mam'
  const limit  = Math.min(parseInt(req.body?.limit, 10) || 25, 200)
  const offset = parseInt(req.body?.offset, 10) || 0
  if (!batch) return res.status(400).json({ error: 'batch path required' })

  try {
    const all   = await listReleases(batch)
    const slice = all.slice(offset, offset + limit)

    // Two changes make this fast. The Vision + XML work runs CONCURRENTLY —
    // reading 401 XMLs across every batch took 14s at this concurrency, where
    // one at a time it crawled. And the FileMaker "already imported?" check is
    // now ONE find for the whole page instead of a round trip per release.
    const CONC = 10
    const loaded = new Array(slice.length)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(CONC, slice.length) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= slice.length) return
        loaded[i] = await loadRelease(slice[i].path)
          .then(d => ({ ok: true, d }))
          .catch(e => ({ ok: false, error: e.message }))
      }
    }))

    const catalogues = loaded.filter(x => x.ok).map(x => x.d.tracks[0]?.catalogue_no).filter(Boolean)
    const present = target === 'gallo'
      ? await findGalloCataloguesPresent(catalogues).catch(() => new Map())
      : await findMamCataloguesPresent(catalogues).catch(() => new Map())

    const results = slice.map((r, i) => {
      const L = loaded[i]
      if (!L.ok) return { path: r.path, barcode: r.barcode, status: 'error', error: L.error }
      const d = L.d
      const first = d.tracks[0] || {}
      const catalogue = first.catalogue_no || null
      const existingCount = catalogue ? (present.get(catalogue) || 0) : 0
      return {
        path: d.path, barcode: d.barcode, catalogue,
        album: first.album_title || null, artist: first.artist_name || null,
        ern_version: d.ern_version,
        trackCount: d.tracks.length, matchedCount: d.matchedCount,
        artwork: d.artwork.map(a => a.name),
        unmatchedFiles: d.unmatchedFiles,
        existingCount,
        status: existingCount ? 'exists' : 'ready',
      }
    })
    res.json({
      ok: true, batch, target, total: all.length, offset, limit,
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

// Contributor names for the roles matching `re`, de-duplicated. The ERN carries
// them as IndirectResourceContributor entries with a role — "Composer" on CCA
// deliveries. Null when there are none, so the field simply is not sent.
const creditNames = (credits, re) => {
  const names = [...new Set((credits || [])
    .filter(c => re.test(String(c?.role || '')))
    .map(c => String(c?.name || '').trim())
    .filter(Boolean))]
  return names.length ? names.join('; ') : null
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
  composers:          creditNames(t.credits, /composer|writer|lyricist|author/i),
  producers:          creditNames(t.credits, /producer/i),
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
  // Filename without its extension. The ERN states "198704245985_001_001.wav";
  // the FM Filename field holds the bare asset name, matching how Add Album
  // writes the GCAT with no extension.
  wav_filename:       t.file_name ? String(t.file_name).replace(/\.[^.]+$/, '') : null,
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
  const target = req.body?.target === 'gallo' ? 'gallo' : 'mam'
  if (!paths.length) return res.status(400).json({ error: 'releases array required' })

  if (apply && target === 'gallo') reloadGalloLayoutFields()

  // One MAM session and ONE id allocation for the whole run. Re-reading the max
  // per release would race against itself and hand two songs the same MasterID.
  let mam = null, ids = null
  if (apply && target === 'mam') {
    mam = await mamSession()
    ids = await makeIdAllocator(mam)
    console.log(`[cca-import] MAM ids continue from MAST${ids.startedAt.master} / REC${ids.startedAt.rec}`)
  }
  const out = []

  try {
  for (const rp of paths) {
    const rel = await planRelease(rp, target)
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
      let tapeRecordId = null, albumID = null
      let created = 0
      const failures = []

      if (target === 'mam') {
        // Belt and braces over planRelease's check: that looked for SONGS, and
        // an album shell with no songs would otherwise be duplicated.
        if (await findMamAlbum(mam, rel.catalogue)) {
          out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: 'exists',
                     existingCount: rel.existingCount, created: 0 })
          continue
        }
        albumID = albumIdFor(rel.catalogue)
        // The ID is derived and therefore lossy (truncated at 20 chars), so two
        // different long catalogues can land on the same one. Reusing it would
        // silently file this album's songs under someone else's album.
        if (await albumIdTaken(mam, albumID)) {
          out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: 'error', created: 0,
                     error: `AlbumID ${albumID} is already in use by another catalogue — needs a manual ID` })
          continue
        }
        const tm = tapeMeta(rel)
        tapeRecordId = await createMamAlbum(mam, { ...tm, track_count: rel.tracks.length })
        for (const t of rel.tracks) {
          const m = trackMeta(t, rel)
          try {
            await createMamSong(mam, { ...m, album_id: albumID,
              master_id: ids.nextMaster(), recording_id: ids.nextRecording(),
              sources: 'cca', match_method: 'ddex' })
            created++
          } catch (e) { failures.push({ title: t.track_title, error: e.message }) }
        }
      } else {
        ;({ tapeRecordId } = await createTapeFileRecord(tapeMeta(rel)))
        for (const t of rel.tracks) {
          try { await createGalloRecord(trackMeta(t, rel)); created++ }
          catch (e) { failures.push({ title: t.track_title, error: e.message }) }
        }
      }
      // Artwork record — Ian's manual flow: new record on the Artwork layout,
      // catalogue number in, image dragged into the Picture container. Send
      // ONLY the catalogue number: 'Resource reference' is auto-enter and
      // FileMaker issues the GMVic serial itself, which a supplied value would
      // override. Skipped when the catalogue already has one, so re-running a
      // batch cannot duplicate them.
      // MAM has no Artwork table — the album row carries Artwork_Vision_URL,
      // already written above. The container/serial dance below is Gallo's.
      let artwork = null
      if (target === 'mam') {
        artwork = rel.artworkUrl ? { visionUrl: rel.artworkUrl } : null
      } else if (rel.artworkUrl) {
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
                 target, albumID, tapeRecordId, created, failed: failures.length, failures, artwork })
      console.log(`[cca-import] ${rel.catalogue}: ${target === 'mam' ? 'album ' + albumID : 'tape ' + tapeRecordId}, ${created}/${rel.tracks.length} songs` +
                  (artwork?.recordId ? `, artwork ${artwork.recordId}` : artwork?.skipped ? ', artwork already present' : ''))
    } catch (e) {
      out.push({ barcode: rel.barcode, catalogue: rel.catalogue, status: 'error', error: e.message, created: 0 })
      console.warn(`[cca-import] ${rel.barcode} FAILED: ${e.message}`)
    }
  }

  } finally { if (mam) await mam.logout() }

  res.json({
    ok: true, applied: apply, target, releases: out,
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
