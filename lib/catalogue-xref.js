/**
 * lib/catalogue-xref.js
 * Three-way album catalogue cross-reference across CMS 2024 (Tape Files
 * Master), Gallo Catalogue (API_Tape_Files) and MadStreamer (API_Albums_Head).
 *
 * The built table is cached as JSON in S3 (metadata/Catalogue_XRef.json) so
 * local and hosted instances share one build and the tab loads instantly.
 * Rebuilding re-scans all three album-level layouts over the Data API —
 * gentle paging only (small pages, pauses, one retry, page-shrink, and a
 * hard stop after two consecutive failed windows). Album-level layouts are
 * the safe ones; song layouts must never be bulk-scanned.
 */

import { uploadAnyKey, downloadAnyKey } from './s3-imports.js'

const XREF_KEY = 'metadata/Catalogue_XRef.json'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')

// ── DB scan configs (album-level layouts only) ──────────────────────────────
const httpsHost = h => 'https://' + String(h || '').replace(/^https?:\/\//, '')
function scanConfigs() {
  return [
    {
      db: 'cms',
      host: httpsHost(process.env.CMS2024_FM_HOST || 'digitalcupboard.app'),
      database: process.env.CMS2024_FM_DB || 'Gallo CMS 2024',
      layout: 'Tape Files Master',
      user: process.env.CMS2024_FM_USER || process.env.GALLO_FM_USER,
      pass: process.env.CMS2024_FM_PASS || process.env.GALLO_FM_PASS,
      fields: { album: 'Album Catalogue Number', ref: 'Reference Catalogue Number', title: 'Album Title', artist: 'Album Artist' },
    },
    {
      db: 'gallo',
      host: httpsHost(process.env.GALLO_FM_HOST),
      database: process.env.GALLO_FM_DB || 'Gallo Catalogue',
      layout: process.env.GALLO_FM_TAPE_LAYOUT || 'API_Tape_Files',
      user: process.env.GALLO_FM_USER,
      pass: process.env.GALLO_FM_PASS,
      fields: { album: 'Album Catalogue Number', ref: 'Reference Catalogue Number', title: 'Album Title', artist: 'Album Artist' },
    },
    {
      db: 'streamer',
      host: httpsHost(process.env.MADSTREAMER_FM_HOST),
      database: process.env.MADSTREAMER_FM_DB || 'MadStreamer',
      layout: 'API_Albums_Head',
      user: process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER,
      pass: process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS,
      fields: { album: 'Album Catalogue Number', ref: null, title: 'Album Title', artist: 'Album Artist' },
    },
  ]
}

// ── in-memory state ─────────────────────────────────────────────────────────
let _xref = null           // { builtAt, source, rows:[{cat,cms,gallo,streamer,title,artist}] }
let _loadPromise = null
const _job = { running: false, phase: '', scanned: 0, total: 0, error: null }

async function _loadFromS3() {
  const { buffer } = await downloadAnyKey(XREF_KEY)
  const parsed = JSON.parse(buffer.toString('utf8'))
  if (!Array.isArray(parsed?.rows)) throw new Error('bad xref JSON')
  return parsed
}

async function ensureLoaded() {
  if (_xref) return _xref
  if (!_loadPromise) {
    _loadPromise = _loadFromS3()
      .then(x => { _xref = x; return x })
      .catch(() => null)                        // no build yet — tab shows "never built"
      .finally(() => { _loadPromise = null })
  }
  await _loadPromise
  return _xref
}

function summarize(rows) {
  const c = f => rows.filter(f).length
  return {
    total: rows.length,
    cms: c(r => r.cms), gallo: c(r => r.gallo), streamer: c(r => r.streamer),
    all_three: c(r => r.cms && r.gallo && r.streamer),
    cms_only: c(r => r.cms && !r.gallo && !r.streamer),
    cms_not_gallo: c(r => r.cms && !r.gallo),
    cms_not_streamer: c(r => r.cms && !r.streamer),
    gallo_not_cms: c(r => r.gallo && !r.cms),
    gallo_not_streamer: c(r => r.gallo && !r.streamer),
    streamer_not_cms: c(r => r.streamer && !r.cms),
    streamer_not_gallo: c(r => r.streamer && !r.gallo),
  }
}

const FILTERS = {
  all: () => true,
  all_three: r => r.cms && r.gallo && r.streamer,
  cms_only: r => r.cms && !r.gallo && !r.streamer,
  cms_not_gallo: r => r.cms && !r.gallo,
  cms_not_streamer: r => r.cms && !r.streamer,
  gallo_not_cms: r => r.gallo && !r.cms,
  gallo_not_streamer: r => r.gallo && !r.streamer,
  streamer_not_cms: r => r.streamer && !r.cms,
  streamer_not_gallo: r => r.streamer && !r.gallo,
}

export async function getXrefStatus() {
  const x = await ensureLoaded()
  return {
    builtAt: x?.builtAt || null,
    source: x?.source || null,
    summary: x ? summarize(x.rows) : null,
    rebuild: { running: _job.running, phase: _job.phase, scanned: _job.scanned, error: _job.error },
  }
}

export async function getXrefRows({ filter = 'all', q = '' } = {}) {
  const x = await ensureLoaded()
  if (!x) return null
  const f = FILTERS[filter] || FILTERS.all
  let rows = x.rows.filter(f)
  const needle = String(q || '').trim().toUpperCase()
  if (needle) rows = rows.filter(r =>
    r.cat.includes(needle) ||
    String(r.title || '').toUpperCase().includes(needle) ||
    String(r.artist || '').toUpperCase().includes(needle))
  return { builtAt: x.builtAt, filter, q, count: rows.length, rows }
}

// ── rebuild (background) ────────────────────────────────────────────────────
async function fmLogin(cfg) {
  const base = `${cfg.host}/fmi/data/vLatest/databases/${encodeURIComponent(cfg.database)}`
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  const token = (await res.json())?.response?.token
  if (!token) throw new Error(`${cfg.db}: FM login failed`)
  return { base, token }
}

async function scanAlbumLayout(cfg, onProgress) {
  let { base, token } = await fmLogin(cfg)
  const out = []
  let offset = 1
  let consecutiveFailures = 0

  const fetchPage = async (off, limit) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(
          `${base}/layouts/${encodeURIComponent(cfg.layout)}/records?_limit=${limit}&_offset=${off}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90000) })
        const json = await res.json().catch(() => ({}))
        if (res.ok) return json?.response?.data || []
        const code = json?.messages?.[0]?.code
        if (code === '952' || res.status === 401) { ({ base, token } = await fmLogin(cfg)); continue }
        throw new Error(json?.messages?.[0]?.message || `HTTP ${res.status}`)
      } catch (e) {
        if (attempt === 2) return null
        await sleep(15000)
      }
    }
    return null
  }

  for (;;) {
    let limit = 200
    let page = await fetchPage(offset, limit)
    while (page === null && limit > 25) {
      limit = Math.max(25, Math.floor(limit / 4))
      await sleep(8000)
      page = await fetchPage(offset, limit)
    }
    if (page === null) {
      offset += 25                              // skip the stuck window
      if (++consecutiveFailures >= 2) throw new Error(`${cfg.db}: two consecutive stalled windows — scan aborted to protect the server`)
      await sleep(20000)
      continue
    }
    consecutiveFailures = 0
    out.push(...page)
    offset += page.length
    onProgress?.(out.length)
    if (page.length < limit) break
    await sleep(300)
  }
  return out
}

export function startXrefRebuild() {
  if (_job.running) return { started: false, reason: 'already running' }
  _job.running = true
  _job.phase = 'starting'
  _job.scanned = 0
  _job.error = null

  ;(async () => {
    try {
      const map = new Map()
      const add = (cat, db, title, artist) => {
        const k = norm(cat); if (!k) return
        let e = map.get(k)
        if (!e) { e = { cat: k, cms: false, gallo: false, streamer: false, title: '', artist: '' }; map.set(k, e) }
        e[db] = true
        if (!e.title && title) e.title = String(title).trim()
        if (!e.artist && artist) e.artist = String(artist).trim()
      }
      // gallo first so its titles/artists win where a catalogue exists in several DBs
      const order = ['gallo', 'cms', 'streamer']
      const configs = scanConfigs().sort((a, b) => order.indexOf(a.db) - order.indexOf(b.db))
      for (const cfg of configs) {
        _job.phase = `scanning ${cfg.database}`
        _job.scanned = 0
        const records = await scanAlbumLayout(cfg, n => { _job.scanned = n })
        for (const r of records) {
          const f = r.fieldData || {}
          add(f[cfg.fields.album], cfg.db, f[cfg.fields.title], f[cfg.fields.artist])
          if (cfg.fields.ref) add(f[cfg.fields.ref], cfg.db, f[cfg.fields.title], f[cfg.fields.artist])
        }
      }
      const rows = [...map.values()].sort((a, b) => a.cat.localeCompare(b.cat))
      const built = { builtAt: new Date().toISOString(), source: 'live rebuild', rows }
      _job.phase = 'saving'
      await uploadAnyKey(Buffer.from(JSON.stringify(built)), XREF_KEY, 'application/json')
      _xref = built
      _job.phase = 'done'
    } catch (e) {
      _job.error = e.message
      _job.phase = 'failed'
      console.error('[xref] rebuild failed:', e.message)
    } finally {
      _job.running = false
    }
  })()

  return { started: true }
}
