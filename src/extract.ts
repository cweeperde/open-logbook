// Automatic capture at compaction: the conversation that is about to be
// summarised is read once by the session's own model, which returns durable
// facts missing from the logbook plus a note on where the work stands. No
// extra API key; the call goes through OpenCode's generate API.

import { similarity } from "./search.ts"
import { newSensitiveCategories, sensitiveCategories } from "./sensitive.ts"
import { ENTRY_TYPES, type Entry, type EntryType, type Logbook, normalizeDate, type Provenance, type Scope } from "./store.ts"

export const AUTO_TAG = "auto"
const MAX_TRANSCRIPT_CHARS = 60_000
const MAX_NEW_ENTRIES = 8

type Part = { type?: string; text?: unknown; name?: unknown; input?: unknown; result?: unknown; content?: unknown }
type Msg = { role?: string; content?: unknown }

function partText(part: Part): string {
  if (typeof part === "string") return part
  if (!part || typeof part !== "object") return ""
  if (part.type === "text" && typeof part.text === "string") return part.text
  if (part.type === "tool-call" || part.type === "tool_call") {
    const input = JSON.stringify(part.input ?? {})
    return `[tool ${String(part.name ?? "?")}: ${input.slice(0, 300)}]`
  }
  if (part.type === "tool-result" || part.type === "tool_result") {
    const value = typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? part.content ?? "")
    return `[result: ${value.slice(0, 400)}]`
  }
  return ""
}

/** Flatten request messages into plain text, keeping the end when it is too long. */
export function transcript(messages: ReadonlyArray<unknown>, limit = MAX_TRANSCRIPT_CHARS): string {
  const lines: string[] = []
  for (const raw of messages) {
    const m = raw as Msg
    if (!m || m.role === "system") continue
    const parts = Array.isArray(m.content) ? m.content : [m.content]
    const text = parts
      .map((p) => partText(p as Part))
      .filter(Boolean)
      .join("\n")
      .trim()
    if (text) lines.push(`${(m.role ?? "?").toUpperCase()}: ${text}`)
  }
  const all = lines.join("\n\n")
  return all.length > limit ? `[…earlier part omitted…]\n${all.slice(all.length - limit)}` : all
}

export function extractionPrompt(conversation: string, logbook: Logbook): string {
  const known = logbook
    .list("all")
    .slice(0, 150)
    .map((e) => `- [${e.type}${e.scope === "global" ? ", global" : ""}] ${e.title}`)
    .join("\n")
  const human = logbook.readBlock("human")
  const project = logbook.readBlock("project")
  const session = logbook.readBlock("session")
  return `You maintain a personal memory ("logbook") for one user and their project ${logbook.project.label}, like the memory of a good long-term assistant. Read the conversation below and return only JSON. Write everything in English, whatever language the conversation uses.

1. "entries": facts worth remembering in later sessions that are NOT already in the logbook (list below):
   - about the user: who they are, role, background, location and time zone, language, tools and setup, interests, plans, how they like to work and communicate (scope "global")
   - about the project: decisions and why, non-obvious causes and fixes, commands and quirks, conventions, open problems (scope "project")
   Types: decision, learning, preference, blocker (still unsolved), context.
   Each: {"type", "title": short and specific, "body": 1-3 sentences, "tags": [a few lowercase words], "scope": "project" or "global", "expires": "YYYY-MM-DD" only for time-bound facts}.
   Leave out trivia, guesses, secrets, and anything only relevant to this conversation. Leave out sensitive personal information (health, finances, relationships, political or religious views, legal matters) unless the user agreed in the conversation that it may be remembered. At most ${MAX_NEW_ENTRIES} entries; none is a fine answer.
2. "human": the user profile below, rewritten to include new or changed facts about the user from this conversation and to drop what is no longer true. Use null if nothing about the user changed. At most ${human.limit} characters.
3. "project": the project profile below (what it is, stack and structure, how to build, run and test, conventions, current state), rewritten the same way. Use null if nothing changed. At most ${project.limit} characters.
4. "session": a short Markdown note on where the work stands: what was being done, what is finished, what is open, the next concrete steps. At most 15 lines. Use "" if the conversation contains no real work.

Already in the logbook:
${known || "(nothing yet)"}

Current user profile:
${human.content || "(empty)"}

Current project profile:
${project.content || "(empty)"}

Current session note:
${session.content || "(none)"}

Answer with exactly one JSON object: {"entries": [...], "human": ... , "project": ..., "session": "..."}

Conversation:
${conversation}`
}

export interface Extracted {
  entries: Array<{ type: EntryType; title: string; body: string; tags: string[]; scope: Scope; expires?: string }>
  session: string
  /** Rewritten profiles, only when something changed. */
  human?: string
  project?: string
}

const NOTHING: Extracted = { entries: [], session: "" }

/** Parse the model's answer leniently: code fences and text around the JSON are ignored. */
export function parseExtraction(text: string): Extracted {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return { ...NOTHING }
  let data: any
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ...NOTHING }
  }
  const entries: Extracted["entries"] = []
  for (const e of Array.isArray(data?.entries) ? data.entries : []) {
    if (!e || !ENTRY_TYPES.includes(e.type) || typeof e.title !== "string" || !e.title.trim()) continue
    entries.push({
      type: e.type,
      title: e.title.trim().slice(0, 120),
      body: typeof e.body === "string" ? e.body.trim().slice(0, 1200) : "",
      tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 6) : [],
      scope: e.scope === "global" ? "global" : "project",
      expires: normalizeDate(e.expires),
    })
    if (entries.length >= MAX_NEW_ENTRIES) break
  }
  const profile = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  return {
    entries,
    session: typeof data?.session === "string" ? data.session.trim() : "",
    human: profile(data?.human),
    project: profile(data?.project),
  }
}

function isDuplicate(candidate: Extracted["entries"][number], existing: Entry[]): boolean {
  const probe = { ...candidate, id: "", pinned: false, created: "", updated: "" } as Entry
  const title = candidate.title.toLowerCase()
  return existing.some(
    (e) => e.title.toLowerCase() === title || (e.type === candidate.type && similarity(probe, e) >= 0.5),
  )
}

export interface CaptureResult {
  saved: Entry[]
  skipped: number
  session: boolean
  /** Profiles that were rewritten because something changed. */
  profiles: Array<"human" | "project">
}

/** Store what the model found: new entries tagged "auto", changed profiles, and the session note. */
export function applyExtraction(logbook: Logbook, found: Extracted, provenance: Provenance): CaptureResult {
  const existing = logbook.list("all")
  const saved: Entry[] = []
  let skipped = 0
  for (const candidate of found.entries) {
    // Nobody can be asked during compaction, so sensitive facts are never captured here.
    if (sensitiveCategories(`${candidate.title}
${candidate.body}`).length) {
      skipped++
      continue
    }
    if (isDuplicate(candidate, [...existing, ...saved])) {
      skipped++
      continue
    }
    saved.push(
      logbook.save({
        ...candidate,
        tags: [...new Set([...candidate.tags.map((t) => t.toLowerCase()), AUTO_TAG])],
        ...provenance,
      }),
    )
  }
  const profiles: CaptureResult["profiles"] = []
  for (const name of ["human", "project"] as const) {
    const text = found[name]
    const current = logbook.readBlock(name).content
    if (text && newSensitiveCategories(current, text).length) continue
    if (text && text !== current) {
      logbook.writeBlock(name, text)
      profiles.push(name)
    }
  }
  if (found.session) logbook.writeBlock("session", found.session)
  return { saved, skipped, session: Boolean(found.session), profiles }
}

export async function capture(
  logbook: Logbook,
  messages: ReadonlyArray<unknown>,
  generate: (prompt: string) => Promise<string>,
  provenance: Provenance,
): Promise<CaptureResult> {
  const conversation = transcript(messages)
  if (conversation.length < 200) return { saved: [], skipped: 0, session: false, profiles: [] }
  const answer = await generate(extractionPrompt(conversation, logbook))
  return applyExtraction(logbook, parseExtraction(answer), provenance)
}
