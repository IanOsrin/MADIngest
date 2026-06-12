// DDEX ERN 4.1 field extractor
// ERN 4.1 is structurally similar to 3.8.2 but has some key differences:
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
  const images = toArray(root?.ResourceList?.Image)
  const frontCover = images.find(img => img.ImageType === 'FrontCoverImage') || images[0]
  let artworkBuffer = null
  if (frontCover) {
    const fname = str(
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
  const isrc = ids.find(i => i.ISRC)?.ISRC || null
  const iswc = str(toArray(sr.WorkId).find(w => w.ISWC)?.ISWC) || null

  const durSec = parseDuration(str(sr.Duration))

  // ERN 4.1: ArtistRole may be { ArtistRoleType: 'MainArtist' } or just 'MainArtist'
  const artists = toArray(sr.DisplayArtist || release?.DisplayArtist)
  const mainArtist = artists.find(a => {
    const role = str(a.ArtistRole?.ArtistRoleType || a.ArtistRole)
    return role === 'MainArtist' || str(a.SequenceNumber) === '1'
  }) || artists[0]

  const artistName = str(
    mainArtist?.PartyName?.FullName ||
    mainArtist?.PartyName ||
    release?.DisplayArtistName?._ ||
    release?.DisplayArtistName ||
    null
  )

  const contributors = toArray(sr.ResourceContributor || sr.IndirectResourceContributor)
  const credits = contributors.map(mapContributor41).filter(Boolean)

  // ERN 4.1: prefer TechnicalSoundRecordingDetails, fall back to TechnicalDetails
  const techDetails = toArray(
    sr.TechnicalSoundRecordingDetails ||
    sr.TechnicalDetails
  )
  const audioFileName = str(
    techDetails[0]?.File?.FileName ||
    techDetails[0]?.AudioFile?.FileName ||
    null
  )
  const wavBuffer = audioFileName ? fileMap[audioFileName.toLowerCase()] : null

  // ERN 4.1 rights
  const rightsCtrl   = toArray(sr.RightsController)[0]
  const pLine        = sr.PLine || release?.PLine
  const cLine        = sr.CLine || release?.CLine
  const rightsHolder = str(
    rightsCtrl?.PartyName?.FullName ||
    pLine?.PLineText ||
    cLine?.CLineText ||
    null
  )
  const rightsYear = parseInt(str(pLine?.Year || extractYear(str(pLine?.PLineText)) || ''), 10) || null

  const parentalWarning = str(sr.ParentalWarningType || release?.ParentalWarningType)
  const explicit = parentalWarning === 'Explicit'

  const genreEl  = sr.Genre
  const genre    = str(genreEl?.GenreText || genreEl || null)
  const subgenre = str(genreEl?.SubGenre || null)

  const deals = toArray(release?.DealList?.ReleaseDeal || [])
  const territories = deals.flatMap(d =>
    toArray(d.Deal?.DealTerms?.TerritoryCode || d.Deal?.TerritoryCode || [])
  ).map(str).filter(Boolean).join(',') || 'WORLDWIDE'

  const albumTitle  = str(release?.ReferenceTitle?.TitleText || null)
  const releaseDate = str(sr.CreationDate || release?.ReleaseDate || null)
  const year        = extractYear(releaseDate)
  const trackNumber = parseInt(str(sr.SequenceNumber || null), 10) || null
  const language    = str(sr.LanguageOfPerformance || null)

  return {
    _ref:          str(sr.ResourceReference),
    track_title:   getTitle41(sr),
    version_title: getVersionTitle41(sr),
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
    c.Role ||
    null
  )
  const ipi   = str(c.ProprietaryId?.ProprietaryId || null)
  const share = parseFloat(str(c.HasRightShare || null)) || null
  return { name, role, pro_ipi: ipi, share_pct: share }
}
