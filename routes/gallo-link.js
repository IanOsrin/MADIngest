// routes/gallo-link.js — link Vision audio to Gallo Catalogue records.
//
// The second half of the CMS 2024 → Gallo promotion: after pull-catalogue-to-
// gallo creates the records from CMS metadata, this matches each record to its
// WAV on Vision (by normalised track name) and writes the Vision path into the
// record's audio_Url field. Playback then flows through the web viewer.
//
//   GET  /api/gallo-link/preview?catalogue=CYL 1054   → the plan (no writes)
//   POST /api/gallo-link/apply   {catalogue, dryRun}   → write audio_Url
//
// Preview matches against CMS tracks when no Gallo records exist yet (so you can
// see it before pulling); apply matches against the actual Gallo records.
import path from 'path'
import { Router } from 'express'
import { adminAuth } from '../lib/admin-auth.js'
import { findGalloRecordsByCatalogue, updateGalloRecord, getGalloLayoutFieldSet, getGalloFieldData } from '../lib/fm-gallo.js'
import { findRecordsByCatalogue as cmsFind } from '../lib/fm-cms2024.js'
import { buildVisionIndex, filesForCatalogue, matchTracksToFiles } from '../lib/gallo-vision-link.js'
import { resolveGalloAudio } from '../lib/gallo-vision.js'

const router = Router()
const INDEX_CACHE = path.join(process.cwd(), 'tmp', 'vision-index.json')
// The record field that stores the Vision reference. It MUST be placed on the
// Data API layout — a field that exists in the table but not on the layout is
// silently discarded on write (FileMaker returns success, value never persists).
const AUDIO_URL_FIELD = process.env.GALLO_AUDIO_URL_FIELD || 'Audio_URL'

async function planFor(catalogue, { refresh = false } = {}) {
  const gallo = await findGalloRecordsByCatalogue(catalogue)
  // Track list to match on: prefer real Gallo records; fall back to CMS 2024
  // (so a not-yet-pulled catalogue can still be previewed).
  let tracks, source
  if (gallo.length) {
    tracks = gallo.map(g => ({ ...g, gallo_record_id: g.fm_record_id }))
    source = 'gallo'
  } else {
    tracks = (await cmsFind(catalogue)).map(c => ({ title: c.title, sequence_no: c.sequence_no }))
    source = 'cms2024'
  }
  const index = await buildVisionIndex({ cacheFile: INDEX_CACHE, refresh })
  const files = filesForCatalogue(index, catalogue)
  const { matched, tracksNoAudio, filesNoTrack, folders } = matchTracksToFiles(tracks, files)
  return { catalogue, source, galloCount: gallo.length, indexedFiles: index.builtFiles, folders, matched, tracksNoAudio, filesNoTrack }
}

router.get('/preview', adminAuth, async (req, res) => {
  try {
    const catalogue = String(req.query.catalogue || '').trim()
    if (!catalogue) return res.status(400).json({ error: 'catalogue is required' })
    const plan = await planFor(catalogue, { refresh: req.query.refresh === '1' })
    res.json({
      ...plan,
      matched: plan.matched.map(m => ({
        gallo_record_id: m.track.gallo_record_id || null,
        sequence_no: m.track.sequence_no ?? null,
        title: m.track.title,
        audio_Url: m.audio_Url,
        size: m.file.size,
        alreadySet: m.track.gallo_record_id ? undefined : null,
      })),
      tracksNoAudio: plan.tracksNoAudio.map(t => ({ sequence_no: t.sequence_no ?? null, title: t.title })),
      filesNoTrack: plan.filesNoTrack.map(f => ({ name: f.name, path: f.path })),
    })
  } catch (e) {
    console.error('[gallo-link] preview failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/apply', adminAuth, async (req, res) => {
  try {
    const catalogue = String(req.body?.catalogue || '').trim()
    const dryRun = !!req.body?.dryRun
    const force = !!req.body?.force // overwrite an existing audio_Url
    if (!catalogue) return res.status(400).json({ error: 'catalogue is required' })

    const gallo = await findGalloRecordsByCatalogue(catalogue)
    if (!gallo.length) return res.status(404).json({ error: `No Gallo records for ${catalogue} — pull from CMS 2024 first` })

    // Pre-flight: the target field must be ON the Data API layout, else writes
    // are silently discarded (they succeed but never persist).
    const known = await getGalloLayoutFieldSet()
    if (!known.has(AUDIO_URL_FIELD)) {
      return res.status(409).json({
        error: `Field "${AUDIO_URL_FIELD}" is not on the Data API layout — add it to the "${process.env.GALLO_FM_LAYOUT}" layout in FileMaker (the field can exist in the table but must be PLACED on the layout), or set GALLO_AUDIO_URL_FIELD to one that is. On-layout fields: ${[...known].filter(f => /url|audio|file/i.test(f)).join(', ')}`,
      })
    }

    const index = await buildVisionIndex({ cacheFile: INDEX_CACHE })
    const files = filesForCatalogue(index, catalogue)
    const tracks = gallo.map(g => ({ ...g, gallo_record_id: g.fm_record_id }))
    const { matched, tracksNoAudio, filesNoTrack } = matchTracksToFiles(tracks, files)

    const results = []
    let written = 0, skipped = 0
    for (const m of matched) {
      const id = m.track.gallo_record_id
      // Skip if the record already has an audio_Url (unless force) — resolve the
      // current value to compare intent, not exact string.
      const current = resolveGalloAudio(m.track).ok ? (m.track.audio_Url || m.track.audio_url || '') : ''
      if (current && !force) {
        skipped++; results.push({ gallo_record_id: id, title: m.track.title, action: 'skipped-has-value' }); continue
      }
      if (dryRun) { results.push({ gallo_record_id: id, title: m.track.title, action: 'would-write', audio_Url: m.audio_Url }); continue }
      try {
        await updateGalloRecord(id, { [AUDIO_URL_FIELD]: m.audio_Url })
        // Read back — trust nothing FileMaker's write API says until confirmed.
        const after = await getGalloFieldData(id)
        if ((after?.[AUDIO_URL_FIELD] || '') !== m.audio_Url) {
          results.push({ gallo_record_id: id, title: m.track.title, action: 'not-persisted', audio_Url: m.audio_Url })
          continue
        }
        written++; results.push({ gallo_record_id: id, title: m.track.title, action: 'written', audio_Url: m.audio_Url })
      } catch (e) {
        results.push({ gallo_record_id: id, title: m.track.title, action: 'error', error: e.message })
      }
    }
    res.json({
      catalogue, dryRun, matched: matched.length, written, skipped,
      tracksNoAudio: tracksNoAudio.length, filesNoTrack: filesNoTrack.length, results,
    })
  } catch (e) {
    console.error('[gallo-link] apply failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
