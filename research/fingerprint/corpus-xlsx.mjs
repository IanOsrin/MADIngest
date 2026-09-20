import XLSX from '/Users/ianosrin/Desktop/GalloIngestV1.2/node_modules/xlsx/xlsx.js'
import { readFileSync, existsSync, statSync } from 'node:fs'
const LAB = process.env.FP_LAB || '/Volumes/Bandlab/fingerprint-lab'
const corpus = JSON.parse(readFileSync(`${LAB}/corpus.json`, 'utf8'))
const HELD = 20

// per-track outcome from the baseline run, if it has been scored
const results = existsSync(`${LAB}/results.csv`) ? readFileSync(`${LAB}/results.csv`, 'utf8').trim().split('\n') : []
const head = results.length ? results[0].split(',') : []
const rows = results.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])))
const per = {}
for (const r of rows) {
  const t = r.truth
  per[t] ||= { queries: 0, found: 0 }
  per[t].queries++
  if (r.correct === 'True' && parseFloat(r.score) >= 0.72) per[t].found++
}

const out = corpus.map((r, i) => {
  const file = `${LAB}/refs/${r.filename}.mp3`
  const p = per[r.filename] || {}
  return {
    '#': i + 1,
    Filename: r.filename,
    Track: r.track,
    Artist: r.artist,
    Album_catalogue: r.cat,
    Genre: r.genre,
    Decade: r.decade === '0000' ? '' : r.decade,
    Duration: r.dur,
    ISRC: r.isrc,
    Downloaded: existsSync(file) ? (statSync(file).size / 1048576).toFixed(1) + ' MB' : 'FAILED (403)',
    Role: i >= corpus.length - HELD ? 'held back (negative)' : 'in index',
    Queries_made: p.queries ?? '',
    Found_at_0_72: p.found ?? '',
  }
})
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'Fingerprint corpus')
const dest = '/Users/ianosrin/Desktop/Ian stuff/Fingerprint_Corpus_200_2026-09-20.xlsx'
XLSX.writeFile(wb, dest)
console.log('written:', dest, '·', out.length, 'tracks ·', out.filter(r => r.Downloaded.includes('FAILED')).length, 'failed downloads')
