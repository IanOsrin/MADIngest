/**
 * lib/madmixer-hq.js — HQ stems for Mad Mixer (Ian, 2026-10-08): the studio stems of a catalogue song.
 *
 * The stems stay on Vision, in a dedicated HQ folder (Ian: "No S3 needed, we will create a dedicated Vision
 * folder"); MAD streams them to Mad Mixer subscribers on signed links, and only from inside that folder (MAD's
 * MIXER_HQ_VISION_PREFIX). Publishing writes one record per stem in MADMixer's HQ_Stems table (layout
 * "HQ_Stems"): Song_ID (the MADMixer Songs record id), Song_Title, Stem_Label, File_Name, Vision_Path, Bytes,
 * Seconds, Sort, Visible (0 hides). Mad Mixer lists them under 🎚 Load HQ Stems.
 * Writes only through upsertHqStem(): find by Song_ID + File_Name, update or create (Visible 1 on create only).
 */
import { fm } from './madmixer-packs.js'

const HQ = `/layouts/${encodeURIComponent(process.env.MADMIXER_FM_HQ_LAYOUT || 'HQ_Stems')}`
const SONGS = `/layouts/${encodeURIComponent(process.env.MADMIXER_FM_SONGS_LAYOUT || 'Songs')}`
export const HQ_FIELDS = ['Song_ID', 'Song_Title', 'Stem_Label', 'File_Name', 'Vision_Path', 'Bytes', 'Seconds', 'Sort', 'Visible']
// The dedicated Vision folder (the same value as MAD's MIXER_HQ_VISION_PREFIX). Unset here: GalloIngest only warns.
export const hqVisionPrefix = () => { const p = String(process.env.MIXER_HQ_VISION_PREFIX || '').trim(); return p ? (p.startsWith('/') ? p : '/' + p).replace(/\/*$/, '/') : '' }

// A stem's label from its file name: "727 Lead Vox.wav" → Vocals; else the name itself.
const LABELS = [
  [/backing|bvox|bv\b|harmon/i, 'Backing Vocals'], [/vocal|vox|voice|lead\s*v/i, 'Vocals'], [/kick|bd\b/i, 'Kick'],
  [/snare/i, 'Snare'], [/hi.?hat|hats?\b|cymbal|overhead|\boh\b/i, 'Cymbals'], [/perc|conga|shaker|tamb/i, 'Percussion'],
  [/drum|kit\b/i, 'Drums'], [/bass/i, 'Bass'], [/gtr|guitar/i, 'Guitar'], [/piano|keys|organ|rhodes/i, 'Keys'],
  [/synth|pad\b/i, 'Synth'], [/string|violin|cello/i, 'Strings'], [/brass|horn|sax|trumpet|trombone/i, 'Brass'],
  [/accordion|concertina/i, 'Accordion'], [/other|rest|fx/i, 'Other'],
]
export const ORDER = ['Vocals', 'Backing Vocals', 'Drums', 'Kick', 'Snare', 'Cymbals', 'Percussion', 'Bass', 'Guitar', 'Keys', 'Accordion', 'Synth', 'Strings', 'Brass', 'Other']
export function labelFor(file) {
  const base = file.replace(/\.[^.]+$/, '')
  for (const [re, label] of LABELS) if (re.test(base)) return label
  return base.replace(/[_]+/g, ' ').trim().slice(0, 40) || 'Stem'
}

export async function checkHqLayout() {
  const m = await fm('GET', HQ)
  if (m.code !== '0') return { ok: false, error: `MADMixer "HQ_Stems" layout: ${m.message}` }
  const have = new Set((m.response.fieldMetaData || []).map((f) => f.name))
  const missing = HQ_FIELDS.filter((f) => !have.has(f))
  return missing.length ? { ok: false, error: `Not on the "HQ_Stems" layout: ${missing.join(', ')}` } : { ok: true }
}

export async function listHqStems() {
  const out = []
  for (let off = 1; ; off += 500) {
    const r = await fm('GET', `${HQ}/records?_offset=${off}&_limit=500`)
    if (r.code === '401' || r.code === '101') break   // no records (an empty table answers 101 "Record is missing")
    if (r.code !== '0') throw new Error(`MADMixer HQ stems: ${r.message}`)
    out.push(...(r.response.data || []).map((d) => ({ recordId: d.recordId, ...d.fieldData })))
    if ((r.response.data || []).length < 500) break
  }
  return out
}

export function groupHq(records) {
  const by = new Map()
  for (const r of records) {
    const id = String(r.Song_ID || '').trim()
    if (!by.has(id)) by.set(id, { songId: id, title: r.Song_Title || '', stems: 0, hidden: 0, labels: [] })
    const s = by.get(id); s.stems++; if (String(r.Visible ?? '').trim() === '0') s.hidden++; s.labels.push(r.Stem_Label)
  }
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title))
}

// Mad Mixer songs by title or artist (the MADMixer Songs layout — the list the Mixer itself shows).
export async function searchSongs(q) {
  const term = String(q || '').trim().replace(/[=!<>…@#*"~\\]/g, ' ').slice(0, 60)
  if (term.length < 2) return []
  const r = await fm('POST', `${SONGS}/_find`, { query: [{ 'Track Name': term }, { 'Track Artist': term }], limit: 40 })
  if (r.code === '401') return []
  if (r.code !== '0') throw new Error(`MADMixer songs: ${r.message}`)
  return (r.response.data || []).map((d) => ({ songId: String(d.recordId), title: d.fieldData['Track Name'] || '', artist: d.fieldData['Track Artist'] || '',
    album: d.fieldData['Album Title'] || '', duration: d.fieldData.Duration || '', hasMp3: /^https:\/\//.test(String(d.fieldData.Audio_S3_URL || '')) }))
}

export async function upsertHqStem(f) {
  const fields = { Song_ID: f.Song_ID, Song_Title: f.Song_Title, Stem_Label: f.Stem_Label, File_Name: f.File_Name, Vision_Path: f.Vision_Path,
    Bytes: f.Bytes, Seconds: f.Seconds, Sort: f.Sort }
  const q = (v) => `=="${String(v).replace(/"/g, '\\"')}"`
  const found = await fm('POST', `${HQ}/_find`, { query: [{ Song_ID: q(f.Song_ID), File_Name: q(f.File_Name) }], limit: 2 })
  if (found.code === '0' && found.response.data?.length) {
    const id = found.response.data[0].recordId
    const r = await fm('PATCH', `${HQ}/records/${id}`, { fieldData: fields })
    if (r.code !== '0') throw new Error(`update ${f.File_Name}: ${r.message}`)
    return { action: 'updated', recordId: id }
  }
  if (found.code !== '401' && found.code !== '0') throw new Error(`find ${f.File_Name}: ${found.message}`)
  const r = await fm('POST', `${HQ}/records`, { fieldData: { ...fields, Visible: 1 } })
  if (r.code !== '0') throw new Error(`create ${f.File_Name}: ${r.message}`)
  return { action: 'created', recordId: r.response.recordId }
}
