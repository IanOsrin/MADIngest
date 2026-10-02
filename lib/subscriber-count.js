/**
 * lib/subscriber-count.js — how many people can listen on Music Africa Direct right now, and who
 * they are by kind (Ian, 2026-10-02: "add a subscriber count to the Listening tab").
 *
 * Source: MadStreamer API_Access_Tokens, one record per access code. The table is untidy — the kind
 * of code is spelled seven ways (Valid / valid / subscription / Subscription / subscriptions /
 * trial / blank) and ~12,000 pre-made codes have never been used — so the kind is read from what
 * the code IS, not from Token_Type alone:
 *   - FREE TRIAL  — Token_Type "trial", or Notes say "free trial";
 *   - PAYING      — bought: Notes record a Paystack purchase / subscription, or a price was paid;
 *   - GIVEN FREE  — everything else: codes handed out by name (staff, friends, the Play review
 *                   code), most with no expiry, some as R0 30-day passes.
 * "Can listen now" = switched on (Active 1) AND (expiry still ahead, OR no expiry but used before).
 * Expiration_Date is written by the MAD site in UTC (lib/subscriptions.js fmStamp on Render).
 */
import { fetchAccessCodes } from './madstreamer.js'
import { parseFmTimestamp } from './stream-report.js'

const DAY = 24 * 60 * 60 * 1000
const txt = v => String(v ?? '').trim()

export function kindOf(f) {
  const type = txt(f.Token_Type).toLowerCase()
  const notes = txt(f.Notes).toLowerCase()
  if (type === 'trial' || notes.includes('free trial')) return 'trial'
  const paid = Number(txt(f.Token_Value_Final || f.Token_Value).replace(/[^\d.]/g, '')) > 0
  if (notes.includes('paystack') || notes.includes('sub:') || paid) return 'paying'
  return 'free'
}

export function summariseCodes(codes, now = Date.now()) {
  const out = {
    now: { total: 0, paying: 0, trial: 0, free: 0 },
    newThisWeek: { total: 0, paying: 0, trial: 0, free: 0 },
    endedLast30: { total: 0, paying: 0, trial: 0, free: 0 },
  }
  for (const f of codes) {
    const exp = parseFmTimestamp(f.Expiration_Date) || null
    const used = !!txt(f.First_Used)
    const kind = kindOf(f)
    const canListen = exp ? exp > now : used
    if (canListen) { out.now.total++; out.now[kind]++ }
    else if (exp && exp > now - 30 * DAY) { out.endedLast30.total++; out.endedLast30[kind]++ }
    const issued = parseFmTimestamp(f.Issued_Date) || parseFmTimestamp(f.First_Used)
    if (canListen && issued && issued > now - 7 * DAY) { out.newThisWeek.total++; out.newThisWeek[kind]++ }
  }
  return out
}

let cache = null
/** Cached five minutes: the number moves slowly and the table is a FileMaker round trip. */
export async function subscriberCount({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.value
  const codes = await fetchAccessCodes()
  const value = { ...summariseCodes(codes), codesRead: codes.length, asOf: new Date().toISOString() }
  cache = { at: Date.now(), value }
  return value
}
