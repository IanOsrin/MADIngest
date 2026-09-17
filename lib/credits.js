/**
 * lib/credits.js — one reading of a credit string, shared by every MAM path.
 *
 * Credits arrive in Ingrooves' own form, role tags and all:
 *   "Pieter W. Grobbelaar <Lyricist>, Pieter W. Grobbelaar <Composer>"
 * and in MAM's list form, "Hamilton Nzimande; West Nkosi".
 *
 * Ian's rule (2026-09-17) for Music Arena Master:
 *   - the plural field (Composers) KEEPS the role tags — it is the credit as
 *     supplied, and who wrote the words versus the music is worth keeping;
 *   - the numbered slots (Composer, Composer 2 … 4) hold one plain name each,
 *     no tags, because they are read as names.
 */

const JUNK = new Set(['', '?', '#N/A', 'N/A', 'NA', '-', '0', 'NONE', 'NULL'])
const clean = v => {
  const s = String(v ?? '').trim()
  return JUNK.has(s.toUpperCase()) ? null : s
}

/**
 * Plain, de-duplicated names from any number of credit values. Role tags are
 * stripped, and a tagged value is split on commas as well as ';'. An untagged
 * value splits on ';' only: "Mankwane, Marks" is one name written surname-first.
 */
export function creditNames(...vals) {
  const seen = new Map()
  for (const v of vals.map(clean).filter(Boolean)) {
    const tagged = /<[^>]*>/.test(v)
    for (const part of v.split(tagged ? /[;,]/ : /;/)) {
      const name = part.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
    }
  }
  return [...seen.values()]
}

/**
 * MAM fieldData for a composer credit: Composers as supplied (tags kept),
 * Composer … Composer 4 one plain name each.
 *
 * `clearUnused` blanks the slots past the last name — right for an edit, where
 * a name that was removed must not linger in Composer 3. A fill of empty fields
 * leaves them out instead, so it never writes a blank.
 */
export function mamComposerFields(value, { clearUnused = true } = {}) {
  const raw = clean(value)
  const names = creditNames(raw)
  const out = { 'Composers': raw || '' }
  const slots = ['Composer', 'Composer 2', 'Composer 3', 'Composer 4']
  slots.forEach((slot, i) => {
    if (names[i]) out[slot] = names[i]
    else if (clearUnused) out[slot] = ''
  })
  // More than four writers: the plural field still carries them all.
  return out
}
