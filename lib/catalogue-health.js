/**
 * lib/catalogue-health.js — catalogue-wide data checks over the Postgres mirror.
 *
 * The Source tab's lib/data-health.js answers "what is wrong with THESE records".
 * This answers "what is wrong with the catalogue", which is the version you put
 * in front of the client to get codes allocated.
 *
 * Counts are computed in SQL, not by pulling 67k rows into memory: the hosted
 * instance is small and already holds the 82k-row metadata cache, and it has
 * OOM-died on big payloads before. Each check therefore has a `count` query and
 * a `records` query, and the drill-down is capped.
 *
 * Everything is as of the mirror's last sync — a nightly snapshot, not live.
 * Callers must show that date; a stale number presented as current is worse
 * than no number.
 */
import { mirrorQuery, mirrorFreshness, isMirrorEnabled } from './mirror-db.js'

// Shared SQL fragments. FileMaker text is inconsistently cased and punctuated,
// so comparisons normalise the same way lib/data-health.js does in JS.
const NORM = (col) => `btrim(regexp_replace(lower(coalesce(${col},'')), '[^a-z0-9]+', ' ', 'g'))`
const CAT  = `nullif(btrim(coalesce(raw->>'Album Catalogue Number','')),'')`
const CATN = `upper(regexp_replace(coalesce(${CAT}, raw->>'Reference Catalogue Number',''), '[^A-Za-z0-9]', '', 'g'))`
// Values people type meaning "blank". They pass a not-empty test and then poison
// anything keyed on them — "#N/A" is in the ISRC field on 17 records.
const JUNK = `'^(#n/a|#ref!|#value!|n/a|na|none|null|nil|-+|0+|tbc|tba|unknown|\\?+|x+)$'`
const COVER = `coalesce(nullif(raw->>'Tape Files::Artwork_S3_URL',''), raw->>'Artwork_S3_URL','')`

/**
 * Each check: a scalar count, and a query returning the offending records.
 * `group` drives the UI's sectioning. `why` is shown to a human — it must say
 * what the consequence is, not just restate the rule.
 */
export const CHECKS = [
  {
    code: 'isrc-shared', severity: 'error', group: 'Identity',
    label: 'One ISRC on several songs of the SAME album',
    why: 'The code was filled down a column: one album, several different tracks, one ISRC. Royalty reporting and DSP delivery key on this field, so plays are credited to the wrong recording — and the songs collapse into one row anywhere they are matched by ISRC.',
    // Scoped to WITHIN one catalogue on purpose. An ISRC identifies a RECORDING,
    // so the same recording legitimately carries one code across an original
    // album and a compilation — counting that as an error made 254 of 543
    // findings false (Ian, 2026-09-08). Two different titles on ONE album
    // cannot be one recording, so that is the version that is provably wrong.
    countSql: `
      SELECT count(DISTINCT i)::int AS n FROM (
        SELECT raw->>'ISRC' i, ${CATN} c FROM tracks
         WHERE coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK} AND ${CATN} <> ''
         GROUP BY 1,2 HAVING count(DISTINCT ${NORM("raw->>'Track Name'")}) > 1) x`,
    unit: 'ISRCs',
    recordsSql: `
      WITH bad AS (
        SELECT raw->>'ISRC' i, ${CATN} c FROM tracks
         WHERE coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK} AND ${CATN} <> ''
         GROUP BY 1,2 HAVING count(DISTINCT ${NORM("raw->>'Track Name'")}) > 1)
      SELECT fm_record_id, raw->>'ISRC' isrc, raw->>'Track Name' title,
             raw->>'Album Title' album, raw->>'Album Artist' artist, ${CAT} cat
        FROM tracks t WHERE EXISTS (
          SELECT 1 FROM bad b WHERE b.i = t.raw->>'ISRC' AND b.c = ${CATN})
       ORDER BY raw->>'ISRC', raw->>'Track Name'`,
  },
  {
    code: 'isrc-across-albums', severity: 'info', group: 'Identity',
    label: 'One ISRC on different albums, titles spelled differently',
    why: 'Usually FINE — one recording reissued on a compilation keeps its ISRC, and the titles differ only in spelling ("Pata Pata" / "Phatha Phatha", "Waqala Izitha" / "Waqal\' Izitha"). Listed so you can spot the occasional genuine mix-up, not because it is wrong.',
    unit: 'ISRCs',
    countSql: `
      WITH clean AS (
        SELECT raw->>'ISRC' i, ${CATN} c, ${NORM("raw->>'Track Name'")} t FROM tracks
         WHERE coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK} AND ${CATN} <> ''),
      multi AS (SELECT i FROM clean GROUP BY i HAVING count(DISTINCT t) > 1),
      within AS (SELECT i FROM clean GROUP BY i, c HAVING count(DISTINCT t) > 1)
      SELECT count(*)::int AS n FROM (
        SELECT i FROM multi EXCEPT SELECT i FROM within) x`,
    recordsSql: `
      WITH clean AS (
        SELECT raw->>'ISRC' i, ${CATN} c, ${NORM("raw->>'Track Name'")} t FROM tracks
         WHERE coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK} AND ${CATN} <> ''),
      multi AS (SELECT i FROM clean GROUP BY i HAVING count(DISTINCT t) > 1),
      within AS (SELECT i FROM clean GROUP BY i, c HAVING count(DISTINCT t) > 1),
      keep AS (SELECT i FROM multi EXCEPT SELECT i FROM within)
      SELECT raw->>'ISRC' isrc, count(*)::int records,
             string_agg(DISTINCT raw->>'Track Name', '  |  ') titles,
             string_agg(DISTINCT raw->>'Album Title', '  |  ') albums
        FROM tracks WHERE raw->>'ISRC' IN (SELECT i FROM keep)
       GROUP BY 1 ORDER BY 1`,
  },
  {
    code: 'code-junk', severity: 'error', group: 'Identity',
    label: 'Placeholder text in ISRC or UPC',
    why: 'Values like "#N/A" came in from spreadsheet error cells. They are not empty, so every not-blank check passes and they travel downstream as if they were real codes.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE raw->>'ISRC' ~* ${JUNK} OR raw->>'UPC' ~* ${JUNK}`,
    recordsSql: `
      SELECT fm_record_id, raw->>'ISRC' isrc, raw->>'UPC' upc, raw->>'Track Name' title,
             raw->>'Album Title' album, ${CAT} cat
        FROM tracks WHERE raw->>'ISRC' ~* ${JUNK} OR raw->>'UPC' ~* ${JUNK}`,
  },
  {
    code: 'isrc-missing', severity: 'warn', group: 'Identity',
    label: 'No ISRC',
    why: 'Without an ISRC the recording cannot be reported or delivered, and the site will not render it.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE coalesce(raw->>'ISRC','') = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
                        raw->>'Album Artist' artist, ${CAT} cat FROM tracks
                  WHERE coalesce(raw->>'ISRC','') = '' ORDER BY ${CAT}, raw->>'Track Name'`,
  },
  {
    code: 'upc-missing', severity: 'warn', group: 'Identity',
    label: 'No UPC / barcode',
    why: 'Required by the same display rule as the ISRC — a track without one never renders on the site.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE coalesce(raw->>'UPC','') = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
                        raw->>'Album Artist' artist, ${CAT} cat FROM tracks
                  WHERE coalesce(raw->>'UPC','') = '' ORDER BY ${CAT}, raw->>'Track Name'`,
  },
  {
    code: 'hidden-from-site', severity: 'error', group: 'Invisible on the website',
    label: 'Will NOT show on the website',
    why: 'A song needs an ISRC, a UPC and a cover or the site never renders it — the record exists, nobody can reach it. This is the single biggest number here and the one to put in front of the client.',
    countSql: `
      SELECT count(*)::int n FROM tracks
       WHERE NOT (coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK}
              AND coalesce(raw->>'UPC','')  <> '' AND raw->>'UPC'  !~* ${JUNK}
              AND ${COVER} ~ '^https?://')`,
    recordsSql: `
      SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
             raw->>'Album Artist' artist, ${CAT} cat,
             CASE WHEN coalesce(raw->>'ISRC','') = '' OR raw->>'ISRC' ~* ${JUNK} THEN 'ISRC ' ELSE '' END ||
             CASE WHEN coalesce(raw->>'UPC','')  = '' OR raw->>'UPC'  ~* ${JUNK} THEN 'UPC ' ELSE '' END ||
             CASE WHEN ${COVER} !~ '^https?://' THEN 'cover' ELSE '' END AS missing
        FROM tracks
       WHERE NOT (coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK}
              AND coalesce(raw->>'UPC','')  <> '' AND raw->>'UPC'  !~* ${JUNK}
              AND ${COVER} ~ '^https?://')
       ORDER BY ${CAT}, raw->>'Track Name'`,
  },
  {
    code: 'no-cover', severity: 'warn', group: 'Invisible on the website',
    label: 'No cover image',
    why: 'The card renders blank, and the track is hidden by the display rule.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE ${COVER} !~ '^https?://'`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
                        raw->>'Album Artist' artist, ${CAT} cat, ${COVER} artwork FROM tracks
                  WHERE ${COVER} !~ '^https?://' ORDER BY ${CAT}`,
  },
  {
    code: 'no-audio', severity: 'error', group: 'Invisible on the website',
    label: 'No audio file',
    why: 'There is nothing to play. The row looks complete until someone presses play.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE coalesce(raw->>'S3_URL','') = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
                        raw->>'Album Artist' artist, ${CAT} cat FROM tracks
                  WHERE coalesce(raw->>'S3_URL','') = ''`,
  },
  {
    code: 'audio-flagged', severity: 'warn', group: 'Invisible on the website',
    label: 'Flagged Bad_Audio / Faulty_Audio',
    why: 'Someone has already marked these as bad. They are still live unless something else hides them.',
    countSql: `SELECT count(*)::int n FROM tracks
                WHERE coalesce(raw->>'Bad_Audio','') <> '' OR coalesce(raw->>'Faulty_Audio','') <> ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album, ${CAT} cat,
                        raw->>'Bad_Audio' bad_audio, raw->>'Faulty_Audio' faulty_audio FROM tracks
                  WHERE coalesce(raw->>'Bad_Audio','') <> '' OR coalesce(raw->>'Faulty_Audio','') <> ''`,
  },
  {
    code: 'catalogue-split-title', severity: 'warn', group: 'Album coherence',
    label: 'One catalogue, more than one album title',
    why: 'The album reads as two different releases. Tracks filed under the odd one out disappear when you search by album — this is exactly what made GALP 1296 look like it had lost tracks.',
    countSql: `SELECT count(*)::int n FROM (
                 SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                  GROUP BY 1 HAVING count(DISTINCT ${NORM("raw->>'Album Title'")})
                    FILTER (WHERE btrim(coalesce(raw->>'Album Title','')) <> '') > 1) x`,
    unit: 'catalogues',
    recordsSql: `
      WITH bad AS (SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                    GROUP BY 1 HAVING count(DISTINCT ${NORM("raw->>'Album Title'")})
                      FILTER (WHERE btrim(coalesce(raw->>'Album Title','')) <> '') > 1)
      SELECT ${CATN} cat, count(*)::int tracks,
             string_agg(DISTINCT nullif(btrim(raw->>'Album Title'),''), '  |  ') AS album_titles,
             min(raw->>'Album Artist') artist
        FROM tracks WHERE ${CATN} IN (SELECT c FROM bad)
       GROUP BY 1 ORDER BY 1`,
  },
  {
    code: 'catalogue-split-artist', severity: 'info', group: 'Album coherence',
    label: 'One catalogue, more than one album artist',
    why: 'Often legitimate on a compilation. Worth a look when it is one name spelled several ways.',
    countSql: `SELECT count(*)::int n FROM (
                 SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                  GROUP BY 1 HAVING count(DISTINCT ${NORM("raw->>'Album Artist'")})
                    FILTER (WHERE btrim(coalesce(raw->>'Album Artist','')) <> '') > 1) x`,
    unit: 'catalogues',
    recordsSql: `
      WITH bad AS (SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                    GROUP BY 1 HAVING count(DISTINCT ${NORM("raw->>'Album Artist'")})
                      FILTER (WHERE btrim(coalesce(raw->>'Album Artist','')) <> '') > 1)
      SELECT ${CATN} cat, count(*)::int tracks,
             string_agg(DISTINCT nullif(btrim(raw->>'Album Artist'),''), '  |  ') AS album_artists,
             min(raw->>'Album Title') album
        FROM tracks WHERE ${CATN} IN (SELECT c FROM bad)
       GROUP BY 1 ORDER BY 1`,
  },
  {
    code: 'repeated-track', severity: 'warn', group: 'Album coherence',
    label: 'Same track title twice on one catalogue',
    why: 'Either duplicate records, or two versions that need distinguishing. Duplicates get counted twice everywhere.',
    countSql: `SELECT count(*)::int n FROM (
                 SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                  GROUP BY 1 HAVING count(*) > count(DISTINCT ${NORM("raw->>'Track Name'")})) x`,
    unit: 'catalogues',
    recordsSql: `
      WITH bad AS (SELECT ${CATN} c FROM tracks WHERE ${CATN} <> ''
                    GROUP BY 1 HAVING count(*) > count(DISTINCT ${NORM("raw->>'Track Name'")}))
      SELECT ${CATN} cat, raw->>'Track Name' title, count(*)::int copies,
             min(raw->>'Album Title') album, min(raw->>'Album Artist') artist
        FROM tracks WHERE ${CATN} IN (SELECT c FROM bad)
       GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 1,2`,
  },
  {
    code: 'repeated-sequence', severity: 'warn', group: 'Album coherence',
    label: 'Same track number twice on one catalogue',
    why: 'Track order is ambiguous, so the album plays in an arbitrary order.',
    countSql: `SELECT count(*)::int n FROM (
                 SELECT ${CATN} c FROM tracks
                  WHERE ${CATN} <> '' AND raw->>'Sequence Number' ~ '^[0-9]+$'
                  GROUP BY 1 HAVING count(*) > count(DISTINCT (raw->>'Sequence Number')::int)) x`,
    unit: 'catalogues',
    recordsSql: `
      WITH bad AS (SELECT ${CATN} c FROM tracks
                    WHERE ${CATN} <> '' AND raw->>'Sequence Number' ~ '^[0-9]+$'
                    GROUP BY 1 HAVING count(*) > count(DISTINCT (raw->>'Sequence Number')::int))
      SELECT ${CATN} cat, raw->>'Sequence Number' seq, count(*)::int copies,
             string_agg(raw->>'Track Name', '  |  ') titles
        FROM tracks WHERE ${CATN} IN (SELECT c FROM bad) AND raw->>'Sequence Number' ~ '^[0-9]+$'
       GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 1, 2::int`,
  },
  {
    code: 'album-title-missing', severity: 'warn', group: 'Album coherence',
    label: 'No album title',
    why: 'The track has no album name at all. Split out from the two-titles check on purpose: 39 catalogues looked like they had conflicting titles when really some rows were simply blank, and the two need different fixes.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE btrim(coalesce(raw->>'Album Title','')) = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Artist' artist,
                        ${CAT} cat, raw->>'ISRC' isrc FROM tracks
                  WHERE btrim(coalesce(raw->>'Album Title','')) = '' ORDER BY ${CAT}`,
  },
  {
    code: 'no-sequence', severity: 'info', group: 'Album coherence',
    label: 'No track number',
    why: 'The track sorts arbitrarily within its album.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE coalesce(raw->>'Sequence Number','') = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album, ${CAT} cat
                   FROM tracks WHERE coalesce(raw->>'Sequence Number','') = '' ORDER BY ${CAT}`,
  },
  {
    code: 'no-catalogue', severity: 'warn', group: 'Album coherence',
    label: 'No catalogue number',
    why: 'Nothing ties the track to a release, so it cannot be matched against Gallo or the extract at all.',
    countSql: `SELECT count(*)::int n FROM tracks WHERE ${CATN} = ''`,
    recordsSql: `SELECT fm_record_id, raw->>'Track Name' title, raw->>'Album Title' album,
                        raw->>'Album Artist' artist, raw->>'ISRC' isrc FROM tracks WHERE ${CATN} = ''`,
  },
]

// ── Batched sweeps ───────────────────────────────────────────────────────────
// Running each check as its own query took 194s: fourteen full passes, each
// re-extracting fields out of the `raw` jsonb. Grouping them into three passes
// with conditional aggregates does the same work once.
//
// Text comparisons deliberately use `raw`, NOT the mirror's normalised columns.
// They disagree — 433 rows on album_title, 311 on track_title, 268 on
// album_artist, 56 on catalogue_no — because the sync mapper cleans them, and a
// data-quality report has to describe what is actually in FileMaker. The
// artwork, audio and sequence columns were verified byte-identical to raw, so
// those are taken from the fast path.
const ROW_SWEEP = `
  SELECT count(*)::int AS total,
    count(*) FILTER (WHERE raw->>'ISRC' ~* ${JUNK} OR raw->>'UPC' ~* ${JUNK})::int             AS "code-junk",
    count(*) FILTER (WHERE coalesce(raw->>'ISRC','') = '')::int                                AS "isrc-missing",
    count(*) FILTER (WHERE coalesce(raw->>'UPC','')  = '')::int                                AS "upc-missing",
    count(*) FILTER (WHERE NOT (coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK}
                            AND coalesce(raw->>'UPC','')  <> '' AND raw->>'UPC'  !~* ${JUNK}
                            AND coalesce(s3_artwork_url,'') ~ '^https?://'))::int              AS "hidden-from-site",
    count(*) FILTER (WHERE coalesce(s3_artwork_url,'') !~ '^https?://')::int                   AS "no-cover",
    count(*) FILTER (WHERE coalesce(s3_audio_url,'') = '')::int                                AS "no-audio",
    count(*) FILTER (WHERE coalesce(raw->>'Bad_Audio','') <> ''
                        OR coalesce(raw->>'Faulty_Audio','') <> '')::int                       AS "audio-flagged",
    count(*) FILTER (WHERE track_seq IS NULL)::int                                             AS "no-sequence",
    count(*) FILTER (WHERE btrim(coalesce(raw->>'Album Title','')) = '')::int                  AS "album-title-missing",
    count(*) FILTER (WHERE ${CATN} = '')::int                                                  AS "no-catalogue"
  FROM tracks`

const ISRC_SWEEP = `
  WITH clean AS (
    SELECT raw->>'ISRC' i, ${CATN} c, ${NORM("raw->>'Track Name'")} t FROM tracks
     WHERE coalesce(raw->>'ISRC','') <> '' AND raw->>'ISRC' !~* ${JUNK} AND ${CATN} <> ''),
  multi  AS (SELECT i FROM clean GROUP BY i    HAVING count(DISTINCT t) > 1),
  within AS (SELECT i FROM clean GROUP BY i, c HAVING count(DISTINCT t) > 1)
  SELECT (SELECT count(DISTINCT i)::int FROM within)                                AS "isrc-shared",
         (SELECT count(*)::int FROM (SELECT i FROM multi EXCEPT SELECT i FROM within) z) AS "isrc-across-albums"`

const CAT_SWEEP = `
  WITH per_cat AS (
    SELECT ${CATN} c,
           count(DISTINCT ${NORM("raw->>'Album Title'")})
             FILTER (WHERE btrim(coalesce(raw->>'Album Title','')) <> '')  AS titles,
           count(DISTINCT ${NORM("raw->>'Album Artist'")})
             FILTER (WHERE btrim(coalesce(raw->>'Album Artist','')) <> '') AS artists,
           count(*)                                        AS n,
           count(DISTINCT ${NORM("raw->>'Track Name'")})   AS distinct_titles,
           count(*) FILTER (WHERE track_seq IS NOT NULL)   AS seq_n,
           count(DISTINCT track_seq)                       AS seq_distinct
      FROM tracks WHERE ${CATN} <> '' GROUP BY 1)
  SELECT count(*) FILTER (WHERE titles  > 1)::int                 AS "catalogue-split-title",
         count(*) FILTER (WHERE artists > 1)::int                 AS "catalogue-split-artist",
         count(*) FILTER (WHERE n > distinct_titles)::int         AS "repeated-track",
         count(*) FILTER (WHERE seq_n > seq_distinct)::int        AS "repeated-sequence"
    FROM per_cat`

const RECORD_CAP = Number(process.env.HEALTH_RECORD_CAP) || 5000

// The full sweep is a dozen aggregate queries over 67k rows — a few seconds, and
// the answer only changes when the mirror re-syncs overnight. Cached, with an
// explicit refresh, so opening the tab is instant.
let _cache = null
const TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS) || 30 * 60 * 1000

let _building = null   // in-flight sweep — concurrent callers share one

async function buildSummary() {
  const t0 = Date.now()
  const freshness = await mirrorFreshness().catch(() => null)

  const counts = {}
  let total = 0
  for (const [name, sql] of [['rows', ROW_SWEEP], ['isrc', ISRC_SWEEP], ['catalogue', CAT_SWEEP]]) {
    try {
      const row = (await mirrorQuery(sql)).rows[0] || {}
      for (const [k, v] of Object.entries(row)) {
        if (k === 'total') total = v; else counts[k] = v
      }
    } catch (e) {
      // One broken sweep must not blank the whole page — the checks it covers
      // are reported as errored and the rest still render.
      console.warn(`[health] ${name} sweep failed:`, e?.message)
      counts[`__error_${name}`] = e?.message || 'failed'
    }
  }

  const checks = CHECKS.map((c) => {
    const n = counts[c.code]
    if (n === undefined) return { code: c.code, label: c.label, why: c.why, severity: c.severity, group: c.group, error: 'not computed' }
    return {
      code: c.code, label: c.label, why: c.why, severity: c.severity, group: c.group,
      count: n, unit: c.unit || 'records',
      pct: c.unit || !total ? null : +(n / total * 100).toFixed(1),
    }
  })

  return {
    ok: true, builtAt: Date.now(), tookMs: Date.now() - t0, total, checks,
    syncedAt: freshness?.last_synced_at || null,
    syncStatus: freshness?.last_status || null,
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.refresh]  re-sweep even if the cache is warm
 * @param {boolean} [opts.wait]     block until the sweep finishes (default false)
 *
 * The sweep takes tens of seconds over 67k records, so by default a cold call
 * kicks it off and returns `{ building: true }` for the caller to poll — the
 * same shape the metadata cache uses, and for the same reason: a silent
 * half-minute request is indistinguishable from a hang.
 */
export async function getHealthSummary({ refresh = false, wait = false } = {}) {
  if (!isMirrorEnabled()) {
    return { ok: false, reason: "The Postgres mirror is not configured. Set MIRROR_DATABASE_URL to the MAD website's database (read-only use)." }
  }

  // The answers only change when the mirror re-syncs from FileMaker, which is
  // nightly — so the cache is keyed on the sync timestamp, not a timer. A
  // ~90-second sweep then runs about once a day instead of every TTL. The TTL
  // stays as a backstop for when the sync timestamp cannot be read.
  if (!refresh && _cache) {
    let sameSync = false
    try {
      const f = await mirrorFreshness()
      sameSync = !!f && String(f.last_synced_at) === String(_cache.syncedAt)
    } catch { /* fall through to the TTL */ }
    if (sameSync || Date.now() - _cache.builtAt < TTL_MS) return _cache
  }

  if (!_building) {
    _building = buildSummary()
      .then((s) => { _cache = s; return s })
      .catch((e) => { console.error('[health] sweep failed:', e?.message); throw e })
      .finally(() => { _building = null })
  }
  if (wait) return _building
  // Serve the stale sweep while a refresh runs rather than showing nothing.
  if (_cache) return { ..._cache, refreshing: true }
  _building.catch(() => {})
  return { ok: false, building: true, reason: 'Sweeping the catalogue — this takes about half a minute the first time.' }
}

export async function getHealthRecords(code, { limit = 500, offset = 0 } = {}) {
  if (!isMirrorEnabled()) return { ok: false, reason: 'mirror not configured' }
  const check = CHECKS.find((c) => c.code === code)
  if (!check) return { ok: false, reason: `unknown check "${code}"` }
  const lim = Math.min(Math.max(1, Number(limit) || 500), RECORD_CAP)
  const off = Math.max(0, Number(offset) || 0)
  const r = await mirrorQuery(`${check.recordsSql} LIMIT ${lim + 1} OFFSET ${off}`)
  const rows = r.rows.slice(0, lim)
  return {
    ok: true, code, label: check.label, why: check.why, severity: check.severity,
    rows, offset: off, limit: lim, hasMore: r.rows.length > lim,
    columns: rows.length ? Object.keys(rows[0]) : [],
  }
}
