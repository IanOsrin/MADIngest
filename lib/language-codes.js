/**
 * lib/language-codes.js
 * Translates a human-readable language name to an ISO 639-2 (three-letter) code.
 * Used when writing to FileMaker's "Language Code" field — the "Language" field
 * always receives the raw name; this code is only for the code field.
 *
 * Returns undefined (not null) when the name isn't recognised, so callers can
 * skip writing the field entirely rather than storing a blank string.
 */

// Keys are lowercase + trimmed for case-insensitive lookup.
// Codes match the FileMaker "Language Code" value list exactly.
const _MAP = {
  // South Africa's official languages
  'afrikaans':          'af',
  'english':            'en',
  'zulu':               'zu',
  'isizulu':            'zu',
  'xhosa':              'xh',
  'isixhosa':           'xh',
  'northern sotho':     'nso',
  'northern sotho (pedi)': 'nso',
  'sepedi':             'nso',
  'pedi':               'nso',
  'sesotho sa leboa':   'nso',
  'sotho':              'st',
  'southern sotho':     'st',
  'sesotho':            'st',
  'tswana':             'tn',
  'setswana':           'tn',
  'tsonga':             'ts',
  'tsonga (shangaan)':  'ts',
  'xitsonga':           'ts',
  'shangaan':           'ts',
  'swazi':              'ss',
  'swati':              'ss',
  'siswati':            'ss',
  'venda':              've',
  'tshivenda':          've',
  'northern ndebele':   'nd',
  'ndebele':            'nr',
  'south ndebele':      'nr',
  'isindebele':         'nr',

  // Other languages visible in FileMaker list
  'french':             'fr',
  'italian':            'it',
  'portuguese':         'pt',
  'portugese':          'pt',
  'shona':              'sn',
  'chishona':           'sn',
  'swahili':            'sw',
  'kiswahili':          'sw',
  'nyanja':             'ny',
  'chichewa':           'ny',
  'herero':             'hz',
  'greek':              'el',
  'instrumental':       'zxx',
  'no linguistic content': 'zxx',
}

/**
 * @param {string|null|undefined} name  Language display name, e.g. "Zulu"
 * @returns {string|undefined}          ISO 639-2 code (e.g. "zul") or undefined if unknown
 */
export function languageNameToCode(name) {
  if (!name) return undefined
  return _MAP[name.trim().toLowerCase()]
}

// ── code → display name ─────────────────────────────────────────────────────
// The other direction, added for DDEX imports: a delivery states a CODE ("en")
// and MAM wants the spelled-out name in Language with the code in Language
// Code. Names are the spellings already in the catalogue (measured over an
// 8,000-song sample), so imports match what is there rather than introducing a
// second way of writing the same language — "Southern Sotho", not "Sesotho".
//
// zxx is ISO's "no linguistic content"; Gallo's own rows spell it
// "Instrumental", which is also what the track is, so that convention is kept.
const _NAMES = {
  af: 'Afrikaans', en: 'English', zu: 'Zulu', xh: 'Xhosa',
  nso: 'Northern Sotho', st: 'Southern Sotho', tn: 'Tswana', ts: 'Tsonga',
  ss: 'Swati', ve: 'Venda', nr: 'Southern Ndebele', nd: 'Northern Ndebele',
  fr: 'French', it: 'Italian', pt: 'Portuguese', sn: 'Shona', sw: 'Swahili',
  ny: 'Chichewa', hz: 'Herero', el: 'Greek', zxx: 'Instrumental',
  de: 'German', es: 'Spanish', nl: 'Dutch',
}

/** @param {string} code ISO code → display name, or undefined if unknown. */
export function languageCodeToName(code) {
  if (!code) return undefined
  return _NAMES[String(code).trim().toLowerCase()]
}

/**
 * Split whatever a source states into { code, name }, accepting either.
 * Handles "en", "EN", "en-ZA", "eng", "English", "isiZulu".
 *
 * An unrecognised code keeps the code and leaves the name null rather than
 * guessing — a wrong language name is worse than a blank one, and a blank
 * shows up as something to decide.
 */
export function languageParts(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { code: null, name: null }

  // A name we know (including every alias above)
  const asCode = languageNameToCode(s)
  if (asCode) return { code: asCode, name: _NAMES[asCode] || s }

  // A code, possibly regioned ("en-ZA") or three-letter ("nso", "eng")
  const lower = s.toLowerCase()
  for (const c of [lower, lower.replace(/[_\s]+/g, '-').split('-')[0], lower.slice(0, 3), lower.slice(0, 2)]) {
    if (_NAMES[c]) return { code: c, name: _NAMES[c] }
  }
  if (/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(s)) return { code: lower.split('-')[0], name: null }
  return { code: null, name: s }
}
