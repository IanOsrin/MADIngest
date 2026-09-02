/**
 * scripts/fix-and-commas.mjs — undo the old "and" → "," find/replace in MAM.
 *
 * Some time ago a replace of the literal "and" with "," was run over credit
 * fields, corrupting every name that CONTAINED "and": "Hamilton Nzimande"
 * became "Hamilton Nzim,e". It also injects commas that now read as list
 * separators, so multi-composer strings parse wrongly too.
 *
 * The rule that separates damage from genuine punctuation: a comma between a
 * letter and a LOWERCASE letter is a swallowed "and", because a real separator
 * is followed by a space or a capitalised name.
 *
 *     Nzim,e        -> Nzimande      (letter , lowercase  = damage)
 *     Paul,Hamilton -> unchanged     (capital after comma = a real list)
 *     Teme,H Nzim,e -> Teme,H Nzimande
 *
 * Case matters: the original replace was lower-case "and", so "Anderson" was
 * never touched. Fills EVERY affected field on the Songs layout.
 *
 *   node scripts/fix-and-commas.mjs                       # dry run against MAM
 *   node scripts/fix-and-commas.mjs --apply
 *   node scripts/fix-and-commas.mjs --db "MadStreamer" --layout API_Album_Songs \
 *        --fields "Composer,Composer 2,Composer 3,Composers"
 *
 * NEVER point this at Gallo CMS 2024's "Song Files" layout: paged reads of it
 * stall around offset ~5,800 and client aborts do NOT cancel the FileMaker-side
 * work, which once froze logins across all three databases.
 */
import 'dotenv/config'
const APPLY = process.argv.includes('--apply')
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const DB     = arg('db', 'Music Arena Master')
const LAYOUT = arg('layout', 'Songs')
if (/CMS/i.test(DB) && /song files/i.test(LAYOUT)) {
  console.error('Refusing: paged reads of CMS 2024 Song Files stall and freeze FileMaker for every database.')
  process.exit(1)
}
// The host is NOT assumed. MadStreamer lives on FMCloud while the other files
// live on digitalcupboard.app, and a backup copy of MadStreamer on the wrong
// host once absorbed a whole correction run that production never saw. Pass
// --host explicitly for anything that is not GALLO_FM_HOST.
const HOST = arg('host', process.env.GALLO_FM_HOST).replace(/^https?:\/\//, '').replace(/\/$/, '')
const USER = arg('user', process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER)
const PASS = process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS
const base = 'https://' + HOST + '/fmi/data/vLatest/databases/' + encodeURIComponent(DB)
const auth = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64')
const s = await (await fetch(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:'{}'})).json()
const H = { 'Content-Type':'application/json', Authorization: 'Bearer ' + s.response.token }

const DAMAGE = /([A-Za-z]),([a-z])/g
const repair = v => String(v).replace(DAMAGE, '$1and$2')

// Composer fields ONLY. A full-field dry run showed the corruption is confined
// to them; the handful of hits elsewhere were ordinary stray-comma typos that
// the rule would have made worse:
//   "That,s My Weakness Now"  — an apostrophe typed as a comma
//   "Marks Specia,l No. 7"    — stray comma mid-word
//   "Ton Den Teuling,xxxx,en" — junk
// Restoring "and" into those produces "Thatands", "Speciaandl". So they are out
// of scope and left for a human.
const FIELDS = arg('fields', 'Composers,Composer,Composer 2,Composer 3,Composer 4')
  .split(',').map(x => x.trim()).filter(Boolean)

const edits = []            // { recordId, patch }
const distinct = new Map()  // "field||before" -> { after, n }
let seen = 0
for (let off = 1; ; off += 500) {
  const r = await (await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records?_limit=500&_offset=${off}`, { headers: H })).json()
  const rows = r?.response?.data || []; if (!rows.length) break
  for (const x of rows) {
    seen++
    const patch = {}
    for (const f of FIELDS) {
      const v = x.fieldData[f]
      if (v == null || typeof v !== 'string' || !v.includes(',')) continue
      const fixed = repair(v)
      if (fixed === v) continue
      patch[f] = fixed
      const k = f + '||' + v
      const d = distinct.get(k) || { after: fixed, n: 0 }
      d.n++; distinct.set(k, d)
    }
    if (Object.keys(patch).length) edits.push({ recordId: x.recordId, patch })
  }
  if (seen % 20000 === 0) process.stderr.write(`  scanned ${seen}…\n`)
}

console.log(`host               : ${HOST}`)
console.log(`database / layout  : ${DB} / ${LAYOUT}`)
console.log(`fields             : ${FIELDS.join(', ')}`)
console.log(`songs scanned      : ${seen}`)
console.log(`songs to correct   : ${edits.length}`)
console.log(`distinct values    : ${distinct.size}\n`)
const byField = new Map()
for (const k of distinct.keys()) { const f = k.split('||')[0]; byField.set(f, (byField.get(f)||0)+1) }
console.log('affected fields:')
for (const [f,n] of [...byField.entries()].sort((a,b)=>b[1]-a[1])) console.log(`   ${String(n).padStart(4)} distinct value(s)  ${f}`)
console.log('\nevery distinct correction:')
for (const [k,d] of [...distinct.entries()].sort((a,b)=>b[1].n-a[1].n)) {
  const [f, before] = k.split('||')
  console.log(`  [${String(d.n).padStart(4)}] ${f}`)
  console.log(`         ${before}`)
  console.log(`      -> ${d.after}`)
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply'); await fetch(base+'/sessions/'+s.response.token,{method:'DELETE',headers:H}); process.exit(0) }

let ok = 0, fail = 0
for (const e of edits) {
  const w = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records/${e.recordId}`, { method:'PATCH', headers:H, body: JSON.stringify({ fieldData: e.patch }) })
  const j = await w.json()
  if (j?.messages?.[0]?.code === '0') ok++; else { fail++; if (fail < 6) console.warn('  FAIL', e.recordId, j?.messages?.[0]?.message) }
}
console.log(`\ncorrected ${ok}, failed ${fail}`)
await fetch(base+'/sessions/'+s.response.token,{method:'DELETE',headers:H})
