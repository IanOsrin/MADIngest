# Gallo Ingest

Track submission portal for the Gallo Catalogue (FileMaker).

## Flow

1. File uploaded via portal or DDEX/Excel bulk import
2. File uploaded to S3 `AudioImports/` prefix
3. FileMaker record created in Gallo Catalogue with metadata + S3 URL
4. Daily sync pulls files from S3 to Vision drive, then deletes from S3

## Setup

```bash
npm install
cp .env .env.local  # fill in credentials
npm start
```

Portal:  http://localhost:3001/ingest
Admin:   http://localhost:3001/ingest/admin

## Daily Sync (run on machine with Vision mounted)

```bash
node lib/sync-utility.js           # live run
node lib/sync-utility.js --dry-run # preview only
```

Add to cron for automatic daily sync:
```
0 2 * * * cd /path/to/GalloIngest && node lib/sync-utility.js >> logs/sync.log 2>&1
```

## Environment Variables

| Variable | Description |
|---|---|
| `INGEST_ADMIN_SECRET` | Admin dashboard token |
| `GALLO_FM_HOST` | FileMaker host URL |
| `GALLO_FM_DB` | Database name |
| `GALLO_FM_USER` | FM username |
| `GALLO_FM_PASS` | FM password |
| `GALLO_FM_LAYOUT` | Layout name to write records to |
| `AWS_REGION` | eu-north-1 |
| `AWS_ACCESS_KEY_ID` | AWS key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret |
| `S3_IMPORTS_BUCKET` | mass-music-audio-files |
| `S3_IMPORTS_PREFIX` | AudioImports/ |
| `VISION_PATH` | Local path to Vision drive (for sync utility) |

### MadStreamer push (optional)

Used by the admin "Push to MadStreamer" button — populates a record on the
MadStreamer FileMaker DB and uploads MP3 + GMVi-named artwork to S3.
Credentials default to `GALLO_FM_USER` / `GALLO_FM_PASS`, so for the common
case where both DBs share a login you only need to set host/db/layouts.

| Variable | Default | Description |
|---|---|---|
| `MADSTREAMER_FM_HOST` | `digitalcupboard.fmcloud.fm` | MadStreamer FileMaker host |
| `MADSTREAMER_FM_DB` | `MadStreamer` | Database name |
| `MADSTREAMER_FM_USER` | (falls back to `GALLO_FM_USER`) | FM username |
| `MADSTREAMER_FM_PASS` | (falls back to `GALLO_FM_PASS`) | FM password |
| `MADSTREAMER_FM_LAYOUT` | `API_Album_Songs` | Layout for track / MP3 records |
| `MADSTREAMER_FM_ARTWORK_LAYOUT` | `Artwork` | Layout that owns the GMVi assignment |
| `MADSTREAMER_FM_GMVI_FIELD` | `GMVi` | Field name on the Artwork layout |
| `MADSTREAMER_FM_CATALOGUE_FIELD` | `Reference Catalogue Number` | Field used to look up GMVi |
| `FFMPEG_BIN` | `ffmpeg` | Path to ffmpeg binary |
| `MP3_BITRATE` | `320k` | MP3 encoding bitrate (or `V0` for VBR) |

## MadStreamer push flow

The admin UI shows a **Push to MadStreamer** button on every approved
submission, and a parallel button on the FM Submit / catalogue-enrichment
page that pushes a whole catalogue. The push is intentionally a separate,
manual action — Gallo Catalogue is always the source of truth, so the button
only fires once the catalogue record has been written.

### Asset identifiers — GCAT vs GMVi

These are *separate* identifiers on the catalogue and they must not be
confused:

- **GCAT** (e.g. `GCAT00001`) — audio asset number. Read from the Gallo track
  record's `Filename` field (falling back to legacy `Filename.wav`). Used
  *only* for audio file naming: `mp3/<GCAT>.mp3`, `wav/<GCAT>.wav`.
- **GMVi** (e.g. `GMVF14433`) — artwork asset number. Looked up from
  MadStreamer's **Artwork** layout, keyed by Reference Catalogue Number.
  Used *only* for artwork: `artwork/<GMVi>.<ext>`.

If GMVi is missing for a catalogue, the audio push still proceeds (using
GCAT) and a warning is logged. Artwork is skipped until GMVi is reserved.

### What happens on click

1. Look up the canonical track in Gallo Catalogue by catalogue + sequence
   (falling back to ISRC). All metadata sent to MadStreamer comes from this
   record — *not* the submission record.
2. Read GCAT from Gallo's `Filename` field (`GCAT00001.wav` → `GCAT00001`).
3. Look up GMVi from MadStreamer's `Artwork` layout (artwork-only, optional).
4. Fetch the WAV from the URL on the Gallo record's `File URL` field.
5. Transcode WAV → MP3 at 320 kbps CBR (configurable via `MP3_BITRATE`).
6. Upload MP3 to `s3://<bucket>/mp3/<GCAT>.mp3`.
7. Upload artwork to `s3://<bucket>/artwork/<GMVi>.<ext>` *if* GMVi is known.
8. Optional: also upload the WAV to `s3://<bucket>/wav/<GCAT>.wav`.
9. Upsert the MadStreamer `API_Album_Songs` record. Filename, ISRC, title,
   artist, etc. come from Gallo. GCAT is implicit in the filename; GMVi
   populates only if available.

Requires `ffmpeg` on PATH on the host. The submission record gets a
`madstreamer` audit block with GCAT, GMVi (if any), S3 keys, FM record ID,
and timestamp.

### Endpoints

- `GET  /api/ingest/madstreamer/ping` — health check + config dump
- `POST /api/ingest/madstreamer/push/:id` — push a single submission
- `POST /api/ingest/madstreamer/push-by-catalogue` — push a single track by
  `{ catalogue_no, sequence_no?, isrc?, include_wav? }` (no submission needed)

## Gallo CMS 2024

Third sibling database hosted at `digitalcupboard.app` alongside Gallo
Catalogue. Shares the same FileMaker login — credentials inherit from
`GALLO_FM_USER` / `GALLO_FM_PASS` automatically. Full read + write
integration: search, fetch, create, update, delete, run scripts, plus
cross-DB sync helpers (`push-from-gallo`, `pull-to-gallo`).

| Variable | Default | Description |
|---|---|---|
| `CMS2024_FM_HOST` | (falls back to `GALLO_FM_HOST`) | Host URL, with or without protocol |
| `CMS2024_FM_DB` | `Gallo CMS 2024` | FileMaker database name |
| `CMS2024_FM_USER` | (falls back to `GALLO_FM_USER`) | FM username |
| `CMS2024_FM_PASS` | (falls back to `GALLO_FM_PASS`) | FM password |
| `CMS2024_FM_LAYOUT` | `Song Files` | Default layout for the Data API |

All endpoints below are admin-gated (Bearer `INGEST_ADMIN_SECRET`) and accept
an optional `layout` parameter (query string for GET/DELETE, request body for
POST/PATCH) to target a layout other than the default.

### Read endpoints

- `GET  /api/ingest/cms2024/ping` — health check + masked config
- `GET  /api/ingest/cms2024/layout-fields?layout=&check=Foo,Bar&reload=1`
  — live FM field metadata for diagnostics. `check=` annotates each name with
  whether it exists. `reload=1` busts the in-process introspection cache.
- `GET  /api/ingest/cms2024/search?q=&limit=&offset=&layout=` — OR-find
  across Song Title / Track Name / Track Artist / Album Title / ISRC /
  Catalogue Number. Returns `{ tracks, count, foundCount }`.
- `GET  /api/ingest/cms2024/records/:id?layout=` — fetch one record by FM
  internal `recordId`. Returns the raw record plus a normalised `track`.
- `POST /api/ingest/cms2024/find` — arbitrary FM Data API find.
  Body: `{ query, limit?, offset?, sort?, layout? }`. `query` may be a single
  object (AND-find) or an array (OR-find).

### Write endpoints

- `POST   /api/ingest/cms2024/records` — create a record.
  Body: `{ fieldData, layout? }`. Unknown field names are filtered out (FM
  rejects the whole request otherwise) and returned in `dropped`.
- `PATCH  /api/ingest/cms2024/records/:id` — update an existing record.
  Body: `{ fieldData, layout? }`. Same filtering as create.
- `DELETE /api/ingest/cms2024/records/:id?layout=` — delete by FM recordId.
- `POST   /api/ingest/cms2024/records/:id/run-script` — trigger a FM script
  on a record. Body: `{ script, scriptParam?, layout? }`.

### 3-DB catalogue workflow

Day-to-day flow uses the **Admin → DB Sync** tab:

1. Enter a catalogue number, click *Check all 3 DBs*.
2. The table shows which tracks are present in Gallo Catalogue / CMS 2024 / MadStreamer.
3. If CMS 2024 has tracks but the other DBs don't, *Replicate missing from CMS 2024*
   creates the per-track records on whichever DB is empty, plus the album-level
   Tape Files Master record.
4. Use **Generate DDEX** with source = "Gallo CMS 2024" and tick
   *Auto-replicate missing records* to do both steps in one go before writing
   the DDEX folder.

CMS 2024 is read-only in the primary workflow — copies flow OUT of it, never
into it. The `push-from-gallo` endpoints below still exist as a safety net.

### Cross-DB endpoints

- `GET  /api/ingest/catalogue/:catNo/status` — parallel lookup across all 3 DBs.
  Returns `{ counts, gallo, cms2024, streamer, matrix }` where `matrix` is a
  per-track row showing presence in each DB (keyed on ISRC, falling back to
  sequence + filename).
- `POST /api/ingest/cms2024/pull-catalogue-to-gallo` — bulk copy every CMS 2024
  track for a catalogue into Gallo Catalogue. Creates missing records via
  `createGalloRecord`, updates existing ones with `updateGalloRecord`, and
  creates the Tape Files Master record when the catalogue is new on Gallo.
  Body: `{ catalogue_no, fields?, layout? }`.
- `POST /api/ingest/cms2024/push-catalogue-to-streamer` — metadata-only bulk
  push from CMS 2024 → MadStreamer. Upserts per-track records on
  `API_Album_Songs` plus the Tape Files Master record. Audio transcoding still
  goes via the Gallo→Streamer path (Gallo owns the WAV URLs).
  Body: `{ catalogue_no, layout? }`.
- `POST /api/ingest/cms2024/ensure-catalogue-replicated` — one-shot wrapper.
  Body: `{ catalogue_no, replicate_to?, force? }`. Inspects all 3 DBs and
  replicates from CMS 2024 to whichever target has zero tracks. `force=true`
  bypasses the "already present" guard and runs the upsert regardless.
  Returns `{ gallo: {action,...}, streamer: {action,...} }`.

### DDEX from CMS 2024

`POST /api/ingest/ddex/build` and `/api/ingest/ddex/export` now accept a
`source` parameter (`gallo` (default) or `cms2024`). The CMS 2024 mapper
returns the same flat track shape Gallo uses, so the rest of the DDEX
pipeline is unchanged.

The admin UI's *Generate DDEX* tab has a source selector + a checkbox that
runs `ensure-catalogue-replicated` before the build, so a single click can:

1. Replicate the catalogue from CMS 2024 → Gallo + Streamer (incl. Tape Files)
2. Build the Ingrooves DDEX folder from the now-present catalogue

### Legacy / safety-net endpoints (not part of primary workflow)

- `POST /api/ingest/cms2024/push-from-gallo` — Gallo → CMS 2024 (single track).
- `POST /api/ingest/cms2024/push-catalogue-from-gallo` — Gallo → CMS 2024 (bulk).
- `POST /api/ingest/cms2024/pull-to-gallo` — CMS 2024 → Gallo (single track).
- `POST /api/ingest/cms2024/find` — arbitrary FM Data API find against the Song Files layout. Body: `{ query, limit?, offset?, sort?, layout? }`. `query` may be an object (AND-find) or array (OR-find).

### Diagnostics

When something fails in the field, these endpoints help work out which database / layout / record is at fault. All require the admin bearer token.

- `GET /api/ingest/gallo/recent-creates?limit=N&clear=1` — Ring buffer of the most recent `createGalloRecord` attempts. Each event records the `phase` (`post` / `recordId` / `verify_ok` / `verify_404` / `verify_mismatch` / `error`), the ISRC + title, the FM record ID, the sent field list, and any error message. Use when terminal output scrolls past too fast.
- `GET /api/ingest/gallo/layout-fields?layout=&check=Foo,Bar` — Lists field names actually present on a Gallo layout (defaults to `API_Album_Songs`). `check=` annotates each name with a `present` boolean — handy for diagnosing "field doesn't exist on layout" rejections.
- `GET /api/ingest/cms2024/layout-fields?layout=&check=&reload=1` — Same diagnostic for CMS 2024. `reload=1` busts the in-process introspection cache.
- `GET /api/ingest/madstreamer/layout-fields?layout=&reload=1` — Same for MadStreamer.
- `GET /api/ingest/cms2024/ping` — Auth check + masked config dump.
- `npm run cms2024:smoke -- --all` — Standalone CLI smoke test: pings CMS 2024, dumps every field on the Song Files layout with type info. Run with `--all` (or `VERBOSE=1`) to print every field name; otherwise prints just a sample.

### Programmatic API

The same primitives are exported from `lib/fm-cms2024.js` if you need to call
CMS 2024 from elsewhere in Node:

```js
import {
  pingCms2024, findRecord, findRecords, getRecord,
  createRecord, updateRecord, deleteRecord, upsertRecord,
  searchRecords, runScriptOnRecord, getLayoutFields,
  mapCms2024Record,
} from './lib/fm-cms2024.js'
```
