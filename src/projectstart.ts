// First contact with a project: read the documentation files in the project
// root once and let the session's model draft the project profile from them.
// Only text documentation at the top level is read: no code, no subfolders.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Logbook } from "./store.ts"

const TEXT_EXTENSIONS = /\.(md|markdown|mdx|txt|rst|adoc)$/i
const SKIP = /^(license|licence|notice|copying|authors|code_of_conduct|security)(\.|$)/i
// Read first, in this order; other text files in the root follow.
const PRIORITY = [/^agents\.md$/i, /^claude\.md$/i, /^readme/i, /^plan/i, /^architecture/i, /^contributing/i, /^development/i, /^design/i, /^todo/i]
const LOW = [/^changelog/i, /^history/i, /^news/i]

const PER_FILE_CHARS = 12_000
const LOW_FILE_CHARS = 3_000
const TOTAL_CHARS = 40_000

export interface ProjectDoc {
  name: string
  text: string
}

function rank(name: string): number {
  const p = PRIORITY.findIndex((r) => r.test(name))
  if (p !== -1) return p
  if (LOW.some((r) => r.test(name))) return 100
  return 50
}

/** Text documentation files in the project root, most relevant first, size-capped. */
export function rootDocs(root: string): ProjectDoc[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const candidates = names
    .filter((n) => TEXT_EXTENSIONS.test(n) && !SKIP.test(n))
    .filter((n) => {
      try {
        return statSync(join(root, n)).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const docs: ProjectDoc[] = []
  let total = 0
  for (const name of candidates) {
    if (total >= TOTAL_CHARS) break
    let text: string
    try {
      text = readFileSync(join(root, name), "utf8")
    } catch {
      continue
    }
    const cap = Math.min(rank(name) === 100 ? LOW_FILE_CHARS : PER_FILE_CHARS, TOTAL_CHARS - total)
    if (text.length > cap) text = `${text.slice(0, cap)}\n[…truncated…]`
    if (!text.trim()) continue
    docs.push({ name, text })
    total += text.length
  }
  return docs
}

export function projectStartPrompt(docs: ProjectDoc[], logbook: Logbook): string {
  const limit = logbook.readBlock("project").limit
  return `Write the project profile for a developer's long-term memory, based only on the documentation files below from the root of ${logbook.project.label}. Cover what the project is and does, its stack and structure, how to build, run and test it, important conventions and rules for contributors or AI agents, and the current state or plans if stated. Plain Markdown, in English, concise, at most ${limit} characters. Do not invent anything that the files do not say. Answer with the profile text only.

${docs.map((d) => `===== ${d.name} =====\n${d.text}`).join("\n\n")}`
}

/** True if this project has never been started and its profile is still empty. */
export function needsProjectStart(logbook: Logbook): boolean {
  return !logbook.readBlock("project").content && !existsSync(join(logbook.projectDir, ".started"))
}

/**
 * Draft the project profile from the root docs. Marks the project as started
 * either way, so it runs once per project; returns the file names it read.
 */
export async function startProject(logbook: Logbook, generate: (prompt: string) => Promise<string>): Promise<string[]> {
  logbook.markProjectStarted()
  const docs = rootDocs(logbook.project.root)
  if (!docs.length) return []
  const text = (await generate(projectStartPrompt(docs, logbook))).trim()
  // The profile may have been written meanwhile (by the agent or a sync); never overwrite it.
  if (text && !logbook.readBlock("project").content) logbook.writeBlock("project", text)
  return docs.map((d) => d.name)
}
