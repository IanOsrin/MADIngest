// DDEX ERN field extractor — handles ERN 3.8.x and 4.1
//
// ERN 3.8.x differences from 4.1:
//   - Most SoundRecording metadata (artists, genre, label, tech details, rights) is nested
//     inside <SoundRecordingDetailsByTerritory> rather than directly on <SoundRecording>
//   - Release metadata (artist, label, genre, release date) is inside <ReleaseDetailsByTerritory>
//   - Contributor roles use <IndirectResourceContributorRole> (not ResourceContributorRole)
//
// ERN 4.1 differences:
//   - TechnicalDetails → TechnicalSoundRecordingDetails (also may be TechnicalDetails)
//   - ArtistRole may be wrapped: { ArtistRoleType: 'MainArtist' } instead of plain string
//   - RightsController is more explicit with PartyName + RightsType
//   - DisplayArtistName may be a nested object with LanguageAndScriptCode attribute

export function parseDDEXErn41(root, fileMap) {
  const resources = toArray(root?.ResourceList?.SoundRecording)
  const releases  = toArray(root?.ReleaseList?.Release)

  const resourceMap = {}
  resources.forEach(r => {
    const ref = str(r.ResourceReference)
    if (ref) resourceMap[ref] = r
  })

  // Artwork — prefer FrontCoverImage
  // ERN 3.8.x: Image metadata may be in TechnicalImageDetails (not TechnicalDetails)
  const images = toArray(root?.ResourceList?.Image)
  const frontCover = images.find(img => {
    const imgTerritory = toArray(img.ImageDetailsByTerritory)[0] || img
    return str(img.ImageType || imgTerritory.ImageType) === 'FrontCoverImage'
  }) || images[0]
  let artworkBuffer = null
  if (frontCover) {
    const fcTerritory = toArray(frontCover.ImageDetailsByTerritory)[0] || frontCover
    const fname = str(
      fcTerritory.TechnicalImageDetails?.File?.FileName ||
      frontCover.TechnicalDetails?.File?.FileName ||
      frontCover.TechnicalImageDetails?.File?.FileName ||
      null
    )
    if (fname) artworkBuffer = fileMap[fname.toLowerCase()] || null
  }

  const albumRelease = releases.find(r => str(r.ReleaseType) === 'Album')
  const tracks = []

  releases.forEach(release => {
    const releaseType = str(release.ReleaseType)

    if (releaseType === 'Album' || !releaseType) {
      const trackReleases = toArray(release.TrackReleaseList?.TrackRelease || release.TrackRelease)
      if (trackReleases.length > 0) {
        trackReleases.forEach((tr, idx) => {
          const ref = str(
            tr.ReleaseResourceReferenceList?.ReleaseResourceReference ||
            tr.LinkedReleaseResourceReference
          )
          const sr = resourceMap[ref]
          if (sr) {
            const track = mapSoundRecording41(sr, release, fileMap, artworkBuffer)
            if (!track.track_number) track.track_number = idx + 1
            tracks.push(track)
          }
        })
        return
      }
    }

    const refs = toArray(
      release.ReleaseResourceReferenceList?.ReleaseResourceReference ||
      release.LinkedReleaseResourceReference
    )
    refs.forEach(ref => {
      const sr = resourceMap[str(ref)]
      if (sr) tracks.push(mapSoundRecording41(sr, albumRelease || release, fileMap, artworkBuffer))
    })
  })

  const seen = new Set()
  return tracks.filter(t => {
    if (seen.has(t._ref)) return false
    seen.add(t._ref)
    return true
  })
}

function mapSoundRecording41(sr, release, fileMap, artworkBuffer) {
  const ids  = toArray(sr.SoundRecordingId)
  const isrc = str(ids.find(i => i.ISRC)?.ISRC) || null
  const iswc = str(toArray(sr.WorkId).find(w => w.ISWC)?.ISWC) || null

  const durSec = parseDuration(str(sr.Duration))

  // ERN 3.8.x nests most metadata inside SoundRecordingDetailsByTerritory.
  // Fall back to sr itself for ERN 4.1 (which puts data at the root level).
  const srD = toArray(sr.SoundRecordingDetailsByTerritory)[0] || sr

  // ERN 3.8.x nests release metadata inside ReleaseDetailsByTerritory.
  const relD = toArray(release?.ReleaseDetailsByTerritory)[0] || release || {}

  // ERN 4.1: ArtistRole may be { ArtistRoleType: 'MainArtist' } or just 'MainArtist'
  const artists = toArray(srD.DisplayArtist || sr.DisplayArtist || relD.DisplayArtist || release?.DisplayArtist)
  const mainArtist = artists.find(a => {
    const role = str(a.ArtistRole?.ArtistRoleType || a.ArtistRole)
    return role === 'MainArtist' || str(a.SequenceNumber) === '1'
  }) || artists[0]

  const artistName = str(
    mainArtist?.PartyName?.FullName ||
    mainArtist?.PartyName ||
    relD.DisplayArtistName?._ ||
    relD.DisplayArtistName ||
    release?.DisplayArtistName?._ ||
    release?.DisplayArtistName ||
    null
  )

  const contributors = toArray(
    srD.ResourceContributor || srD.IndirectResourceContributor ||
    sr.ResourceContributor  || sr.IndirectResourceContributor
  )
  const credits = contributors.map(mapContributor41).filter(Boolean)

  // ERN 4.1: prefer TechnicalSoundRecordingDetails, fall back to TechnicalDetails
  const techDetails = toArray(
    srD.TechnicalSoundRecordingDetails ||
    srD.TechnicalDetails ||
    sr.TechnicalSoundRecordingDetails ||
    sr.TechnicalDetails
  )
  const audioFileName = str(
    techDetails[0]?.File?.FileName ||
    techDetails[0]?.AudioFile?.FileName ||
    null
  )
  const wavBuffer = audioFileName ? fileMap[audioFileName.toLowerCase()] : null

  // Rights — check territory-level data first (ERN 3.8.x), then root (ERN 4.1)
  const rightsCtrl   = toArray(srD.RightsController || sr.RightsController)[0]
  const pLine        = srD.PLine || sr.PLine || relD.PLine || release?.PLine
  const cLine        = srD.CLine || sr.CLine || relD.CLine || release?.CLine
  const rightsHolder = str(
    rightsCtrl?.PartyName?.FullName ||
    pLine?.PLineText ||
    cLine?.CLineText ||
    null
  )
  const rightsYear = parseInt(str(pLine?.Year || extractYear(str(pLine?.PLineText)) || ''), 10) || null

  const parentalWarning = str(
    srD.ParentalWarningType || sr.ParentalWarningType ||
    relD.ParentalWarningType || release?.ParentalWarningType
  )
  const explicit = parentalWarning === 'Explicit'

  const genreEl  = srD.Genre || sr.Genre || relD.Genre || release?.Genre
  const genre    = str(genreEl?.GenreText || genreEl || null)
  const subgenre = str(genreEl?.SubGenre || null)

  const deals = toArray(release?.DealList?.ReleaseDeal || [])
  const territories = deals.flatMap(d =>
    toArray(d.Deal?.DealTerms?.TerritoryCode || d.Deal?.TerritoryCode || [])
  ).map(str).filter(Boolean).join(',') || 'WORLDWIDE'

  const albumTitle  = str(release?.ReferenceTitle?.TitleText || null)
  const releaseDate = str(
    sr.CreationDate ||
    relD.ReleaseDate || release?.ReleaseDate ||
    null
  )
  const year        = extractYear(releaseDate)
  const trackNumber = parseInt(str(sr.SequenceNumber || null), 10) || null
  const language    = str(sr.LanguageOfPerformance || null)
  const labelName   = str(srD.LabelName || sr.LabelName || relD.LabelName || null)

  // Catalogue number and barcode live on the album Release's <ReleaseId>
  const releaseIds   = toArray(release?.ReleaseId)
  const icpnEntry    = releaseIds.find(id => id.ICPN)
  const barcode      = str(icpnEntry?.ICPN?._ || icpnEntry?.ICPN || null)
  const catalogue_no = str(releaseIds.find(id => id.CatalogNumber)?.CatalogNumber || null)

  return {
    _ref:          str(sr.ResourceReference),
    track_title:   getTitle41(sr),
    version_title: getVersionTitle41(sr),
    artist_name:   artistName,
    album_title:   albumTitle,
    label_name:    labelName,
    isrc,
    iswc,
    year,
    release_date:  releaseDate,
    genre,
    subgenre,
    language,
    duration_sec:  durSec,
    track_number:  trackNumber,
    explicit,
    rights_holder: rightsHolder,
    rights_year:   rightsYear,
    territories,
    credits,
    catalogue_no,
    barcode,
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

function getTitle41(sr) {
  const ref = sr.ReferenceTitle?.TitleText
  if (ref) return str(ref)
  const titles = toArray(sr.Title)
  const formal = titles.find(t => !t.TitleType || str(t.TitleType) === 'FormalTitle')
  return str(formal?.TitleText || titles[0]?.TitleText || null)
}

function getVersionTitle41(sr) {
  const titles = toArray(sr.Title)
  const alt = titles.find(t => str(t.TitleType) === 'AlternativeTitle')
  if (alt) {
    const sub = alt.SubTitle
    if (sub) return str(sub._ || sub)
  }
  return null
}

function mapContributor41(c) {
  const name = str(c.PartyName?.FullName || c.PartyName)
  if (!name) return null
  const role = str(
    c.ResourceContributorRole?.ContributorRole ||
    c.ResourceContributorRole ||
    c.IndirectResourceContributorRole ||   // ERN 3.8.x composer/lyricist roles
    c.Role ||
    null
  )
  const ipi   = str(c.ProprietaryId?.ProprietaryId || null)
  const share = parseFloat(str(c.HasRightShare || null)) || null
  return { name, role, pro_ipi: ipi, share_pct: share }
}
