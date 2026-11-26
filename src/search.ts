import type { Entry, EntryType, Scope } from "./store.ts"

export interface SearchQuery {
  query?: string
  type?: EntryType
  scope?: Scope
  status?: "open" | "resolved"
  tag?: string
  limit?: number
}

export interface Hit {
  entry: Entry
  score: number
  snippet: string
}

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/** Light English stemming: "tests", "testing" and "tested" all become "test". */
export function stem(word: string): string {
  if (word.length <= 4) return word
  for (const suffix of ["ing", "ies", "es", "ed", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length)
      return suffix === "ies" ? `${base}y` : base
    }
  }
  return word
}

function matches(token: string, term: string): boolean {
  if (token === term) return true
  const t = stem(token)
  const q = stem(term)
  // Same stem, or a prefix from 4 letters on ("config" finds "configuration").
  return t === q || (q.length >= 4 && t.startsWith(q))
}

function snippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, " ").trim()
  if (flat.length <= 200) return flat
  const lower = flat.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - 60)
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 200).trim()}…`
}

/**
 * Rank entries by keyword overlap: title hits count most, then tags, then body,
 * each weighted by how rare the term is. Recent and pinned entries get a small
 * boost. Without a query, the newest matching entries come first.
 */
export function search(entries: Entry[], q: SearchQuery): Hit[] {
  const limit = Math.max(1, Math.min(q.limit ?? 10, 50))
  const tag = q.tag?.toLowerCase()
  const pool = entries.filter(
    (e) =>
      (!q.type || e.type === q.type) &&
      (!q.scope || e.scope === q.scope) &&
      (!q.status || e.status === q.status) &&
      (!tag || e.tags.includes(tag)),
  )
  const terms = [...new Set(tokenize(q.query ?? ""))]
  if (!terms.length) {
    return pool.slice(0, limit).map((entry) => ({ entry, score: 0, snippet: snippet(entry.body, []) }))
  }

  const docs = pool.map((entry) => ({
    entry,
    title: tokenize(entry.title),
    tags: entry.tags.flatMap(tokenize),
    body: tokenize(entry.body),
  }))
  const idf = new Map(
    terms.map((term) => {
      const df = docs.filter((d) => [...d.title, ...d.tags, ...d.body].some((t) => matches(t, term))).length
      return [term, Math.log(1 + docs.length / (1 + df))]
    }),
  )
  const now = Date.now()
  const hits: Hit[] = []
  for (const d of docs) {
    let score = 0
    let found = 0
    for (const term of terms) {
      const inTitle = d.title.some((t) => matches(t, term))
      const inTags = d.tags.some((t) => matches(t, term))
      const inBody = Math.min(3, d.body.filter((t) => matches(t, term)).length)
      if (inTitle || inTags || inBody) found++
      score += (idf.get(term) ?? 1) * ((inTitle ? 3 : 0) + (inTags ? 2 : 0) + inBody)
    }
    if (!found) continue
    // Entries that match more of the query rank above ones matching one word often.
    score *= found / terms.length
    const ageDays = (now - Date.parse(d.entry.updated)) / 86_400_000
    score += 0.5 * Math.exp(-Math.max(0, ageDays) / 90) + (d.entry.pinned ? 0.5 : 0)
    hits.push({ entry: d.entry, score, snippet: snippet(d.entry.body, terms) })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Jaccard similarity of title and tag words, used to spot duplicates. */
export function similarity(a: Entry, b: Entry): number {
  const sa = new Set([...tokenize(a.title), ...a.tags])
  const sb = new Set([...tokenize(b.title), ...b.tags])
  if (!sa.size || !sb.size) return 0
  let common = 0
  for (const w of sa) if (sb.has(w)) common++
  return common / (sa.size + sb.size - common)
}
