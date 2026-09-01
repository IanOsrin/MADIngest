/**
 * lib/language-codes.js — ISO language code <-> the name Gallo writes.
 *
 * DDEX deliveries state a code ("en"); MAM wants the code in `Language Code`
 * and the spelled-out name in `Language`. The names here are the ones already
 * used in the catalogue, taken from an 8,000-song sample — not a generic ISO
 * list. "Southern Sotho" rather than "Sesotho", because that is what the
 * existing rows say.
 *
 * zxx is the ISO code for "no linguistic content". Gallo's own rows spell it
 * **Instrumental**, which is what an instrumental track is, so that convention
 * is kept rather than writing a code-ish word into a human field.
 *
 * An unknown code is NOT guessed at: the code is stored and the name left
 * empty, so it shows up as something to decide rather than as a wrong answer.
 */

const NAMES = {
  // In the catalogue today
  zxx: 'Instrumental',
  en:  'English',
  af:  'Afrikaans',
  zu:  'Zulu',
  xh:  'Xhosa',
  st:  'Southern Sotho',
  nso: 'Northern Sotho',
  ts:  'Tsonga',
  ss:  'Swati',
  sn:  'Shona',
  pt:  'Portuguese',
  el:  'Greek',
  sw:  'Swahili',
  fr:  'French',
  // The remaining South African official languages — not yet seen in the
  // sample, but a delivery can carry them and a blank is worse than a name.
  tn:  'Tswana',
  ve:  'Venda',
  nr:  'Southern Ndebele',
  // Occasional others
  de:  'German',
  es:  'Spanish',
  it:  'Italian',
  nl:  'Dutch',
  sh:  'Shona',
  ny:  'Chichewa',
  rw:  'Kinyarwanda',
  lg:  'Ganda',
  yo:  'Yoruba',
  ig:  'Igbo',
  ha:  'Hausa',
  sw_ke: 'Swahili',
}

// Reverse lookup, so a name arriving where a code belongs still resolves.
const CODES = Object.fromEntries(
  Object.entries(NAMES).map(([c, n]) => [n.toLowerCase(), c]).reverse())

/**
 * Split whatever a delivery states into { code, name }.
 * Accepts a code ("en", "EN", "en-ZA") or a name ("English").
 * Unknown input is returned as a code with no name, never as a guess.
 */
export function languageParts(raw) {
  const s = String(raw || '').trim()
  if (!s) return { code: null, name: null }
  const base = s.toLowerCase().replace(/[_\s]+/g, '-').split('-')[0]
  if (NAMES[base]) return { code: base, name: NAMES[base] }
  // three-letter codes like "nso" survive the split above unchanged
  if (NAMES[s.toLowerCase()]) return { code: s.toLowerCase(), name: NAMES[s.toLowerCase()] }
  const asName = CODES[s.toLowerCase()]
  if (asName) return { code: asName, name: NAMES[asName] }
  // Looks like a code (2-3 letters) — keep it, admit we have no name for it.
  if (/^[a-z]{2,3}$/i.test(s)) return { code: s.toLowerCase(), name: null }
  // Otherwise it reads as a name we do not know; keep it as the name.
  return { code: null, name: s }
}

export default languageParts
