/**
 * lib/data-health.js — spot data faults in records already on screen.
 *
 * The point of this file, in Ian's words: "we spend hours fixing the software
 * when it is the data that is at fault." Every check here exists because a real
 * data fault was mistaken for a bug. It runs on records a view has ALREADY
 * fetched — no extra queries, no FileMaker load — so it costs nothing to leave
 * on everywhere.
 *
 * Findings are advisory. Nothing here changes what is displayed or hides a row;
 * it only explains what you are looking at.
 *
 * Severity: 'error'   the data is provably wrong (two songs, one ISRC)
 *           'warn'    the data is inconsistent and probably wrong
 *           'info'    worth knowing, not necessarily wrong
 */

const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normCat = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const has = (v) => String(v ?? '').trim() !== ''

// Values people type when they mean "blank". They pass a not-empty check and
// then poison anything keyed on them — "#N/A" is sitting in the ISRC field on
// 17 MadStreamer records, imported from a spreadsheet error cell.
const JUNK = /^(#n\/a|#ref!|#value!|n\/a|na|none|null|nil|-+|0+|tbc|tba|unknown|\?+|x+)$/i
const isJunk = (v) => has(v) && JUNK.test(String(v).trim())

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

/**
 * @param {Array<{key,label,rank,tracks}>} entries  per-source results
 * @param {object} [opts]
 * @param {string} [opts.primaryKey='madstreamer']  the database the site serves
 * @returns {Array<{severity,code,message,detail?,source?}>}
 */
export function checkDataHealth(entries, { primaryKey = 'madstreamer' } = {}) {
  const findings = []
  const add = (severity, code, message, detail, source) =>
    findings.push({ severity, code, message, ...(detail ? { detail } : {}), ...(source ? { source } : {}) })

  for (const src of entries) {
    const tracks = src.tracks || []
    if (!tracks.length) continue

    // ── identity ────────────────────────────────────────────────────────────
    // An ISRC identifies a RECORDING, so one code legitimately covers the same
    // recording on an original album and on a compilation — where the titles
    // often differ only in spelling ("Pata Pata" / "Phatha Phatha"). Treating
    // that as an error was wrong and made 254 of 543 catalogue-wide findings
    // false (Ian, 2026-09-08). Two different titles on ONE album cannot be one
    // recording, so that — a code filled down a column — is the real error.
    const byIsrc = new Map()
    for (const t of tracks) {
      const k = String(t.isrc ?? '').trim().toUpperCase()
      if (!k || isJunk(k)) continue
      if (!byIsrc.has(k)) byIsrc.set(k, [])
      byIsrc.get(k).push(t)
    }

    const sameAlbum = [], acrossAlbums = []
    for (const [isrc, list] of byIsrc) {
      if (new Set(list.map(t => norm(t.title))).size < 2) continue
      // Within any single catalogue, is this code on more than one title?
      const perCat = new Map()
      for (const t of list) {
        const c = normCat(t.catalogue_no)
        if (!perCat.has(c)) perCat.set(c, new Set())
        perCat.get(c).add(norm(t.title))
      }
      if ([...perCat.values()].some(s => s.size > 1)) sameAlbum.push([isrc, list])
      else acrossAlbums.push([isrc, list])
    }

    if (sameAlbum.length) {
      const worst = sameAlbum.sort((a, b) => b[1].length - a[1].length)[0]
      add('error', 'isrc-shared',
        `${src.label}: ${plural(sameAlbum.length, 'ISRC')} on several songs of the same album`,
        `${worst[0]} is on ${worst[1].length} different titles — ${worst[1].slice(0, 3).map(t => `"${t.title}"`).join(', ')}${worst[1].length > 3 ? '…' : ''}. One album cannot have two recordings under one code, so this was filled down a column. Royalty reporting keys on this field.`,
        src.key)
    }
    if (acrossAlbums.length) {
      const w = acrossAlbums[0]
      add('info', 'isrc-across-albums',
        `${src.label}: ${plural(acrossAlbums.length, 'ISRC')} shared across different albums`,
        `Usually fine — one recording reissued keeps its ISRC, and the titles differ only in spelling. e.g. ${w[0]}: ${[...new Set(w[1].map(t => `"${t.title}"`))].join(', ')}.`,
        src.key)
    }

    const junk = tracks.filter(t => isJunk(t.isrc) || isJunk(t.upc))
    if (junk.length) {
      add('error', 'junk-code',
        `${src.label}: ${plural(junk.length, 'record')} with a placeholder in ISRC or UPC`,
        `e.g. "${String(junk[0].isrc || junk[0].upc).trim()}" on "${junk[0].title}". These read as real values everywhere.`,
        src.key)
    }

    // ── invisible on the site (MadStreamer only — it is what the site reads) ─
    if (src.key === primaryKey && tracks.some(t => t.upc !== undefined)) {
      const hidden = tracks.filter(t =>
        !(has(t.isrc) && !isJunk(t.isrc) && has(t.upc) && !isJunk(t.upc) &&
          /^https?:\/\//.test(String(t.artwork_url ?? ''))))
      if (hidden.length) {
        const why = []
        if (hidden.some(t => !has(t.isrc) || isJunk(t.isrc))) why.push('ISRC')
        if (hidden.some(t => !has(t.upc)  || isJunk(t.upc)))  why.push('UPC')
        if (hidden.some(t => !/^https?:\/\//.test(String(t.artwork_url ?? '')))) why.push('cover')
        add('error', 'hidden-from-site',
          `${plural(hidden.length, 'track')} here will NOT show on the website`,
          `A track needs an ISRC, a UPC and a cover to render. Missing: ${why.join(', ')}. Affected: ${hidden.slice(0, 3).map(t => `"${t.title}"`).join(', ')}${hidden.length > 3 ? `, +${hidden.length - 3} more` : ''}.`,
          src.key)
      }
      const noAudio = tracks.filter(t => t.audio_url !== undefined && !has(t.audio_url))
      if (noAudio.length) {
        add('warn', 'no-audio', `${plural(noAudio.length, 'track')} with no audio file`,
          noAudio.slice(0, 3).map(t => `"${t.title}"`).join(', '), src.key)
      }
    }

    // ── album coherence — one catalogue should be one album ─────────────────
    const byCat = new Map()
    for (const t of tracks) {
      const c = normCat(t.catalogue_no); if (!c) continue
      if (!byCat.has(c)) byCat.set(c, [])
      byCat.get(c).push(t)
    }
    for (const [cat, list] of byCat) {
      const titles = [...new Set(list.map(t => t.album_title).filter(has))]
      if (new Set(titles.map(norm)).size > 1) {
        add('warn', 'catalogue-split-title',
          `${src.label}: catalogue ${list[0].catalogue_no} has ${titles.length} different album titles`,
          `${titles.map(t => `"${t}"`).join(' vs ')} — the album looks like two different releases, and tracks filed under the odd one out go missing when you search by album.`,
          src.key)
      }
      const artists = [...new Set(list.map(t => t.artist_name).filter(has))]
      if (artists.length > 1 && new Set(artists.map(norm)).size > 1 && list.length > 2) {
        // A compilation legitimately has many track artists; only say something
        // when it looks like inconsistent spelling of ONE name.
        const stems = new Set(artists.map(a => norm(a).split(' ')[0]))
        if (stems.size === 1) {
          add('warn', 'artist-spelling',
            `${src.label}: catalogue ${list[0].catalogue_no} spells its artist ${artists.length} ways`,
            artists.map(a => `"${a}"`).join(' vs '),
            src.key)
        }
      }
      const dupTitles = [...new Map(list.map(t => [norm(t.title), t])).keys()]
      if (dupTitles.length < list.length) {
        add('warn', 'repeated-track',
          `${src.label}: catalogue ${list[0].catalogue_no} has the same track title more than once`,
          `${list.length} records, ${dupTitles.length} distinct titles — duplicate records, or two versions that need distinguishing.`,
          src.key)
      }
      const seqs = list.map(t => t.sequence_no).filter(s => Number.isFinite(s))
      if (seqs.length > 1 && new Set(seqs).size < seqs.length) {
        add('warn', 'repeated-sequence',
          `${src.label}: catalogue ${list[0].catalogue_no} repeats a track number`, null, src.key)
      }
    }
  }

  // ── cross-database disagreement ───────────────────────────────────────────
  // Same ISRC, different text in different databases. The Source tab shows
  // MadStreamer's value; this says plainly when the others disagree, so nobody
  // has to wonder whether the tab is stale (it isn't — that was the bug report
  // that started all this).
  if (entries.length > 1) {
    const seen = new Map()   // isrc → [{label, track}]
    for (const src of entries) {
      for (const t of src.tracks || []) {
        const k = String(t.isrc ?? '').trim().toUpperCase()
        if (!k || isJunk(k)) continue
        if (!seen.has(k)) seen.set(k, [])
        seen.get(k).push({ label: src.label, key: src.key, t })
      }
    }
    const FIELDS = [['title', 'title'], ['artist_name', 'artist'], ['album_title', 'album']]
    const disagree = []
    for (const [isrc, list] of seen) {
      // One representative per database. Without this, a database that has the
      // SAME ISRC on several of its own songs looks like it is disagreeing with
      // itself — that is the shared-ISRC fault above, reported separately.
      const perSource = new Map()
      for (const x of list) if (!perSource.has(x.key)) perSource.set(x.key, x)
      if (perSource.size < 2) continue
      const reps = [...perSource.values()]
      for (const [field, human] of FIELDS) {
        const vals = [...new Set(reps.map(x => x.t[field]).filter(has).map(norm))]
        if (vals.length > 1) { disagree.push({ isrc, field, human, reps }); break }
      }
    }
    if (disagree.length) {
      const d = disagree[0]
      const shown = d.reps.filter(x => has(x.t[d.field])).map(x => `${x.label}: "${x.t[d.field]}"`)
      add('info', 'cross-db-disagreement',
        `${plural(disagree.length, 'track')} where the databases disagree on the ${d.human}`,
        `e.g. ${d.isrc} — ${shown.join('  ·  ')}. You are shown MadStreamer's value.`)
    }
  }

  const order = { error: 0, warn: 1, info: 2 }
  return findings.sort((a, b) => order[a.severity] - order[b.severity])
}
