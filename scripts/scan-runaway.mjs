import 'dotenv/config'
const base = process.env.GALLO_FM_HOST + '/fmi/data/vLatest/databases/' + encodeURIComponent('Music Arena Master')
const auth = 'Basic ' + Buffer.from(process.env.GALLO_FM_USER + ':' + process.env.GALLO_FM_PASS).toString('base64')
const s = await (await fetch(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:'{}'})).json()
const H = { Authorization: 'Bearer ' + s.response.token }
const key = c => 'ALB-' + String(c||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,20)

let off = 1, seen = 0
const mismatch = []                 // AlbumID vs Album Catalogue disagree
const catCount = new Map()          // Album Catalogue -> songs carrying it
const blankCat = []
for (;;) {
  const r = await (await fetch(`${base}/layouts/Songs/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []
  if (!rows.length) break
  for (const x of rows) {
    const g = x.fieldData
    const id = String(g.AlbumID||'').trim(), cat = String(g['Album Catalogue']||'').trim()
    seen++
    if (!cat) { blankCat.push(g['Track Name']); continue }
    catCount.set(cat, (catCount.get(cat)||0)+1)
    if (id && key(cat) !== id) mismatch.push({ id, cat, title: g['Track Name'], seq: g['Sequence Number'], recordId: x.recordId })
  }
  off += 500
  if (seen % 10000 === 0) process.stderr.write(`  scanned ${seen}…\n`)
}
console.log('songs scanned          :', seen)
console.log('blank Album Catalogue  :', blankCat.length)
console.log('AlbumID/catalogue mismatch:', mismatch.length)
const byCat = new Map()
for (const m of mismatch) byCat.set(m.cat, (byCat.get(m.cat)||0)+1)
console.log('\ntop catalogues among mismatches:')
for (const [c,n] of [...byCat.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log('   %s  %d song(s)'.replace('%s',c.padEnd(18)).replace('%d',n), '')
console.log('\nfirst 15 mismatched songs:')
for (const m of mismatch.slice(0,15)) console.log('  ', m.id.padEnd(26), 'cat=' + m.cat.padEnd(16), String(m.title).slice(0,30))
await fetch(base+'/sessions/'+s.response.token,{method:'DELETE',headers:H})
