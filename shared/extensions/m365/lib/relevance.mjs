// Which older turns the question is about. Plain lexical scoring (BM25) over the turns: no
// model and no embeddings, so it costs nothing and needs no download. Words are file names,
// identifiers and other ASCII words, and pairs of adjacent kanji or katakana for Japanese
// (which has no spaces). Hiragana is mostly particles and endings, so a pair with any
// hiragana in it (`分を`, `を見`) is skipped: it would match turns that share only grammar.

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'you', 'can', 'use',
  'is', 'in', 'to', 'of', 'on', 'at', 'by', 'be', 'it', 'or', 'as', 'an', 'if', 'do', 'so', 'we', 'me', 'my', 'up',
])
const ASCII_WORD = /[a-z0-9_$][a-z0-9_$.\-/\\]*[a-z0-9_$]|[a-z0-9_$]/g
const JAPANESE_RUN = /[\p{Script=Han}\p{Script=Katakana}ー々]+/gu

/** The words of `text`, repeated as often as they occur. */
export function words(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  for (const [word] of lower.matchAll(ASCII_WORD)) {
    if (word.length >= 2 && !STOP.has(word)) out.push(word)
    // `lib/history.mjs` also matches `history`, `history.mjs` and `lib`.
    if (/[./\\-]/.test(word)) for (const part of word.split(/[./\\-]+/)) if (part.length >= 2 && part !== word && !STOP.has(part)) out.push(part)
  }
  for (const [run] of lower.matchAll(JAPANESE_RUN)) {
    const chars = [...run]
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * BM25 score of each text against `query`, in the order given. 0 means no word in common.
 */
export function scoreAll(texts, query, { k1 = 1.2, b = 0.75 } = {}) {
  const terms = [...new Set(words(query))]
  if (!terms.length || !texts.length) return texts.map(() => 0)
  const docs = texts.map((t) => {
    const counts = new Map()
    const list = words(t)
    for (const w of list) counts.set(w, (counts.get(w) ?? 0) + 1)
    return { counts, length: list.length }
  })
  const average = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1
  const df = new Map(terms.map((term) => [term, docs.filter((d) => d.counts.has(term)).length]))
  return docs.map((d) => {
    let score = 0
    for (const term of terms) {
      const tf = d.counts.get(term)
      if (!tf) continue
      const n = df.get(term)
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / average))
    }
    return score
  })
}

/** Indexes (into `texts`) of the `limit` best matches for `query`, best first. */
export function topMatches(texts, query, limit) {
  return scoreAll(texts, query)
    .map((score, index) => ({ score, index }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((s) => s.index)
}
