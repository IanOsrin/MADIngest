/**
 * scripts/isrc-allocation-dump.mjs — every MadStreamer song (Postgres mirror, copied nightly ~03:00) with the album
 * details an ISRC allocator needs → tmp/isrc-allocation-tracks.json. Read-only. scripts/isrc-allocation-xlsx.py turns
 * it into the fill-in sheet (Ian, 2026-10-13: "songs that are missing ISRC but the rest of the album has ISRC … for
 * the guy who allocates ISRC").
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { mirrorQuery } from '../lib/mirror-db.js'

const { rows } = await mirrorQuery(`SELECT fm_record_id::text id, catalogue_no cat, album_title album, album_artist, track_title title, track_artist artist,
  track_seq seq, raw->>'Filename' file, coalesce(raw->>'ISRC','') isrc, raw->>'UPC' upc, raw->>'Version' version, raw->>'Duration' duration,
  coalesce(raw->>'Composers', raw->>'Composer') composer, raw->>'Label' label, coalesce(raw->>'Year of Release', release_year::text) yr,
  raw->>'Release Date' release_date, raw->>'pLine' pline, raw->>'Genre' genre_raw, visibility, synced_at FROM tracks`)
writeFileSync('tmp/isrc-allocation-tracks.json', JSON.stringify(rows))
console.log(`${rows.length} songs → tmp/isrc-allocation-tracks.json (copy of ${rows[0]?.synced_at?.toISOString?.()})`)
process.exit(0)
