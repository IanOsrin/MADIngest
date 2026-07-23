/**
 * lib/ddex-build.js
 * Build a DDEX ERN 3.8.2 NewReleaseMessage XML in the canonical Ingrooves shape.
 *
 * Models the structure of Gallo's previously-accepted Ingrooves deliveries
 * (see Snake_Uyakitazeka, Soul Gang_Lindi as reference samples).
 *
 * The generator does NOT touch disk — it returns:
 *   { xml, audioFiles: [{filename, buffer, md5}], artwork: {filename, buffer, md5} }
 * The caller is responsible for writing to <UPC>/<UPC>.xml + <UPC>/resources/.
 */

import crypto from 'crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

const SENDER_PARTY_ID    = process.env.DDEX_SENDER_PARTY_ID    || 'PA-DPIDA-2022040506-W'
const SENDER_PARTY_NAME  = process.env.DDEX_SENDER_NAME        || 'The Gallo Record Company Vault'
const SENDER_LABEL_NAME  = process.env.DDEX_LABEL_NAME         || 'The Gallo Record Company Vault'

const RECIPIENT_PARTY_ID   = process.env.DDEX_INGROOVES_PARTY_ID   || 'PADPIDA2011092301N'
const RECIPIENT_PARTY_NAME = process.env.DDEX_INGROOVES_PARTY_NAME || 'INgrooves'

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a DDEX package ready to write to disk.
 *
 * @param {object}   args
 * @param {object[]} args.tracks    — track objects from FM (see fm-gallo mapGalloRecord)
 * @param {Buffer[]} args.audioBufs — audio file buffers, one per track, same order as tracks
 * @param {Buffer}   args.artworkBuf — artwork file buffer (jpg)
 * @param {string}  [args.artworkExt='jpg']
 * @param {object}  [args.overrides] — manual overrides for any computed field
 * @returns {{ xml: string, files: Array<{path:string, buffer:Buffer}>, validation: object }}
 */
/**
 * PLAN — derive all album/track/artwork metadata (sort order, filenames, refs,
 * durations) WITHOUT needing the audio bytes. This lets a caller learn the
 * output filenames up front and stream each WAV straight to disk, instead of
 * buffering ~500 MB of 24-bit audio in memory (which OOMs a small dyno).
 * Returns { sorted, album, artwork, albumDuration }. _md5 is filled later.
 */
export function planDdex({ tracks, overrides = {}, artworkExt = 'jpg' }) {
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('No tracks supplied')

  const sorted = tracks
    .map((t, i) => ({ ...t, _origIdx: i }))
    .sort((a, b) => (a.sequence_no || a._origIdx + 1) - (b.sequence_no || b._origIdx + 1))

  const head = sorted[0]
  const validYear = /^\d{4}$/.test(String(head.year || '').trim()) ? String(head.year).trim() : null
  if (!validYear) throw new Error(`Cannot build XML: track Year "${head.year}" is not a 4-digit year`)

  const album = {
    title:           overrides.album_title     || head.album_title,
    artist:          overrides.album_artist    || head.album_artist || head.artist_name,
    barcode:         overrides.barcode         || head.barcode,
    catalogue_no:    overrides.catalogue_no    || head.catalogue_no,
    label:           overrides.label           || head.label || SENDER_LABEL_NAME,
    pline_text:      overrides.pline_text      || head.pline_text || `(P) ${validYear} ${SENDER_LABEL_NAME}`,
    cline_text:      overrides.cline_text      || head.cline_text || `(C) ${validYear} ${SENDER_LABEL_NAME}`,
    pline_year:      overrides.pline_year      || validYear,
    cline_year:      overrides.cline_year      || validYear,
    genre:           overrides.genre           || head.genre,
    sub_genre:       overrides.sub_genre       || head.sub_genre,
    language:        overrides.language        || head.language,
    original_release_date: overrides.original_release_date || normaliseDate(head.original_release_date) || `${validYear}-01-01`,
    release_date:    overrides.release_date    || normaliseDate(head.release_date) || todayISODate(),
    territory:       overrides.territory       || 'Worldwide',
    image_asset:     overrides.image_asset     || head.image_asset_number || `IMG_${(head.catalogue_no || head.barcode).replace(/[^a-zA-Z0-9_\-.]/g, '_')}`,
    explicit:        overrides.explicit ?? sorted.some(t => t.explicit),
  }

  sorted.forEach((t, i) => {
    t._asset = (t.asset_number || `${album.catalogue_no || 'TRK'}_${pad(t.sequence_no || i+1, 3)}`).replace(/\s+/g, '')
    t._wavFilename = t.wav_filename && /\.wav$/i.test(t.wav_filename) ? t.wav_filename : `${t._asset}.wav`
    t._resourceRef = t.resource_reference || `A${t._asset}`
    t._techRef     = t.technical_resource || `T${t._asset}`
    t._releaseRef  = `R${i + 1}`
    t._duration    = t.duration_sec ? secsToISODuration(t.duration_sec) : null
  })

  const artwork = {
    asset:    album.image_asset,
    filename: `${album.image_asset}.${artworkExt.replace(/^\./, '')}`,
    ref:      `A${album.image_asset}`,
    techRef:  `T${album.image_asset}`,
  }

  const albumDuration = secsToISODuration(sorted.reduce((s, t) => s + (t.duration_sec || 0), 0))
  return { sorted, album, artwork, albumDuration }
}

/** Metadata-only validation (no audio bytes needed) — run before downloading. */
export function validateDdexMeta(sorted) {
  return validateMetaChecks(sorted)
}

/** Audio/artwork validation from sizes + magic bytes captured while streaming. */
export function validateDdexAudio(audioInfo, artworkInfo) {
  const errors = [], warnings = []
  audioInfo.forEach((a, i) => {
    if (!a || !a.byteSize) { errors.push(`Track ${i+1} audio file is missing or empty`); return }
    if (a.riffOk === false) warnings.push(`Track ${i+1} doesn't look like a RIFF/WAVE file (continuing anyway)`)
  })
  if (!artworkInfo || !artworkInfo.byteSize) errors.push('Artwork is missing or empty')
  else if (artworkInfo.jpegOk === false) warnings.push('Artwork does not look like a JPEG (continuing anyway)')
  return { errors, warnings }
}

/** Render the DDEX XML from a plan whose tracks already carry _md5 + artwork.md5. */
export function renderDdexPackageXml({ sorted, album, artwork, albumDuration }) {
  return renderDdexXml({ sorted, album, artwork, albumDuration })
}

export function buildDdexPackage({ tracks, audioBufs, artworkBuf, artworkExt = 'jpg', overrides = {} }) {
  if (!Array.isArray(audioBufs) || audioBufs.length !== tracks.length) {
    throw new Error(`audioBufs length (${audioBufs?.length}) must match tracks length (${tracks.length})`)
  }
  if (!Buffer.isBuffer(artworkBuf)) throw new Error('artworkBuf is required (front cover)')

  const { sorted, album, artwork, albumDuration } = planDdex({ tracks, overrides, artworkExt })

  const validation = validatePackage(sorted, audioBufs, artworkBuf)
  if (validation.errors.length > 0) {
    const err = new Error(`DDEX validation failed:\n  - ${validation.errors.join('\n  - ')}`)
    err.validation = validation
    throw err
  }

  sorted.forEach((t) => {
    t._md5 = (t.audio_hash_md5 && /^[A-Fa-f0-9]{32}$/.test(t.audio_hash_md5))
               ? t.audio_hash_md5.toUpperCase()
               : md5Hex(audioBufs[t._origIdx])
    t._buffer = audioBufs[t._origIdx]
  })
  artwork.md5 = md5Hex(artworkBuf)
  artwork.buffer = artworkBuf

  const xml = renderDdexXml({ sorted, album, artwork, albumDuration })
  const files = [
    ...sorted.map(t => ({ path: `resources/${t._wavFilename}`, buffer: t._buffer })),
    { path: `resources/${artwork.filename}`, buffer: artworkBuf },
  ]
  return { xml, files, validation, album, tracks: sorted, artwork }
}

// ── Validation ────────────────────────────────────────────────────────────────

// Metadata-only checks (1–4b, 6) — no audio bytes required.
function validateMetaChecks(tracks) {
  const errors = []
  const warnings = []

  // 1. UPC / barcode — 13 digits
  const upc = (tracks[0].barcode || '').toString().trim()
  if (!/^\d{13}$/.test(upc)) errors.push(`Barcode must be 13 digits, got "${upc}"`)

  // 2. Catalogue number
  if (!tracks[0].catalogue_no) errors.push('Album Catalogue Number is missing')

  // 3. Album title + artist
  if (!tracks[0].album_title) errors.push('Album Title is missing')
  if (!tracks[0].album_artist && !tracks[0].artist_name) errors.push('Album Artist is missing')

  // 4. ISRC: format + uniqueness
  const seenIsrc = new Set()
  tracks.forEach((t, i) => {
    if (!t.isrc) {
      errors.push(`Track ${i+1} ("${t.title}") has no ISRC`)
    } else if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc)) {
      errors.push(`Track ${i+1} ISRC "${t.isrc}" doesn't match the required format`)
    } else if (seenIsrc.has(t.isrc)) {
      errors.push(`Duplicate ISRC across the release: ${t.isrc}`)
    } else {
      seenIsrc.add(t.isrc)
    }
    if (!t.title)        errors.push(`Track ${i+1} has no title`)
    if (!t.artist_name)  errors.push(`Track ${i+1} ("${t.title}") has no Track Artist`)
    if (!t.duration_sec) errors.push(`Track ${i+1} ("${t.title}") has no duration`)
    if (!t.language)     warnings.push(`Track ${i+1} ("${t.title}") has no Language Code`)

    // Year — must be a 4-digit gYear. Anything else (e.g. "12-6") will fail
    // the DDEX XSD type validation and Ingrooves silently rejects the upload.
    if (t.year == null || String(t.year).trim() === '') {
      errors.push(`Track ${i+1} ("${t.title}") has no Year`)
    } else if (!/^\d{4}$/.test(String(t.year).trim())) {
      errors.push(`Track ${i+1} ("${t.title}") has invalid Year "${t.year}" — must be a 4-digit year (e.g. 1996)`)
    }
  })

  // 4b. Album-level dates — must be ISO YYYY-MM-DD or normalisable to one
  const ord = tracks[0].original_release_date
  if (ord && !normaliseDate(ord)) {
    errors.push(`Original Release Date "${ord}" is not a valid date — must be YYYY-MM-DD`)
  }
  const rd = tracks[0].release_date
  if (rd && !normaliseDate(rd)) {
    errors.push(`Release Date "${rd}" is not a valid date — must be YYYY-MM-DD`)
  }

  // 6. Sane track durations
  tracks.forEach((t, i) => {
    if (t.duration_sec) {
      if (t.duration_sec < 30)   warnings.push(`Track ${i+1} ("${t.title}") is only ${t.duration_sec}s long`)
      if (t.duration_sec > 1800) warnings.push(`Track ${i+1} ("${t.title}") is ${Math.round(t.duration_sec/60)} min long — confirm`)
    }
  })

  return { errors, warnings }
}

function validatePackage(tracks, audioBufs, artworkBuf) {
  const meta = validateMetaChecks(tracks)
  const errors = [...meta.errors]
  const warnings = [...meta.warnings]

  // 5. WAV present + readable + non-empty
  audioBufs.forEach((buf, i) => {
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      errors.push(`Track ${i+1} audio file is missing or empty`)
      return
    }
    // RIFF...WAVE magic
    const isRiffWav = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
                   && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
    if (!isRiffWav) warnings.push(`Track ${i+1} buffer doesn't look like a RIFF/WAVE file (continuing anyway)`)
  })

  if (!Buffer.isBuffer(artworkBuf) || artworkBuf.length === 0) {
    errors.push('Artwork buffer is missing or empty')
  } else {
    // JPEG magic FF D8 FF
    const isJpeg = artworkBuf[0] === 0xFF && artworkBuf[1] === 0xD8 && artworkBuf[2] === 0xFF
    if (!isJpeg) warnings.push('Artwork does not look like a JPEG (continuing anyway)')
  }

  return { errors, warnings }
}

// ── XML rendering ─────────────────────────────────────────────────────────────

function renderDdexXml({ sorted, album, artwork, albumDuration }) {
  const messageId = generateMessageId()
  const created   = isoDateTimeWithOffset(new Date())

  const resourcesXml = sorted.map(t => renderSoundRecording(t, album)).join('\n') +
                       '\n' + renderImage(artwork)

  const releaseList = renderMainRelease(sorted, album, artwork, albumDuration) + '\n' +
                      sorted.map(t => renderTrackRelease(t, album)).join('\n')

  const dealList = renderDealList(sorted, album)

  return `<?xml version="1.0" encoding="UTF-8"?>
<NewReleaseMessage xmlns="http://ddex.net/xml/ern/382" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" MessageSchemaVersionId="ern/382">
  <MessageHeader xmlns="">
    <MessageThreadId>${esc(messageId)}</MessageThreadId>
    <MessageId>${esc(messageId)}</MessageId>
    <MessageSender>
      <PartyId>${esc(SENDER_PARTY_ID)}</PartyId>
      <PartyName>
        <FullName>${esc(SENDER_PARTY_NAME)}</FullName>
      </PartyName>
    </MessageSender>
    <MessageRecipient>
      <PartyId>${esc(RECIPIENT_PARTY_ID)}</PartyId>
      <PartyName>
        <FullName>${esc(RECIPIENT_PARTY_NAME)}</FullName>
      </PartyName>
    </MessageRecipient>
    <MessageCreatedDateTime>${esc(created)}</MessageCreatedDateTime>
    <MessageControlType>LiveMessage</MessageControlType>
  </MessageHeader>
  <UpdateIndicator xmlns="">OriginalMessage</UpdateIndicator>
  <ResourceList xmlns="">
${indent(resourcesXml, 4)}
  </ResourceList>
  <ReleaseList xmlns="">
${indent(releaseList, 4)}
  </ReleaseList>
  <DealList xmlns="">
${indent(dealList, 4)}
  </DealList>
</NewReleaseMessage>`
}

function renderSoundRecording(t, album) {
  // Performing Rights Organisation suffix — appended inside the publisher's
  // FullName per Ingrooves convention: e.g. "Gallo Music Publishers [SAMRO]".
  // Note: NOT a separate IndirectResourceContributor — DDEX 3.8.2's role
  // enumeration doesn't include "PerformingRightsOrganization", so the XSD
  // validator rejects that approach. Override via PRO_NAME env var; set to
  // empty string to disable the suffix entirely.
  const proName   = (process.env.PRO_NAME ?? 'SAMRO').trim()
  const proSuffix = proName ? ` [${proName}]` : ''

  const composers  = (t.composers  || []).map(name => renderIndirectContributor(name, 'Composer'))
  const rawPubs    = (t.publishers || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
  // If no publishers came through from FM, emit a single "Copyright Control"
  // placeholder so the PRO suffix still appears somewhere (matches Ingrooves
  // sample pattern). If you'd rather omit publishers entirely when absent,
  // remove the fallback below.
  const pubs       = rawPubs.length ? rawPubs : ['Copyright Control']
  const publishers = pubs.map(name => renderIndirectContributor(name + proSuffix, 'MusicPublisher'))
  const producers  = (t.producers  || []).map((name, i) => renderResourceContributor(name, 'Producer', i+1))

  const indirect = [...publishers, ...composers].join('\n')
  const direct   = producers.join('\n')

  const pYear = t.year || album.pline_year
  const pText = t.pline_text || `(P) ${pYear} ${album.label || SENDER_LABEL_NAME}`
  const territoryCode = album.territory

  return `<SoundRecording>
  <SoundRecordingType>MusicalWorkSoundRecording</SoundRecordingType>
  <SoundRecordingId>
    <ISRC>${esc(t.isrc)}</ISRC>
    <ProprietaryId Namespace="DPID:${esc(SENDER_PARTY_ID)}">${esc(t._asset)}</ProprietaryId>
  </SoundRecordingId>
  <ResourceReference>${esc(t._resourceRef)}</ResourceReference>
  <ReferenceTitle>
    <TitleText>${esc(t.title)}</TitleText>
  </ReferenceTitle>
${t.language ? `  <LanguageOfPerformance>${esc(t.language)}</LanguageOfPerformance>` : ''}
  <Duration>${esc(t._duration)}</Duration>
  <SoundRecordingDetailsByTerritory>
    <TerritoryCode>${esc(territoryCode)}</TerritoryCode>
    <Title>
      <TitleText>${esc(t.title)}</TitleText>
    </Title>
    <DisplayArtist SequenceNumber="1">
      <PartyName>
        <FullName>${esc(t.artist_name)}</FullName>
      </PartyName>
      <ArtistRole>MainArtist</ArtistRole>
    </DisplayArtist>
${direct ? indent(direct, 4) : ''}
${indirect ? indent(indirect, 4) : ''}
    <LabelName>${esc(album.label || SENDER_LABEL_NAME)}</LabelName>
    <PLine>
      <Year>${esc(pYear)}</Year>
      <PLineText>${esc(pText)}</PLineText>
    </PLine>
    <Genre>
      <GenreText>${esc(t.genre || album.genre)}</GenreText>
    </Genre>
    <ParentalWarningType>${t.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>
    <TechnicalSoundRecordingDetails>
      <TechnicalResourceDetailsReference>${esc(t._techRef)}</TechnicalResourceDetailsReference>
      <AudioCodecType>PCM</AudioCodecType>
      <BitRate>2116</BitRate>
      <NumberOfChannels>2</NumberOfChannels>
      <IsPreview>false</IsPreview>
      <File>
        <FileName>${esc(t._wavFilename)}</FileName>
        <FilePath>resources/</FilePath>
        <HashSum>
          <HashSum>${esc(t._md5)}</HashSum>
          <HashSumAlgorithmType>MD5</HashSumAlgorithmType>
        </HashSum>
      </File>
    </TechnicalSoundRecordingDetails>
  </SoundRecordingDetailsByTerritory>
</SoundRecording>`.replace(/^[ \t]*\n/gm, '') // strip blank lines from optional blocks
}

function renderResourceContributor(name, role, seq) {
  return `<ResourceContributor SequenceNumber="${seq}">
  <PartyName>
    <FullName>${esc(name)}</FullName>
  </PartyName>
  <ResourceContributorRole>${esc(role)}</ResourceContributorRole>
  <PrimaryRole>${esc(role)}</PrimaryRole>
</ResourceContributor>`
}

function renderIndirectContributor(name, role) {
  return `<IndirectResourceContributor>
  <PartyName>
    <FullName>${esc(name)}</FullName>
  </PartyName>
  <IndirectResourceContributorRole>${esc(role)}</IndirectResourceContributorRole>
</IndirectResourceContributor>`
}

function renderImage(art) {
  return `<Image>
  <ImageType>FrontCoverImage</ImageType>
  <ImageId>
    <ProprietaryId Namespace="DPID:${esc(SENDER_PARTY_ID)}">${esc(art.asset)}</ProprietaryId>
  </ImageId>
  <ResourceReference>${esc(art.ref)}</ResourceReference>
  <ImageDetailsByTerritory>
    <TerritoryCode>Worldwide</TerritoryCode>
    <TechnicalImageDetails>
      <TechnicalResourceDetailsReference>${esc(art.techRef)}</TechnicalResourceDetailsReference>
      <ImageCodecType>JPEG</ImageCodecType>
      <File>
        <FileName>${esc(art.filename)}</FileName>
        <FilePath>resources/</FilePath>
        <HashSum>
          <HashSum>${esc(art.md5)}</HashSum>
          <HashSumAlgorithmType>MD5</HashSumAlgorithmType>
        </HashSum>
      </File>
    </TechnicalImageDetails>
  </ImageDetailsByTerritory>
</Image>`
}

function renderMainRelease(sorted, album, artwork, albumDuration) {
  const refs = sorted
    .map(t => `<ReleaseResourceReference ReleaseResourceType="PrimaryResource">${esc(t._resourceRef)}</ReleaseResourceReference>`)
    .join('\n')

  const items = sorted.map(t =>
    `<ResourceGroupContentItem>
  <SequenceNumber>${t.sequence_no || sorted.indexOf(t)+1}</SequenceNumber>
  <ResourceType>SoundRecording</ResourceType>
  <ReleaseResourceReference>${esc(t._resourceRef)}</ReleaseResourceReference>
</ResourceGroupContentItem>`
  ).join('\n')

  const proprietaryAlbum = album.barcode || album.catalogue_no || ''

  return `<Release IsMainRelease="true">
  <ReleaseId>
    <ICPN>${esc(album.barcode)}</ICPN>
    <CatalogNumber Namespace="DPID:${esc(SENDER_PARTY_ID)}">${esc(album.catalogue_no)}</CatalogNumber>
    <ProprietaryId Namespace="DPID:${esc(SENDER_PARTY_ID)}">Vnum${esc(proprietaryAlbum)}</ProprietaryId>
  </ReleaseId>
  <ReleaseReference>R0</ReleaseReference>
  <ReferenceTitle>
    <TitleText>${esc(album.title)}</TitleText>
  </ReferenceTitle>
  <ReleaseResourceReferenceList>
${indent(refs, 4)}
    <ReleaseResourceReference ReleaseResourceType="SecondaryResource">${esc(artwork.ref)}</ReleaseResourceReference>
  </ReleaseResourceReferenceList>
  <ReleaseType>Album</ReleaseType>
  <ReleaseDetailsByTerritory>
    <TerritoryCode>${esc(album.territory)}</TerritoryCode>
    <DisplayArtistName>${esc(album.artist)}</DisplayArtistName>
    <LabelName LabelNameType="DisplayLabelName">${esc(album.label || SENDER_LABEL_NAME)}</LabelName>
    <Title TitleType="FormalTitle">
      <TitleText>${esc(album.title)}</TitleText>
    </Title>
    <Title TitleType="DisplayTitle">
      <TitleText>${esc(album.title)}</TitleText>
    </Title>
    <DisplayArtist SequenceNumber="1">
      <PartyName>
        <FullName>${esc(album.artist)}</FullName>
      </PartyName>
      <ArtistRole>MainArtist</ArtistRole>
    </DisplayArtist>
    <ParentalWarningType>${album.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>
    <ResourceGroup>
      <ResourceGroup>
        <Title>
          <TitleText>Disc 1</TitleText>
        </Title>
        <SequenceNumber>1</SequenceNumber>
${indent(items, 8)}
      </ResourceGroup>
      <ResourceGroupContentItem>
        <SequenceNumber>${sorted.length + 1}</SequenceNumber>
        <ResourceType>Image</ResourceType>
        <ReleaseResourceReference>${esc(artwork.ref)}</ReleaseResourceReference>
      </ResourceGroupContentItem>
    </ResourceGroup>
    <Genre>
      <GenreText>${esc(album.genre)}</GenreText>
    </Genre>
    <ReleaseDate>${esc(todayISODate())}</ReleaseDate>
    <OriginalReleaseDate>${esc(album.original_release_date)}</OriginalReleaseDate>
  </ReleaseDetailsByTerritory>
  <Duration>${esc(albumDuration)}</Duration>
  <PLine>
    <Year>${esc(album.pline_year)}</Year>
    <PLineText>${esc(album.pline_text)}</PLineText>
  </PLine>
  <CLine>
    <Year>${esc(album.cline_year)}</Year>
    <CLineText>${esc(album.cline_text)}</CLineText>
  </CLine>
</Release>`
}

function renderTrackRelease(t, album) {
  const pYear = t.year || album.pline_year
  const cYear = t.year || album.cline_year
  const pText = t.pline_text || `(P) ${pYear} ${album.label || SENDER_LABEL_NAME}`
  const cText = t.cline_text || `(C) ${cYear} ${album.label || SENDER_LABEL_NAME}`

  return `<Release>
  <ReleaseId>
    <ISRC>${esc(t.isrc)}</ISRC>
  </ReleaseId>
  <ReleaseReference>${esc(t._releaseRef)}</ReleaseReference>
  <ReferenceTitle>
    <TitleText>${esc(t.title)}</TitleText>
  </ReferenceTitle>
  <ReleaseResourceReferenceList>
    <ReleaseResourceReference>${esc(t._resourceRef)}</ReleaseResourceReference>
  </ReleaseResourceReferenceList>
  <ReleaseType>TrackRelease</ReleaseType>
  <ReleaseDetailsByTerritory>
    <TerritoryCode>${esc(album.territory)}</TerritoryCode>
    <DisplayArtistName>${esc(t.artist_name)}</DisplayArtistName>
    <LabelName>${esc(album.label || SENDER_LABEL_NAME)}</LabelName>
    <Title TitleType="FormalTitle">
      <TitleText>${esc(t.title)}</TitleText>
    </Title>
    <Title TitleType="DisplayTitle">
      <TitleText>${esc(t.title)}</TitleText>
    </Title>
    <DisplayArtist SequenceNumber="1">
      <PartyName>
        <FullName>${esc(t.artist_name)}</FullName>
      </PartyName>
      <ArtistRole>MainArtist</ArtistRole>
    </DisplayArtist>
    <ParentalWarningType>${t.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>
    <ResourceGroup>
      <SequenceNumber>1</SequenceNumber>
      <ResourceGroupContentItem>
        <SequenceNumber>1</SequenceNumber>
        <ResourceType>SoundRecording</ResourceType>
        <ReleaseResourceReference>${esc(t._resourceRef)}</ReleaseResourceReference>
      </ResourceGroupContentItem>
    </ResourceGroup>
    <Genre>
      <GenreText>${esc(t.genre || album.genre)}</GenreText>
    </Genre>
  </ReleaseDetailsByTerritory>
  <Duration>${esc(t._duration)}</Duration>
  <PLine>
    <Year>${esc(pYear)}</Year>
    <PLineText>${esc(pText)}</PLineText>
  </PLine>
  <CLine>
    <Year>${esc(cYear)}</Year>
    <CLineText>${esc(cText)}</CLineText>
  </CLine>
</Release>`
}

function renderDealList(sorted, album) {
  const start = album.release_date

  const albumDeal = `<ReleaseDeal>
  <DealReleaseReference>R0</DealReleaseReference>
  <Deal>
    <DealTerms>
      <CommercialModelType>SubscriptionModel</CommercialModelType>
      <Usage>
        <UseType>Stream</UseType>
        <UseType>ConditionalDownload</UseType>
      </Usage>
      <TerritoryCode>${esc(album.territory)}</TerritoryCode>
      <ValidityPeriod>
        <StartDate>${esc(start)}</StartDate>
      </ValidityPeriod>
    </DealTerms>
  </Deal>
  <EffectiveDate>${esc(start)}</EffectiveDate>
</ReleaseDeal>`

  const trackRefs = sorted.map(t => `<DealReleaseReference>${esc(t._releaseRef)}</DealReleaseReference>`).join('\n  ')

  const trackDeal = `<ReleaseDeal>
  ${trackRefs}
  <Deal>
    <DealTerms>
      <CommercialModelType>AdvertisementSupportedModel</CommercialModelType>
      <Usage>
        <UseType>Stream</UseType>
      </Usage>
      <TerritoryCode>${esc(album.territory)}</TerritoryCode>
      <ValidityPeriod>
        <StartDate>${esc(start)}</StartDate>
      </ValidityPeriod>
    </DealTerms>
  </Deal>
  <Deal>
    <DealTerms>
      <CommercialModelType>SubscriptionModel</CommercialModelType>
      <Usage>
        <UseType>Stream</UseType>
        <UseType>ConditionalDownload</UseType>
      </Usage>
      <TerritoryCode>${esc(album.territory)}</TerritoryCode>
      <ValidityPeriod>
        <StartDate>${esc(start)}</StartDate>
      </ValidityPeriod>
    </DealTerms>
  </Deal>
  <EffectiveDate>${esc(start)}</EffectiveDate>
</ReleaseDeal>`

  return `${albumDeal}\n${trackDeal}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function pad(n, w) { return String(n).padStart(w, '0') }

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex').toUpperCase()
}

function secsToISODuration(secs) {
  if (!secs && secs !== 0) return null
  const total = Math.round(Number(secs))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  // ISO 8601 durations don't allow leading zeros on integer components.
  // Ingrooves rejected files with "PT0H4M02S" — fixed to "PT0H4M2S".
  return `PT${h}H${m}M${s}S`
}

function todayISODate() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth()+1, 2)}-${pad(d.getDate(), 2)}`
}

function isoDateTimeWithOffset(d) {
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(tz)/60), 2)
  const mm = pad(Math.abs(tz) % 60, 2)
  return `${d.getFullYear()}-${pad(d.getMonth()+1,2)}-${pad(d.getDate(),2)}` +
         `T${pad(d.getHours(),2)}:${pad(d.getMinutes(),2)}:${pad(d.getSeconds(),2)}${sign}${hh}:${mm}`
}

function generateMessageId() {
  // 17-digit numeric ID that doesn't lead with zero (matches existing Gallo files)
  let s = String(Math.floor(Math.random() * 9) + 1)
  for (let i = 1; i < 17; i++) s += String(Math.floor(Math.random() * 10))
  return s
}

/**
 * Accept date strings like "5/21/2007", "2007-05-21", "2007-21-05", or "21/05/2007"
 * and return canonical ISO YYYY-MM-DD. Returns null if it can't parse.
 */
function normaliseDate(v) {
  if (!v) return null
  const s = String(v).trim()
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) {
    const [_, y, a, b] = m
    // ambiguous: could be YYYY-MM-DD or YYYY-DD-MM. Prefer MM-DD if a<=12.
    const mm = pad(+a, 2), dd = pad(+b, 2)
    return `${y}-${mm}-${dd}`
  }
  // M/D/YYYY  or  D/M/YYYY (Gallo's locale uses M/D/YYYY)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${pad(+m[1], 2)}-${pad(+m[2], 2)}`
  return null
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map(l => l.length ? pad + l : l).join('\n')
}
