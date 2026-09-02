// Definitive sweep for the runaway Replace: the script filled blanks from ONE
// album, so its fingerprint is a single value appearing across many albums that
// have nothing to do with it. Read-only.
import 'dotenv/config'
const base = process.env.GALLO_FM_HOST + '/fmi/data/vLatest/databases/' + encodeURIComponent('Music Arena Master')
const auth = 'Basic ' + Buffer.from(process.env.GALLO_FM_USER + ':' + process.env.GALLO_FM_PASS).toString('base64')
const s = await (await fetch(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:'{}'})).json()
const H = { Authorization: 'Bearer ' + s.response.token }

// album artist per AlbumID
const albumArtist = new Map()
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${base}/layouts/Albums/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) albumArtist.set(x.fieldData.AlbumID, String(x.fieldData['Album Artist']||'').trim())
}
process.stderr.write(`albums: ${albumArtist.size}\n`)

const FIELDS = ['Track Artist','Genre','Language','Producers','Composers']
const spread = new Map()      // "field||value" -> Set(AlbumID)
let seen = 0
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${base}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData, id = g.AlbumID
    seen++
    for (const f of FIELDS) {
      const v = String(g[f]||'').trim()
      if (!v) continue
      const k = f + '||' + v
      if (!spread.has(k)) spread.set(k, new Set())
      spread.get(k).add(id)
    }
  }
  if (seen % 20000 === 0) process.stderr.write(`  ${seen}…\n`)
}
process.stderr.write(`songs: ${seen}\n\n`)

for (const f of FIELDS) {
  const rank = [...spread.entries()].filter(([k]) => k.startsWith(f+'||'))
    .map(([k,set]) => [k.slice(f.length+2), set.size]).sort((a,b)=>b[1]-a[1]).slice(0,6)
  console.log(`=== ${f} — values spread over the most albums ===`)
  for (const [v,n] of rank) console.log('   %s albums  %s'.replace('%s',String(n).padStart(5)).replace('%s',v.slice(0,60)))
  console.log()
}
await fetch(base+'/sessions/'+s.response.token,{method:'DELETE',headers:H})
