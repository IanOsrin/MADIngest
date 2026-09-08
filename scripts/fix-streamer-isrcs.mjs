/**
 * scripts/fix-streamer-isrcs.mjs — repair duplicated ISRCs in MadStreamer.
 *
 * MadStreamer's ISRC field is polluted: the same code was filled down across
 * runs of different songs. Measured 2026-09-08 against the Postgres mirror:
 * 542 ISRCs sit on more than one DIFFERENT song, over 1,734 records. GALP 1296
 * (Virginia Lee) is typical — 12 records, 7 distinct ISRCs, six different songs
 * all carrying USA2P1368841.
 *
 * The Gallo metadata extract is the source of truth (Ian, 2026-09-08). The plan
 * is built OFFLINE by matching catalogue + normalised title — never sequence
 * number, which disagrees between the databases (Streamer has "Ten Thousand
 * Miles" at seq 1, the extract at seq 12; matching on it would write the wrong
 * code into every row).
 *
 *   node scripts/fix-streamer-isrcs.mjs --plan <file>              # dry run
 *   node scripts/fix-streamer-isrcs.mjs --plan <file> --limit 5 --apply
 *   node scripts/fix-streamer-isrcs.mjs --plan <file> --apply
 *
 * Safety, all of it deliberate:
 *  - Dry run is the default; --apply is required to write.
 *  - Every record is RE-READ LIVE and both its Track Name and its current ISRC
 *    must match the plan before anything is written. The plan is built from the
 *    mirror, which is a nightly snapshot — a record edited since then, or a
 *    recordId now pointing at a different record, is SKIPPED, not overwritten.
 *  - A rollback journal is appended BEFORE each write, so an interrupted run is
 *    still fully reversible.
 *  - Writes are serial with a pause. Concurrency against this FM host is what
 *    froze logins across all three databases on 2026-08-18.
 *  - The host is explicit. MadStreamer is on FMCloud while the other files are
 *    on digitalcupboard.app, and a backup copy on the wrong host once absorbed
 *    an entire correction run that production never saw.
 */
import 'dotenv/config'
import { readFileSync, appendFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }

const PLAN_FILE = arg('plan')
if (!PLAN_FILE) { console.error('--plan <file> is required'); process.exit(1) }
const LIMIT   = Number(arg('limit', '0')) || 0
const PAUSE   = Number(arg('pause', '120'))
const DB      = arg('db', 'MADStreamer')
const LAYOUT  = arg('layout', 'API_Album_Songs')
const HOST    = arg('host', process.env.MADSTREAMER_FM_HOST || 'digitalcupboard.fmcloud.fm')
                  .replace(/^https?:\/\//, '').replace(/\/$/, '')
const USER    = process.env.MADSTREAMER_FM_USER || process.env.GALLO_FM_USER
const PASS    = process.env.MADSTREAMER_FM_PASS || process.env.GALLO_FM_PASS
const JOURNAL = arg('journal', `./isrc-repair-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)

if (/CMS/i.test(DB)) { console.error('Refusing: this script is for MadStreamer only.'); process.exit(1) }

const base = `https://${HOST}/fmi/data/vLatest/databases/${encodeURIComponent(DB)}`
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const { plan } = JSON.parse(readFileSync(PLAN_FILE, 'utf8'))
const work = LIMIT ? plan.slice(0, LIMIT) : plan

console.log(`host   ${HOST}`)
console.log(`db     ${DB} / ${LAYOUT}`)
console.log(`plan   ${work.length}${LIMIT ? ` of ${plan.length} (--limit)` : ''} records`)
console.log(`mode   ${APPLY ? 'APPLY — writing to live FileMaker' : 'DRY RUN'}`)
if (APPLY) console.log(`journal ${JOURNAL}`)
console.log()

const login = await (await fetch(`${base}/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') },
  body: '{}',
})).json()
const token = login?.response?.token
if (!token) { console.error('login failed:', JSON.stringify(login)); process.exit(1) }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

const tally = { written: 0, wouldWrite: 0, alreadyCorrect: 0, driftedIsrc: 0, driftedTitle: 0, missing: 0, failed: 0 }
const skipped = []

for (const [i, p] of work.entries()) {
  const r = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records/${p.recordId}`, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { tally.missing++; skipped.push({ ...p, why: `record not readable (${j?.messages?.[0]?.message || r.status})` }); continue }

  const fd  = j?.response?.data?.[0]?.fieldData || {}
  const cur = String(fd.ISRC ?? '').trim().toUpperCase()

  // Verify against LIVE data, not the snapshot the plan was built from.
  if (norm(fd['Track Name']) !== norm(p.title)) {
    tally.driftedTitle++
    skipped.push({ ...p, why: `title changed — live "${fd['Track Name']}" vs plan "${p.title}"` })
    continue
  }
  if (cur === p.to)   { tally.alreadyCorrect++; continue }
  if (cur !== p.from) {
    tally.driftedIsrc++
    skipped.push({ ...p, why: `ISRC changed since the plan — live "${cur}" vs expected "${p.from}"` })
    continue
  }

  if (!APPLY) {
    tally.wouldWrite++
    if (tally.wouldWrite <= 8) console.log(`  would set ${p.recordId}  ${(p.cat||'').padEnd(13)} ${(p.title||'').slice(0,34).padEnd(34)} ${cur} → ${p.to}`)
    continue
  }

  // Journal BEFORE the write, so an interrupted run is still reversible.
  appendFileSync(JOURNAL, JSON.stringify({ recordId: p.recordId, field: 'ISRC', from: cur, to: p.to, title: fd['Track Name'], cat: p.cat, at: new Date().toISOString() }) + '\n')

  const w = await fetch(`${base}/layouts/${encodeURIComponent(LAYOUT)}/records/${p.recordId}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ fieldData: { ISRC: p.to } }),
  })
  if (!w.ok) {
    const wj = await w.json().catch(() => ({}))
    tally.failed++
    skipped.push({ ...p, why: `write failed: ${wj?.messages?.[0]?.message || w.status}` })
  } else {
    tally.written++
    if (tally.written % 50 === 0) console.log(`  … ${tally.written} written`)
  }
  await sleep(PAUSE)
}

await fetch(`${base}/sessions/${token}`, { method: 'DELETE', headers: H }).catch(() => {})

console.log('\n' + '─'.repeat(50))
for (const [k, v] of Object.entries(tally)) if (v) console.log(`  ${k.padEnd(16)} ${v}`)
if (skipped.length) {
  console.log(`\n  ${skipped.length} skipped:`)
  for (const s of skipped.slice(0, 15)) console.log(`   ${s.recordId} ${(s.cat||'').padEnd(12)} ${s.why}`)
  if (skipped.length > 15) console.log(`   … and ${skipped.length - 15} more`)
}
if (APPLY && tally.written) console.log(`\nrollback journal: ${JOURNAL}`)
process.exit(tally.failed ? 1 : 0)
