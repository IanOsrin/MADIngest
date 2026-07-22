#!/usr/bin/env node
// READ-ONLY probe: pull a sample of Gallo Catalogue records and dump only the
// audio-reference fields so we can see how audio is stored. No writes.
import 'dotenv/config'

const HOST = process.env.GALLO_FM_HOST
const DB = process.env.GALLO_FM_DB
const USER = process.env.GALLO_FM_USER
const PASS = process.env.GALLO_FM_PASS
const LAYOUT = process.env.GALLO_FM_LAYOUT
const base = `${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`

const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
const login = await fetch(`${base}/sessions`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' })
const lj = await login.json()
const token = lj?.response?.token
if (!token) { console.error('login failed', JSON.stringify(lj)); process.exit(1) }

const limit = Number(process.argv[2] || 25)
const res = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=${limit}`, {
  headers: { Authorization: `Bearer ${token}` },
})
const j = await res.json()
const rows = j?.response?.data || []

const AUDIO_FIELDS = ['Audio File', 'Audio', 'WAV', 'Audio Container', 'Filename', 'Filename.wav',
  'File URL', 'Audio URL', 'S3 URL', 'Pending Audio Path', 'Album Catalogue Number', 'Track Name']

console.log(`# ${rows.length} Gallo Catalogue records — audio reference fields\n`)
rows.forEach((r, i) => {
  const f = r.fieldData || {}
  const shown = {}
  for (const k of AUDIO_FIELDS) {
    const v = f[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') shown[k] = String(v)
  }
  console.log(`── record ${i + 1} (id ${r.recordId}) ──`)
  for (const [k, v] of Object.entries(shown)) console.log(`  ${k}: ${v.replace(/\n/g, ' ⏎ ')}`)
  console.log('')
})

// Log out (free the session slot)
await fetch(`${base}/sessions/${token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
