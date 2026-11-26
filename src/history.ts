// Search earlier OpenCode sessions of the same project, for when the logbook
// itself has nothing on a topic (like "reference chat history" in ChatGPT).

import { tokenize } from "./search.ts"

export interface SessionSummary {
  id: string
  title?: string
  updated?: number
}

export interface HistorySource {
  /** Recent sessions of this project, newest first. */
  sessions(limit: number): Promise<SessionSummary[]>
  /** The messages of one session, in whatever shape OpenCode returns. */
  messages(sessionID: string): Promise<ReadonlyArray<unknown>>
}

export interface HistoryHit {
  session: SessionSummary
  score: number
  snippets: string[]
}

/** Every text string inside a message, however deeply nested. */
export function textsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return out
  if (typeof value === "string") return out
  if (Array.isArray(value)) {
    for (const v of value) textsOf(v, out, depth + 1)
    return out
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "text" && typeof v === "string" && v.trim()) out.push(v)
      else if (typeof v === "object") textsOf(v, out, depth + 1)
    }
  }
  return out
}

function snippetAround(text: string, term: string): string {
  const flat = text.replace(/\s+/g, " ")
  const at = flat.toLowerCase().indexOf(term)
  const start = Math.max(0, at - 80)
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 240).trim()}${start + 240 < flat.length ? "…" : ""}`
}

export async function searchHistory(
  source: HistorySource,
  query: string,
  options: { exclude?: string; sessions?: number; limit?: number } = {},
): Promise<HistoryHit[]> {
  const terms = [...new Set(tokenize(query))].filter((t) => t.length >= 3)
  if (!terms.length) return []
  const sessions = (await source.sessions(options.sessions ?? 25)).filter((s) => s.id !== options.exclude)
  const hits: HistoryHit[] = []
  for (const session of sessions) {
    let texts: string[]
    try {
      texts = textsOf(await source.messages(session.id))
    } catch {
      continue
    }
    let score = 0
    const snippets: string[] = []
    for (const text of texts) {
      const lower = text.toLowerCase()
      const found = terms.filter((t) => lower.includes(t))
      if (!found.length) continue
      score += found.length
      if (snippets.length < 3) snippets.push(snippetAround(text, found[0]))
    }
    const title = (session.title ?? "").toLowerCase()
    score += terms.filter((t) => title.includes(t)).length * 2
    if (score) hits.push({ session, score, snippets })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 5)
}

export function formatHistory(hits: HistoryHit[]): string {
  if (!hits.length) return "No earlier session of this project mentions that."
  return hits
    .map((h) => {
      const when = h.session.updated ? new Date(h.session.updated).toISOString().slice(0, 10) : "unknown date"
      return `## ${h.session.title || "(untitled session)"} (${when}, ${h.session.id})\n${h.snippets.map((s) => `- ${s}`).join("\n")}`
    })
    .join("\n\n")
}
