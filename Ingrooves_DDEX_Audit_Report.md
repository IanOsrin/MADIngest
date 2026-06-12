# Ingrooves DDEX — Audit & Generator Plan

Audit date: 2026-05-08
Source: 7 sample XMLs supplied (in /uploads)
Target spec: DDEX ERN 3.8.2 → Ingrooves (PartyId `PADPIDA2011092301N`)

---

## 1. The samples are NOT fully compliant

Every one of the seven XMLs has the same two structural defects, plus three of them have bad duration data. None of the sample files would survive a strict Ingrooves XSD/MD validation in their current form.

### 1a. Encoding & XML declaration — affects ALL 7 files

Every file is encoded UTF-16 LE with a BOM (`FF FE …`) and the very first bytes are `<NewReleaseMessage …` — there is **no `<?xml version="1.0" encoding="…"?>` prolog at all**. Ingrooves (and the DDEX schema processor it uses) expects:

```
<?xml version="1.0" encoding="UTF-8"?>
<NewReleaseMessage …>
```

The XSD allows UTF-16, but in practice Ingrooves' loader rejects non-UTF-8 files and rejects files with no prolog. Both must be fixed.

### 1b. Album / track durations are wrong on 3 files

I summed the per-track `<Duration>` values in each file and compared to the album-level `<Duration>` — and to "what a 8–12 track album would plausibly run".

| File | Album says | Sum of tracks | Verdict |
|---|---|---|---|
| Abafana Benjabulo — Ngizokufakela Amehlo | 34m 21s | 34m 21s | ✔ correct |
| Niek Potgieter Gitaar Trio — Verdere Hulde… | 25m 05s | 25m 05s | ✔ correct |
| Snake — Uyakitazeka | 35m 13s | 35m 13s | ✔ correct |
| Soul Gang — Lindi | 30m 01s | 30m 01s | ✔ correct |
| **7th Day Adventist — Lalelani** | **3h 35m 00s** | 39m 35s | ✘ wrong |
| **Gospel Church Choir — Mele Pelo Le Moya** | **2h 10m 00s** | 33m 10s | ✘ wrong |
| **Gwynneth Ashley-Robin — Featuring Little Jimmy** | **3h 23m 00s** | 58m 23s | ✘ wrong |

Looking at the per-track durations on the three bad files, several of them are also implausible (10-second songs, 20-second songs, etc.). This is upstream / FileMaker source data, not a generator bug — but the generator should sanity-check it before emitting.

### 1c. Other minor structural issues observed

- **`ResourceGroup`** in the album release on Snake_Uyakitazeka has the cover image's `<SequenceNumber>` written as `9\n                        ` (newline + spaces inside the element). Whitespace in numeric content tends to fail strict validators. Strip whitespace inside numeric fields.
- **`PLine` on the main `<Release>` block** on Snake (and a few others) has `<PLineText>` but no `<Year>`. The track-level `<PLine>` does have it. Add `<Year>` consistently.
- **No `<ReleaseDate>`** at the album level — only `<OriginalReleaseDate>`. Ingrooves wants both: `<ReleaseDate>` is the commercial release date; `<OriginalReleaseDate>` is the catalog-original. They're often the same value, but both should be present.
- **`MessageThreadId` / `MessageId`** are 17-digit numeric IDs starting with `0` in Snake's file (`03871270433071494`). That's fine, but a leading-zero numeric is a yellow flag for some parsers. Use a UUID or ensure no leading zero.
- **`Niek Potgieter Gitaar Trio` file** has no `<LanguageOfPerformance>` at all (every track). DisplayArtistName is also stored as just `Niek Potgieter` while the formal artist on the deck is the Trio. Decide on a canonical artist name and populate language.

### 1d. What IS correct on all 7 (don't change)

These are the bits that ARE right and that the new generator must preserve:

- ERN 3.8.2 namespace: `http://ddex.net/xml/ern/382` with `MessageSchemaVersionId="ern/382"`.
- `MessageRecipient`: PartyId `PADPIDA2011092301N`, FullName `INgrooves`. ✔ identical across all 7.
- `MessageSender`: PartyId `PA-DPIDA-2022040506-W`, FullName `The Gallo Record Company Vault`.
- `<UpdateIndicator>OriginalMessage</UpdateIndicator>`.
- Resource references use catalog-number form (`AGMVD4226`, `TGMVD4226`) — not generic `A1/T1`. Keep this; it's what the current `ddex-generate.js` does NOT do.
- Each `SoundRecording` carries `ISRC` + `ProprietaryId` + `BitRate` (2116) + `NumberOfChannels` (2) + `IsPreview` + `MD5 HashSum` for the audio file.
- Each `Image` carries `ImageType=FrontCoverImage`, `ProprietaryId`, `ImageCodecType=JPEG`, and an MD5 `HashSum`.
- `<File><FilePath>resources/</FilePath></File>` — files live in a `resources/` subfolder.
- Album release (`IsMainRelease="true"`) carries `ICPN` (UPC), `CatalogNumber`, `ProprietaryId`, both `FormalTitle` + `DisplayTitle`, `LabelNameType="DisplayLabelName"`, `ResourceGroup` (Disc 1) with proper `SequenceNumber` per track.
- A `TrackRelease` block per track, each with its own `PLine` + `CLine`.
- Two `ReleaseDeal` blocks: one for `R0` (album) with `SubscriptionModel`, one covering all `R1..Rn` (tracks) with `AdvertisementSupportedModel` AND `SubscriptionModel`. Worldwide territory.

---

## 2. Per-file findings

| # | File | Tracks | UPC | Cat# | Recipient | Issues |
|---|------|--------|-----|------|-----------|--------|
| 1 | 7th Day Adventist — Lalelani | 10 | 6009555159113 | SJH 125 | INgrooves | UTF-16 + no prolog; **bad durations**; per-track durations also implausible |
| 2 | Abafana Benjabulo — Ngizokufakela Amehlo | 8 | 6009555151315 | KHON 1061 | INgrooves | UTF-16 + no prolog |
| 3 | Gospel Church Choir — Mele Pelo Le Moya | 8 | 6009555164469 | HSH 8033 | INgrooves | UTF-16 + no prolog; **bad durations** |
| 4 | Gwynneth Ashley-Robin — Featuring Little Jimmy | 12 | 6009555164605 | MVC 3597 | INgrooves | UTF-16 + no prolog; **bad durations** |
| 5 | Niek Potgieter Gitaar Trio — Verdere Hulde… | 12 | 6009555171979 | PLS 7025 | INgrooves | UTF-16 + no prolog; **no LanguageOfPerformance**; artist name truncated to "Niek Potgieter" |
| 6 | Snake — Uyakitazeka | 8 | 6009555145185 | MCGMP 40521 | INgrooves | UTF-16 + no prolog; whitespace in `<SequenceNumber>9</SequenceNumber>` of artwork; missing `<Year>` in album-release `<PLine>` |
| 7 | Soul Gang — Lindi | 10 | 6009555174994 | IAL 4019 | INgrooves | UTF-16 + no prolog |

---

## 3. Delivery folder layout (what the generator should emit)

You said no zip. Per Ingrooves' delivery spec, every release should be its own folder named by the UPC, containing the XML at the root and the assets in a `resources/` subfolder:

```
6009555145185/
├── 6009555145185.xml          ← the DDEX message, UTF-8, with prolog
└── resources/
    ├── GMVD4226.wav            ← one .wav per track, named by catalog number
    ├── GMVD4227.wav
    ├── GMVD4228.wav
    ├── … (one per track)
    └── GMVi6506.jpg            ← front cover artwork, named by image catalog id
```

Rules:

- Folder name = UPC / barcode (13-digit `ICPN`).
- XML filename = `<UPC>.xml` (this is what Ingrooves expects when files are dropped onto their inbox).
- Inside the XML, every `<FileName>` references the bare filename (e.g. `GMVD4226.wav`) and `<FilePath>` is `resources/`.
- `.wav` filenames should match the per-track `ProprietaryId` (e.g. `GMVD4226.wav`) — that's the catalogue convention you've been using, and the existing files already match it.
- `.jpg` filename should match the image's `ProprietaryId` (e.g. `GMVi6506.jpg`).
- Hashes inside the XML (`HashSum` MD5) MUST match the bytes of the file actually placed in `resources/`. The current generator doesn't compute these — you have to add it.

The XML file is delivered separately too (as you noted). The generator should write the standalone XML next to the folder OR include it inside the folder — your call. The `<FilePath>resources/</FilePath>` attribute already tells the loader where audio lives, so an XML alongside the folder is fine; an XML inside is also fine and is what your current sample files imply.

---

## 4. What the generator must produce — the canonical Ingrooves shape

Take the working Snake_Uyakitazeka shape as the template and bake it in. Required elements per `<NewReleaseMessage>`:

1. **Prolog**: `<?xml version="1.0" encoding="UTF-8"?>`. UTF-8 only, no BOM.
2. **Root**: `<NewReleaseMessage xmlns="http://ddex.net/xml/ern/382" MessageSchemaVersionId="ern/382" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`.
3. **MessageHeader**: ThreadId, MessageId, Sender (Gallo Vault), Recipient (INgrooves PartyId `PADPIDA2011092301N`), CreatedDateTime ISO-8601 with `+02:00`, `MessageControlType=LiveMessage`.
4. **UpdateIndicator**: `OriginalMessage` (or `UpdateMessage` for re-deliveries).
5. **ResourceList**:
   - One `<SoundRecording>` per track, with: SoundRecordingType=MusicalWorkSoundRecording, ISRC + ProprietaryId, ResourceReference=`A<catalog>`, ReferenceTitle, LanguageOfPerformance, Duration, then a `SoundRecordingDetailsByTerritory` (Worldwide) containing Title, DisplayArtist, ResourceContributor (Producer), IndirectResourceContributor (MusicPublisher + Composer/Author), LabelName, PLine (with Year), Genre, ParentalWarningType, and `TechnicalSoundRecordingDetails` containing AudioCodecType=PCM, BitRate, NumberOfChannels, IsPreview, File (FileName + FilePath=`resources/` + MD5 HashSum).
   - One `<Image>` for the FrontCoverImage with ProprietaryId, ResourceReference=`A<imgcat>`, then `ImageDetailsByTerritory` containing TechnicalImageDetails with ImageCodecType=JPEG and File (FileName + FilePath=`resources/` + MD5 HashSum).
6. **ReleaseList**:
   - Main `<Release IsMainRelease="true">` with ReleaseId (ICPN + CatalogNumber + ProprietaryId), ReferenceTitle, full ReleaseResourceReferenceList (PrimaryResource for each track + SecondaryResource for the artwork), ReleaseType=Album, then ReleaseDetailsByTerritory (Worldwide) containing DisplayArtistName, LabelName w/ `LabelNameType="DisplayLabelName"`, FormalTitle + DisplayTitle, DisplayArtist, ParentalWarningType, ResourceGroup with `Disc 1` wrapping per-track ResourceGroupContentItems, Genre, OriginalReleaseDate. After the territory block: Duration, PLine, CLine. **Add a ReleaseDate** here too.
   - One `<Release>` per track with its own ReleaseId (ISRC), ReleaseReference=`R1..Rn`, ReleaseType=TrackRelease, full ReleaseDetailsByTerritory (with FormalTitle, DisplayTitle, etc.), Duration, PLine, CLine.
7. **DealList**:
   - `<ReleaseDeal>` for `R0` with `SubscriptionModel` deal, Worldwide, StartDate=today (or release date).
   - `<ReleaseDeal>` listing all `R1..Rn` with TWO `<Deal>` blocks: AdvertisementSupportedModel (Stream) and SubscriptionModel (Stream + ConditionalDownload). Worldwide. EffectiveDate.

Validation gates the generator should run before writing the XML:

- Sum-of-track-duration vs album-Duration sanity check (warn if delta > a few seconds).
- Reject any track with a `Duration` < 30 s or > 30 min unless the user explicitly overrides.
- Verify every `<FileName>` referenced in the XML has a matching file in the resources buffer; reject otherwise.
- Compute MD5 of each audio + image file and write it into `<HashSum>`.
- Verify ISRC matches `^[A-Z]{2}[A-Z0-9]{3}\d{7}$`.
- Verify ICPN is 13 digits, CatalogNumber not blank.
- Reject if LanguageOfPerformance missing on any track (Niek Potgieter case).

---

## 5. What needs to change in the existing code

`lib/ddex-generate.js` (the current generator) is missing all of this. The current output:

- Uses generic `A1/A2…` ResourceReferences instead of catalog-derived `A<cat>`.
- Has no MD5 HashSum, no BitRate, no NumberOfChannels, no IsPreview.
- Has no ProprietaryId on SoundRecordings, no ProprietaryId on Image, no ProprietaryId on Release.
- Doesn't emit FormalTitle + DisplayTitle inside ReleaseDetailsByTerritory.
- Doesn't emit `LabelNameType="DisplayLabelName"`.
- Doesn't emit `<ResourceGroup>` (Disc 1) — Ingrooves needs this.
- Emits a single trivial `<ReleaseDeal>` with `PayAsYouGoModel` instead of the two-deal Subscription + AdSupported pattern Ingrooves expects.
- No `OriginalReleaseDate`, no `CLine` on releases.
- No producer / composer / publisher contributors in SoundRecording.
- Uses `Worldwide` capitalised correctly — fine.
- Uses TerritoryCode `Worldwide` — fine — but doesn't fall through to per-territory deal blocks.

`routes/ingest.js` (the export endpoint) also needs work:

- It currently builds a ZIP and streams it. You said no ZIP — change to write a folder on disk (or stream a tar, or stream a single file plus a sibling resources/ folder). Easiest: write to a configurable output directory (e.g. `DDEX_OUTPUT_DIR` env var, default `./tmp/ddex-out/<UPC>/`).
- The audio filename pattern is `{ISRC}.{ext}` — change to `{ProprietaryId}.{ext}` (e.g. `GMVD4226.wav`) so the filenames match what's in the XML and what your CD reissue catalogue uses.
- Artwork is named `artwork.jpg` — change to the image's ProprietaryId.
- Compute MD5 as you write each file and feed it into the XML generator.

---

## 6. Bottom line — what to do next

1. **Don't ship the seven sample files as-is.** All would fail Ingrooves on UTF-16/no-prolog alone; three would also fail on absurd album durations; one is missing language tags.
2. **Re-encode existing files** (one-time fix script) to UTF-8 with `<?xml … ?>` prolog, and patch the album `<Duration>` on the three bad ones.
3. **Rewrite `lib/ddex-generate.js`** to emit the canonical shape described in §4, with hash-summing.
4. **Reshape the `/ddex/export` route** to write a folder `<UPC>/{<UPC>.xml, resources/*.wav, resources/*.jpg}` instead of a zip.
5. **Add a pre-flight validator** that checks ISRC, ICPN, durations, language, and file-presence before writing anything.

Tell me which piece you want to tackle first — the one-shot fix-up script for the existing 7 files, or the rewrite of the generator. I'd suggest the generator first, then re-export the 7 albums from the new code rather than patching the broken files.
