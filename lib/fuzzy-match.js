/**
 * lib/fuzzy-match.js
 * Shared string-similarity helpers.
 *
 * Extracted from routes/ingest.js, which had the only copy. Two callers now
 * need it — the DB-sync matrix and Add Album's audio matching — and two
 * implementations of edit distance that drift apart is a bug waiting to happen.
 */

/** Classic Levenshtein edit distance, two-row DP (O(min) memory). */
export function levenshtein(a, b) {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1])
    }
    prev = curr
  }
  return prev[b.length]
}

/** Alphanumerics only, lowercased — punctuation and spacing carry no signal here. */
export function normForFuzzy(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents: "Reën" == "Reen"
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** 0…1 similarity. 1 = identical after normalisation. */
export function fuzzyScore(a, b) {
  const A = normForFuzzy(a), B = normForFuzzy(b)
  const max = Math.max(A.length, B.length)
  return max ? 1 - levenshtein(A, B) / max : 1
}
