/**
 * lib/ddex-generate.js
 * Generate a DDEX ERN 3.8.2 NewReleaseMessage XML from track metadata.
 */

const SENDER_PARTY_ID = process.env.DDEX_SENDER_PARTY_ID || 'PA-DPIDA-2022040506-W'
const SENDER_NAME     = process.env.DDEX_SENDER_NAME     || 'The Gallo Record Company Vault'
const LABEL_NAME      = process.env.DDEX_LABEL_NAME      || 'The Gallo Record Company Vault'

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function secsToDuration(secs) {
  if (!secs) return 'PT0H0M0S'
  const s = Math.round(Number(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `PT${h}H${m}M${r}S`
}


function msgId() {
  return Date.now().toString() + Math.floor(Math.random() * 10000)
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/**
 * Generate ERN 3.8.2 XML.
 * @param {object[]} tracks - array of track metadata objects
 * @param {object}   album  - { title, artist, catalogue_no, barcode, year, genre, artwork_filename }
 * @param {object}   recipient - { partyId, name } — where the package is being sent
 * @returns {string} XML string
 */
export function generateDDEX382(tracks, album, recipient = {}) {
  const id = msgId()
  const sorted = [...tracks].sort((a, b) => (a.sequence_no || 999) - (b.sequence_no || 999))

  // Resource references: A1, A2, …
  const refs = sorted.map((_, i) => `A${i + 1}`)

  // ── Helpers ────────────────────────────────────────────────────────────────
  const recipientPartyId = esc(recipient.partyId || 'UNKNOWN')
  const recipientName    = esc(recipient.name    || 'Recipient')

  // ── ResourceList ───────────────────────────────────────────────────────────
  const resources = sorted.map((t, i) => {
    const ref      = refs[i]
    const techRef  = `T${i + 1}`
    const filename = t.audio_filename || `${esc(t.isrc || ref)}.wav`
    const explicit = t.explicit ? 'Explicit' : 'NotExplicit'

    return `
    <SoundRecording>
      <SoundRecordingType>MusicalWorkSoundRecording</SoundRecordingType>
      <SoundRecordingId>
        <ISRC>${esc(t.isrc)}</ISRC>
      </SoundRecordingId>
      <ResourceReference>${ref}</ResourceReference>
      <ReferenceTitle>
        <TitleText>${esc(t.title)}</TitleText>
      </ReferenceTitle>
      <Duration>${secsToDuration(t.duration_sec)}</Duration>
      <SoundRecordingDetailsByTerritory>
        <TerritoryCode>Worldwide</TerritoryCode>
        <Title>
          <TitleText>${esc(t.title)}</TitleText>
        </Title>
        <DisplayArtist SequenceNumber="1">
          <PartyName>
            <FullName>${esc(t.artist_name || album.artist)}</FullName>
          </PartyName>
          <ArtistRole>MainArtist</ArtistRole>
        </DisplayArtist>
        <LabelName>${esc(LABEL_NAME)}</LabelName>
        <PLine>
          <Year>${esc(t.year || album.year)}</Year>
          <PLineText>(P) ${esc(t.year || album.year)} ${esc(LABEL_NAME)}</PLineText>
        </PLine>
        ${t.genre || album.genre ? `<Genre><GenreText>${esc(t.genre || album.genre)}</GenreText></Genre>` : ''}
        ${t.language ? `<LanguageOfPerformance>${esc(t.language)}</LanguageOfPerformance>` : ''}
        <ParentalWarningType>${explicit}</ParentalWarningType>
        <TechnicalSoundRecordingDetails>
          <TechnicalResourceDetailsReference>${techRef}</TechnicalResourceDetailsReference>
          <AudioCodecType>PCM</AudioCodecType>
          <File>
            <FileName>${esc(filename)}</FileName>
            <FilePath>resources/</FilePath>
          </File>
        </TechnicalSoundRecordingDetails>
      </SoundRecordingDetailsByTerritory>
    </SoundRecording>`
  }).join('\n')

  // ── Image resource (artwork) ───────────────────────────────────────────────
  const artworkResource = album.artwork_filename ? `
    <Image>
      <ImageType>FrontCoverImage</ImageType>
      <ImageId>
        <ProprietaryId Namespace="${esc(SENDER_PARTY_ID)}">${esc(album.catalogue_no)}_artwork</ProprietaryId>
      </ImageId>
      <ResourceReference>ARTWORK</ResourceReference>
      <ReferenceTitle>
        <TitleText>${esc(album.title)} Cover</TitleText>
      </ReferenceTitle>
      <ImageDetailsByTerritory>
        <TerritoryCode>Worldwide</TerritoryCode>
        <TechnicalImageDetails>
          <TechnicalResourceDetailsReference>TART</TechnicalResourceDetailsReference>
          <File>
            <FileName>${esc(album.artwork_filename)}</FileName>
            <FilePath>resources/</FilePath>
          </File>
        </TechnicalImageDetails>
      </ImageDetailsByTerritory>
    </Image>` : ''

  // ── Main album release ─────────────────────────────────────────────────────
  const allResourceRefs = refs.map(r =>
    `<ReleaseResourceReference ReleaseResourceType="PrimaryResource">${r}</ReleaseResourceReference>`
  ).join('\n        ')

  const mainRelease = `
    <Release IsMainRelease="true">
      <ReleaseId>
        ${album.barcode     ? `<ICPN>${esc(album.barcode)}</ICPN>` : ''}
        ${album.catalogue_no ? `<CatalogNumber Namespace="${esc(SENDER_PARTY_ID)}">${esc(album.catalogue_no)}</CatalogNumber>` : ''}
      </ReleaseId>
      <ReleaseReference>R0</ReleaseReference>
      <ReferenceTitle>
        <TitleText>${esc(album.title)}</TitleText>
      </ReferenceTitle>
      <ReleaseResourceReferenceList>
        ${allResourceRefs}
        ${album.artwork_filename ? '<ReleaseResourceReference ReleaseResourceType="SecondaryResource">ARTWORK</ReleaseResourceReference>' : ''}
      </ReleaseResourceReferenceList>
      <ReleaseType>Album</ReleaseType>
      <ReleaseDetailsByTerritory>
        <TerritoryCode>Worldwide</TerritoryCode>
        <DisplayArtistName>${esc(album.artist)}</DisplayArtistName>
        <LabelName>${esc(LABEL_NAME)}</LabelName>
        ${album.genre ? `<Genre><GenreText>${esc(album.genre)}</GenreText></Genre>` : ''}
        <ParentalWarningType>NotExplicit</ParentalWarningType>
        ${album.year ? `<ReleaseDate>${esc(album.year)}</ReleaseDate>` : ''}
      </ReleaseDetailsByTerritory>
    </Release>`

  // ── Track releases ─────────────────────────────────────────────────────────
  const trackReleases = sorted.map((t, i) => `
    <Release>
      <ReleaseId>
        <ISRC>${esc(t.isrc)}</ISRC>
      </ReleaseId>
      <ReleaseReference>R${i + 1}</ReleaseReference>
      <ReferenceTitle>
        <TitleText>${esc(t.title)}</TitleText>
      </ReferenceTitle>
      <ReleaseResourceReferenceList>
        <ReleaseResourceReference>${refs[i]}</ReleaseResourceReference>
      </ReleaseResourceReferenceList>
      <ReleaseType>TrackRelease</ReleaseType>
      <ReleaseDetailsByTerritory>
        <TerritoryCode>Worldwide</TerritoryCode>
        <DisplayArtistName>${esc(t.artist_name || album.artist)}</DisplayArtistName>
        <LabelName>${esc(LABEL_NAME)}</LabelName>
        ${t.genre || album.genre ? `<Genre><GenreText>${esc(t.genre || album.genre)}</GenreText></Genre>` : ''}
        <ParentalWarningType>${t.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>
        ${t.sequence_no ? `<SequenceNumber>${t.sequence_no}</SequenceNumber>` : ''}
      </ReleaseDetailsByTerritory>
    </Release>`).join('\n')

  // ── Deal ──────────────────────────────────────────────────────────────────
  const deal = `
    <ReleaseDeal>
      <DealReleaseReference>R0</DealReleaseReference>
      <Deal>
        <DealTerms>
          <CommercialModelType>PayAsYouGoModel</CommercialModelType>
          <Usage>
            <UseType>OnDemandStream</UseType>
            <UseType>PermanentDownload</UseType>
          </Usage>
          <TerritoryCode>Worldwide</TerritoryCode>
          <ValidityPeriod>
            <StartDate>${album.year || new Date().getFullYear()}-01-01</StartDate>
          </ValidityPeriod>
        </DealTerms>
      </Deal>
    </ReleaseDeal>`

  // ── Assemble ──────────────────────────────────────────────────────────────
  return `<?xml version="1.0" encoding="UTF-8"?>
<NewReleaseMessage MessageSchemaVersionId="ern/382"
  xmlns="http://ddex.net/xml/ern/382"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <MessageHeader xmlns="">
    <MessageThreadId>${id}</MessageThreadId>
    <MessageId>${id}</MessageId>
    <MessageSender>
      <PartyId>${esc(SENDER_PARTY_ID)}</PartyId>
      <PartyName>
        <FullName>${esc(SENDER_NAME)}</FullName>
      </PartyName>
    </MessageSender>
    <MessageRecipient>
      <PartyId>${recipientPartyId}</PartyId>
      <PartyName>
        <FullName>${recipientName}</FullName>
      </PartyName>
    </MessageRecipient>
    <MessageCreatedDateTime>${isoNow()}</MessageCreatedDateTime>
    <MessageControlType>LiveMessage</MessageControlType>
  </MessageHeader>
  <UpdateIndicator xmlns="">OriginalMessage</UpdateIndicator>
  <ResourceList xmlns="">
    ${resources}
    ${artworkResource}
  </ResourceList>
  <ReleaseList xmlns="">
    ${mainRelease}
    ${trackReleases}
  </ReleaseList>
  <DealList xmlns="">
    ${deal}
  </DealList>
</NewReleaseMessage>`
}
