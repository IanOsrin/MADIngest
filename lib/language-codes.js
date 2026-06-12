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
