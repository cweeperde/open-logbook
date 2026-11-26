import { similarity } from "./search.ts"
import { type Block, BLOCK_NAMES, type Entry, type Logbook } from "./store.ts"

export const INSTRUCTIONS = `You have a persistent memory, the logbook (open-logbook). It is stored only on the user's machine. Use it the way a good assistant remembers a person and their work: what you learn in one session should make the next one better. The sections below were loaded when this session started and are not refreshed during it; use logbook_search or logbook_read for the current state.

What to remember, as soon as you learn it:
- About the user: name, role, background, language, location and time zone, tools and setup, interests, ongoing plans, how they like to communicate and work, and anything else that would help you help them later. Whenever the user tells you something about themselves, even in passing or in a greeting, update the "human" block in that same turn, before you reply: logbook_block_set with the full profile including the new facts. Add global entries for details that do not fit there.
- About the project: what it is, its stack and structure, how to build, run and test it, conventions, decisions and why, gotchas that cost effort, open problems. Keep the summary in the "project" block and details as entries.
- Entry types: decision (a settled choice and why), learning (a non-obvious cause, fix, command or quirk), preference (how the user wants things done; scope "global" if it applies everywhere), blocker (stuck; resolve it with logbook_update when fixed), context (background).
- Time-bound facts ("on holiday until 3 December", "deadline Friday") get an expiry date.

Sensitive information (health, finances, relationships, political or religious views, legal matters, and similar): never save it without asking. When the user shares something like that, end your reply with one short question in their language, e.g. "May I remember that? It stays on your machine." Save it only if they say yes; if they say no, do not ask again.

Do not save secrets or passwords, things the repo's own docs already say, or details that only matter for the task at hand. Search before saving and update an existing entry instead of duplicating it.

Write logbook content in English, whatever language the conversation is in. Keep it concise and factual.

Save quietly. Never list or narrate what you stored. At most add a short note such as "Updating logbook." or "Adding a logbook entry."; for small or routine updates say nothing at all.`

export const COMPACTION_NOTE = `When you write the summary, end it with a section "Unsaved for logbook" that lists durable facts from this conversation (decisions, learnings, preferences, blockers) that were not saved to the logbook yet. Leave it out if there are none.`

export const AFTER_COMPACTION_NOTE = `The conversation was just compacted. If the summary has an "Unsaved for logbook" section, save those items with logbook_save now (checking for duplicates first), then continue.`

/** After this many days the session block is only mentioned, not loaded in full. */
export const SESSION_FRESH_DAYS = 14

function line(e: Entry): string {
  const first = e.body.split(/\r?\n/).find((l) => l.trim()) ?? ""
  const short = first.length > 160 ? `${first.slice(0, 157)}…` : first
  const flags = [e.scope === "global" ? "global" : "", e.pinned ? "pinned" : ""].filter(Boolean).join(", ")
  return `- [${e.type}] ${e.title} (id: ${e.id}${flags ? `, ${flags}` : ""})${short ? `: ${short}` : ""}`
}

function age(updated: string | undefined, now: number): { days: number; label: string } | undefined {
  const at = updated ? Date.parse(updated) : Number.NaN
  if (Number.isNaN(at)) return undefined
  const days = Math.max(0, Math.floor((now - at) / 86_400_000))
  return { days, label: days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago` }
}

/** The session block in full while it is fresh, as a one-line pointer once it is old. */
function sessionSection(block: Block, now: number): string | undefined {
  if (!block.content) return undefined
  const a = age(block.updated, now)
  if (a && a.days > SESSION_FRESH_DAYS) {
    return `## Last session (block: session)
A note on where work stopped was written ${a.label} (${block.updated?.slice(0, 10)}). It is probably out of date; read it with logbook_block_get "session" only if the user picks that work up again.`
  }
  return blockSection(`Last session${a ? `, written ${a.label}` : ""} (block: session)`, block)
}

function blockSection(heading: string, block: Block): string {
  if (!block.content) {
    return block.name === "human"
      ? `## ${heading}\n(empty: you know nothing about the user yet. The first time they mention their name, work, location or preferences, write it here with logbook_block_set "human".)`
      : `## ${heading}\n(empty; fill it with logbook_block_set "${block.name}" once you know something worth keeping)`
  }
  const over = block.content.length > block.limit
  const note = over
    ? `\n(This block is ${block.content.length} characters, over its ${block.limit} limit. Condense it with logbook_block_set.)`
    : ""
  return `## ${heading}\n${block.content}${note}`
}

/**
 * Build the text injected at session start: instructions, both blocks, then
 * pinned entries, open blockers and the newest decisions, until the budget
 * (in characters) is used up.
 */
export function buildContext(logbook: Logbook, budgetChars: number, now = Date.now()): string {
  const entries = logbook.list("all")
  const parts = [
    "# open-logbook",
    INSTRUCTIONS,
    blockSection("About the user (block: human)", logbook.readBlock("human")),
    blockSection(`This project: ${logbook.project.label} (block: project)`, logbook.readBlock("project")),
  ]
  const session = sessionSection(logbook.readBlock("session"), now)
  if (session) parts.push(session)
  let used = parts.join("\n\n").length
  const shown = new Set<string>()
  const groups: Array<[string, Entry[]]> = [
    ["Pinned", entries.filter((e) => e.pinned)],
    ["Open blockers", entries.filter((e) => e.type === "blocker" && e.status === "open")],
    ["Recent decisions", entries.filter((e) => e.type === "decision").slice(0, 5)],
  ]
  for (const [heading, group] of groups) {
    const lines: string[] = []
    for (const e of group) {
      if (shown.has(e.id)) continue
      const text = line(e)
      if (used + text.length + heading.length + 8 > budgetChars) break
      lines.push(text)
      used += text.length + 1
      shown.add(e.id)
    }
    if (lines.length) {
      parts.push(`## ${heading}\n${lines.join("\n")}`)
      used += heading.length + 5
    }
  }
  const rest = entries.length - shown.size
  parts.push(
    rest > 0
      ? `${rest} more ${rest === 1 ? "entry is" : "entries are"} in the logbook. Search with logbook_search before answering questions about past work.`
      : entries.length
        ? "All logbook entries are listed above."
        : "The logbook has no entries yet.",
  )
  return parts.join("\n\n")
}

export interface TidyReport {
  duplicates: Array<{ a: Entry; b: Entry; similarity: number }>
  resolvedBlockers: Entry[]
  untouched: Entry[]
  empty: Entry[]
  oversizedBlocks: Block[]
}

export function tidyReport(logbook: Logbook, now = Date.now()): TidyReport {
  const entries = logbook.list("all")
  const duplicates: TidyReport["duplicates"] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      if (a.type !== b.type) continue
      const s = similarity(a, b)
      if (s >= 0.5) duplicates.push({ a, b, similarity: s })
    }
  }
  const days = (e: Entry) => (now - Date.parse(e.updated)) / 86_400_000
  return {
    duplicates: duplicates.sort((x, y) => y.similarity - x.similarity),
    resolvedBlockers: entries.filter((e) => e.type === "blocker" && e.status === "resolved" && days(e) > 30),
    untouched: entries.filter((e) => !e.pinned && e.type !== "blocker" && days(e) > 180),
    empty: entries.filter((e) => !e.body),
    oversizedBlocks: BLOCK_NAMES
      .map((n) => logbook.readBlock(n))
      .filter((b) => b.content.length > b.limit),
  }
}
