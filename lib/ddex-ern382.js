// DDEX ERN 3.8.2 field extractor
// Receives a namespace-stripped, xml2js-parsed root and fileMap { basename.toLowerCase() → Buffer }

export function parseDDEXErn382(root, fileMap) {
  const resources = toArray(root?.ResourceList?.SoundRecording)
  const releases  = toArray(root?.ReleaseList?.Release)

  // Build lookup: ResourceReference → SoundRecording
  const resourceMap = {}
  resources.forEach(r => {
    const ref = str(r.ResourceReference)
    if (ref) resourceMap[ref] = r
  })

  // Find the artwork image resource (first FrontCoverImage or any Image)
  const images = toArray(root?.ResourceList?.Image)
  let artworkFileName = null
  const frontCover = images.find(img => img.ImageType === 'FrontCoverImage') || images[0]
  if (frontCover) {
    artworkFileName = str(frontCover.TechnicalDetails?.File?.FileName || frontCover.File?.FileName)
  }
  const artworkBuffer = artworkFileName ? fileMap[artworkFileName.toLowerCase()] : null

  // Find the album-level release — either ReleaseType=Album or IsMainRelease=true
  const albumRelease = releases.find(r =>
    str(r.ReleaseType) === 'Album' ||
    str(r.IsMainRelease) === 'true'
  )

  // Build track-order map from the main release's resource reference list
  const sequenceMap = {}
  const mainRefs = toArray(albumRelease?.ReleaseResourceReferenceList?.ReleaseResourceReference)
  mainRefs.forEach((ref, idx) => {
    const key = str(ref._ || ref)
    if (key) sequenceMap[key] = idx + 1
  })

  // Extract album-level IDs
  const albumReleaseIds = toArray(albumRelease?.ReleaseId)
  const albumBarcode    = str(albumReleaseIds.find(i => i.ICPN)?.ICPN || null)
  const albumCatalogueRaw = albumReleaseIds.find(i => i.CatalogNumber)?.CatalogNumber
  const albumCatalogue  = str(albumCatalogueRaw?._ || albumCatalogueRaw || null)

  const tracks = []

  releases.forEach(release => {
    const releaseType = str(release.ReleaseType)

    if (releaseType === 'Album' || releaseType === '') {
      // Pull tracks from TrackReleaseList
      const trackReleases = toArray(
        release.TrackReleaseList?.TrackRelease ||
        release.TrackRelease
      )
      if (trackReleases.length > 0) {
        trackReleases.forEach((tr, idx) => {
          const ref = str(
            tr.ReleaseResourceReferenceList?.ReleaseResourceReference ||
            tr.LinkedReleaseResourceReference
          )
          const sr = resourceMap[ref]
          if (sr) {
            const track = mapSoundRecording(sr, release, fileMap, artworkBuffer, albumBarcode, albumCatalogue)
            if (!track.track_number) track.track_number = sequenceMap[track._ref] || idx + 1
            tracks.push(track)
          }
        })
        return
      }
    }

    // Single / EP / track-level release
    const refs = toArray(
      release.ReleaseResourceReferenceList?.ReleaseResourceReference ||
      release.LinkedReleaseResourceReference
    )
    refs.forEach(ref => {
      const sr = resourceMap[str(ref)]
      if (sr) {
        const track = mapSoundRecording(sr, albumRelease || release, fileMap, artworkBuffer, albumBarcode, albumCatalogue)
        if (!track.track_number) track.track_number = sequenceMap[track._ref] || null
        tracks.push(track)
      }
    })
  })

  // Deduplicate by ResourceReference if the same SR appeared in multiple releases
  const seen = new Set()
  return tracks.filter(t => {
    if (seen.has(t._ref)) return false
    seen.add(t._ref)
    return true
  })
}

function mapSoundRecording(sr, release, fileMap, artworkBuffer, albumBarcode, albumCatalogue) {
  const ids   = toArray(sr.SoundRecordingId)
  const isrc  = ids.find(i => i.ISRC)?.ISRC || null
  const iswc  = str(toArray(sr.WorkId).find(w => w.ISWC)?.ISWC) || null

  const durSec = parseDuration(str(sr.Duration))

  // Fields may be at top level OR nested inside SoundRecordingDetailsByTerritory
  const details = toArray(sr.SoundRecordingDetailsByTerritory)[0] || {}

  const artists = toArray(sr.DisplayArtist || details.DisplayArtist || release?.DisplayArtist)
  const mainArtist = artists.find(a => str(a.ArtistRole) === 'MainArtist') ||
                     artists.find(a => str(a.SequenceNumber) === '1') ||
                     artists[0]
  const artistName = str(
    mainArtist?.PartyName?.FullName ||
    mainArtist?.PartyName ||
    details.DisplayArtistName ||
    release?.DisplayArtistName ||
    null
  )

  const contributors = toArray(
    sr.ResourceContributor || details.ResourceContributor ||
    sr.IndirectResourceContributor || details.IndirectResourceContributor
  )
  const credits = contributors.map(mapContributor).filter(Boolean)

  // Technical details → audio filename
  const techDetails = toArray(
    sr.TechnicalDetails || sr.TechnicalSoundRecordingDetails ||
    details.TechnicalSoundRecordingDetails
  )
  const audioFileName = str(
    techDetails[0]?.File?.FileName ||
    techDetails[0]?.AudioFile?.FileName ||
    null
  )
  const wavBuffer = audioFileName ? fileMap[audioFileName.toLowerCase()] : null

  const rightsCtrl   = toArray(sr.RightsController || details.RightsController)[0]
  const pLine        = sr.PLine || details.PLine || release?.PLine
  const rightsHolder = str(rightsCtrl?.RightsControllerPartyReference || pLine?.PLineText || null)
  const rightsYear   = parseInt(str(pLine?.Year || String(pLine?.PLineText || '').match(/\d{4}/)?.[0] || ''), 10) || null

  const parentalWarning = str(sr.ParentalWarningType || details.ParentalWarningType || release?.ParentalWarningType)
  const explicit = parentalWarning === 'Explicit'

  // Genre — check both top-level and details wrapper
  const genreEl  = sr.Genre || details.Genre
  const genre    = str(genreEl?.GenreText || genreEl || null)
  const subgenre = str(genreEl?.SubGenre || null)

  // Deal territories
  const deals = toArray(release?.DealList?.ReleaseDeal || [])
  const territories = deals.flatMap(d =>
    toArray(d.Deal?.DealTerms?.TerritoryCode || d.Deal?.TerritoryCode || [])
  ).map(str).filter(Boolean).join(',') || 'WORLDWIDE'

  const albumTitle  = str(release?.ReferenceTitle?.TitleText || null)
  const releaseDate = str(sr.CreationDate || details.ReleaseDate || release?.ReleaseDate || null)
  const year        = extractYear(releaseDate) || rightsYear

  // Sequence number from sr directly (not DisplayArtist attribute)
  const trackNumber = parseInt(str(sr.SequenceNumber || null), 10) || null
  const language    = str(sr.LanguageOfPerformance || details.LanguageOfPerformance || null)

  // Catalogue and barcode from album release IDs (passed in)
  const catalogue_no = albumCatalogue || null
  const barcode      = albumBarcode   || null

  return {
    _ref:          str(sr.ResourceReference),
    track_title:   getTitle(sr),
    version_title: getVersionTitle(sr),
    artist_name:   artistName,
    album_title:   albumTitle,
    isrc,
    iswc,
    year,
    genre,
    subgenre,
    language,
    duration_sec:  durSec,
    track_number:  trackNumber,
    explicit,
    catalogue_no,
    barcode,
    rights_holder: rightsHolder,
    rights_year:   rightsYear,
    territories,
    credits,
    wav_buffer:    wavBuffer,
    artwork_buffer: artworkBuffer,
    submitter_name:  'DDEX Import',
    submitter_email: 'ddex@internal',
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toArray(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  return [v]
}

function str(v) {
  if (v == null) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'object' && '_' in v) return String(v._).trim() || null
  return String(v).trim() || null
}

function parseDuration(s) {
  if (!s) return null
  const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/)
  if (!m) return null
  return ((+m[1] || 0) * 3600) + ((+m[2] || 0) * 60) + (+m[3] || 0) || null
}

function extractYear(dateStr) {
  if (!dateStr) return null
  const m = String(dateStr).match(/(\d{4})/)
  return m ? parseInt(m[1], 10) : null
}

function getTitle(sr) {
  const ref = sr.ReferenceTitle?.TitleText
  if (ref) return str(ref)
  const titles = toArray(sr.Title)
  const formal = titles.find(t => str(t.TitleType) === 'FormalTitle' || !t.TitleType)
  return str(formal?.TitleText || titles[0]?.TitleText || null)
}

function getVersionTitle(sr) {
  const titles = toArray(sr.Title)
  const altTitle = titles.find(t => str(t.TitleType) === 'AlternativeTitle')
  if (altTitle) {
    const sub = altTitle.SubTitle
    if (sub) return str(sub._ || sub)
  }
  return null
}

function mapContributor(c) {
  const name = str(c.PartyName?.FullName || c.PartyName)
  if (!name) return null
  const role = str(c.Role || c.ContributorRole || c.ResourceContributorRole)
  const ipi  = str(c.ProprietaryId?.ProprietaryId || null)
  const share = parseFloat(str(c.HasRightShare || null)) || null
  return { name, role, pro_ipi: ipi, share_pct: share }
}
