import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { tidyReport } from "./context.ts"
import { checkHealth, formatHealth } from "./health.ts"
import { formatHistory, type HistorySource, searchHistory } from "./history.ts"
import { consentMessage, newSensitiveCategories, sensitiveCategories } from "./sensitive.ts"
import { search } from "./search.ts"
import { BLOCK_NAMES, type BlockName, ENTRY_TYPES, type Entry, type EntryType, type Logbook, type Provenance, type Scope } from "./store.ts"

export interface ToolSpec {
  name: string
  description: string
  input: Record<string, unknown>
  run: (input: Record<string, any>, call: { sessionID?: string }) => Promise<string> | string
}

const typeProp = { type: "string", enum: [...ENTRY_TYPES], description: "Entry type" }
const scopeProp = {
  type: "string",
  enum: ["project", "global"],
  description: 'Where the entry belongs. "global" only for facts about the user that apply to every project.',
}
const tagsProp = { type: "array", items: { type: "string" }, description: "A few lowercase keywords" }

function blockName(value: unknown): BlockName {
  return BLOCK_NAMES.includes(value as BlockName) ? (value as BlockName) : "project"
}

function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false }
}

function describe(e: Entry): string {
  const meta = [
    `id: ${e.id}`,
    `type: ${e.type}`,
    `scope: ${e.scope}`,
    e.status ? `status: ${e.status}` : "",
    e.expires ? `expires: ${e.expires}` : "",
    e.pinned ? "pinned" : "",
    e.tags.length ? `tags: ${e.tags.join(", ")}` : "",
    `updated: ${e.updated.slice(0, 10)}`,
    e.branch ? `branch: ${e.branch}` : "",
    e.commit ? `commit: ${e.commit}` : "",
    e.model ? `model: ${e.model}` : "",
  ].filter(Boolean)
  return `${e.title}\n${meta.join(" | ")}${e.body ? `\n\n${e.body}` : ""}`
}

function redactionNote(logbook: Logbook): string {
  const n = logbook.lastRedactions
  return n ? ` ${n} secret${n === 1 ? " was" : "s were"} redacted before saving.` : ""
}

export function createTools(
  logbook: Logbook,
  provenance: (sessionID?: string) => Provenance | Promise<Provenance>,
  baseDir: string,
  history?: HistorySource,
): ToolSpec[] {
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p))

  const historyTool: ToolSpec[] = history
    ? [
        {
          name: "logbook_history",
          description:
            "Search earlier OpenCode sessions of this project for a topic, when the logbook itself has nothing on it. Returns matching sessions with short excerpts. Slower than logbook_search; use it second.",
          input: object(
            {
              query: { type: "string", description: "Keywords" },
              sessions: { type: "number", description: "How many recent sessions to look through (default 25, max 100)" },
            },
            ["query"],
          ),
          async run(input, call) {
            const hits = await searchHistory(history, String(input.query ?? ""), {
              exclude: call.sessionID,
              sessions: Math.max(1, Math.min(Number(input.sessions) || 25, 100)),
            })
            return formatHistory(hits)
          },
        },
      ]
    : []

  return [
    ...historyTool,
    {
      name: "logbook_save",
      description:
        "Save one durable fact to the logbook so later sessions know it: a decision and why, a non-obvious learning, a user preference, a blocker, or background context. Search first and update an existing entry instead of duplicating.",
      input: object(
        {
          type: typeProp,
          title: { type: "string", description: "Short, specific title (under ~80 characters)" },
          body: { type: "string", description: "What and why, in a few sentences. Markdown is fine." },
          tags: tagsProp,
          scope: scopeProp,
          pinned: { type: "boolean", description: "Pin to load it at every session start. Use sparingly." },
          expires: { type: "string", description: "YYYY-MM-DD for time-bound facts (e.g. a holiday or a deadline); after that day the entry is archived" },
          consent: { type: "boolean", description: "true only after the user agreed to remembering sensitive personal information" },
        },
        ["type", "title", "body"],
      ),
      async run(input, call) {
        if (!ENTRY_TYPES.includes(input.type)) return `Unknown type "${input.type}". Use one of: ${ENTRY_TYPES.join(", ")}.`
        if (!String(input.title ?? "").trim()) return "A title is required."
        const sensitive = sensitiveCategories(`${input.title ?? ""}\n${input.body ?? ""}`)
        if (sensitive.length && input.consent !== true) return consentMessage(sensitive)
        const entry = logbook.save({
          type: input.type as EntryType,
          title: String(input.title),
          body: String(input.body ?? ""),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
          scope: input.scope === "global" ? "global" : "project",
          pinned: input.pinned === true,
          expires: typeof input.expires === "string" ? input.expires : undefined,
          ...(await provenance(call.sessionID)),
        })
        return `Saved ${entry.type} "${entry.title}" (id: ${entry.id}, scope: ${entry.scope}).${redactionNote(logbook)}`
      },
    },
    {
      name: "logbook_search",
      description:
        "Search the logbook by keywords and filters. Without a query it lists the newest entries. Use it before answering questions about earlier work, and before saving, to avoid duplicates.",
      input: object({
        query: { type: "string", description: "Keywords" },
        type: typeProp,
        scope: scopeProp,
        status: { type: "string", enum: ["open", "resolved"], description: "Blocker status" },
        tag: { type: "string" },
        limit: { type: "number", description: "Default 10, max 50" },
      }),
      run(input) {
        const hits = search(logbook.list("all"), {
          query: input.query,
          type: input.type,
          scope: input.scope,
          status: input.status,
          tag: input.tag,
          limit: input.limit,
        })
        if (!hits.length) return "No matching entries."
        return hits
          .map(({ entry: e, snippet }) =>
            `- ${e.title} (id: ${e.id}, ${e.type}, ${e.scope}${e.status ? `, ${e.status}` : ""}, ${e.updated.slice(0, 10)})${snippet ? `\n  ${snippet}` : ""}`,
          )
          .join("\n")
      },
    },
    {
      name: "logbook_read",
      description: "Read one logbook entry in full, with its provenance.",
      input: object({ id: { type: "string" } }, ["id"]),
      run(input) {
        const entry = logbook.get(String(input.id))
        return entry ? describe(entry) : `No entry with id "${input.id}".`
      },
    },
    {
      name: "logbook_update",
      description:
        "Change an existing entry: correct or extend it, retag it, pin or unpin it, move it between scopes, or set a blocker's status to resolved. Only the fields you pass change.",
      input: object(
        {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "Replaces the whole body" },
          type: typeProp,
          tags: tagsProp,
          scope: scopeProp,
          pinned: { type: "boolean" },
          status: { type: "string", enum: ["open", "resolved"] },
          expires: { type: "string", description: "YYYY-MM-DD, or \"\" to remove the expiry" },
          consent: { type: "boolean", description: "true only after the user agreed to remembering sensitive personal information" },
        },
        ["id"],
      ),
      async run(input, call) {
        if (input.type !== undefined && !ENTRY_TYPES.includes(input.type)) return `Unknown type "${input.type}".`
        const current = logbook.get(String(input.id))
        if (current && input.consent !== true) {
          const added = newSensitiveCategories(
            `${current.title}\n${current.body}`,
            `${input.title ?? current.title}\n${input.body ?? current.body}`,
          )
          if (added.length) return consentMessage(added)
        }
        const updated = logbook.update(
          String(input.id),
          {
            title: input.title,
            body: input.body,
            type: input.type,
            tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
            scope: input.scope === "global" || input.scope === "project" ? (input.scope as Scope) : undefined,
            pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
            expires: typeof input.expires === "string" ? input.expires : undefined,
            status: input.status === "open" || input.status === "resolved" ? input.status : undefined,
          },
          await provenance(call.sessionID),
        )
        return updated ? `Updated "${updated.title}" (id: ${updated.id}).${redactionNote(logbook)}` : `No entry with id "${input.id}".`
      },
    },
    {
      name: "logbook_forget",
      description:
        "Remove an entry that is wrong or no longer useful. It moves to the logbook's trash folder and can be restored by hand. Only do this when the user asked, or after confirming with them.",
      input: object({ id: { type: "string" }, reason: { type: "string" } }, ["id"]),
      run(input) {
        const entry = logbook.forget(String(input.id), input.reason)
        return entry ? `Forgot "${entry.title}" (moved to ${join(logbook.root, "trash")}).` : `No entry with id "${input.id}".`
      },
    },
    {
      name: "logbook_list",
      description: "Overview of the logbook: how many entries of each type and scope, open blockers, the blocks' sizes, and a health check (folder writable, broken files, leftovers).",
      input: object({}),
      run() {
        const entries = logbook.list("all")
        const count = (scope: Scope) =>
          ENTRY_TYPES.map((t) => `${t} ${entries.filter((e) => e.scope === scope && e.type === t).length}`).join(", ")
        const blocks = BLOCK_NAMES.map((n) => {
          const b = logbook.readBlock(n)
          return `${n}: ${b.content.length}/${b.limit} characters`
        })
        const open = entries.filter((e) => e.type === "blocker" && e.status === "open")
        return [
          `Project: ${logbook.project.label} (stored in ${logbook.projectDir})`,
          `Project entries: ${count("project")}`,
          `Global entries: ${count("global")}`,
          `Blocks: ${blocks.join("; ")}`,
          open.length ? `Open blockers:\n${open.map((e) => `- ${e.title} (id: ${e.id})`).join("\n")}` : "No open blockers.",
          formatHealth(checkHealth(logbook)),
        ].join("\n")
      },
    },
    {
      name: "logbook_block_get",
      description: 'Read the current text of a block: "human" (about the user), "project" (this codebase) or "session" (where the last work stopped).',
      input: object({ block: { type: "string", enum: [...BLOCK_NAMES] } }, ["block"]),
      run(input) {
        const b = logbook.readBlock(blockName(input.block))
        return `${b.name} block, ${b.content.length}/${b.limit} characters:\n\n${b.content || "(empty)"}`
      },
    },
    {
      name: "logbook_block_set",
      description:
        'Rewrite a block entirely. "human" summarises the user (role, preferences, how they like to work); "project" summarises this codebase (purpose, stack, how to run and test, conventions); "session" records where work stopped (state, open items, next steps). Keep it concise and under the size limit.',
      input: object(
        { block: { type: "string", enum: [...BLOCK_NAMES] }, content: { type: "string" }, consent: { type: "boolean", description: "true only after the user agreed to remembering sensitive personal information" }, },
        ["block", "content"],
      ),
      run(input) {
        const name = blockName(input.block)
        if (input.consent !== true) {
          const added = newSensitiveCategories(logbook.readBlock(name).content, String(input.content ?? ""))
          if (added.length) return consentMessage(added)
        }
        const b = logbook.writeBlock(name, String(input.content ?? ""))
        const over = b.content.length > b.limit ? ` It is over the ${b.limit} limit; condense it.` : ""
        return `Saved the ${b.name} block (${b.content.length}/${b.limit} characters).${over}${redactionNote(logbook)}`
      },
    },
    {
      name: "logbook_tidy_report",
      description:
        "Find likely duplicates, old resolved blockers, entries untouched for 6 months, empty entries and oversized blocks. Propose changes from it, but change nothing without the user's OK.",
      input: object({}),
      run() {
        const r = tidyReport(logbook)
        const sections: string[] = []
        if (r.duplicates.length)
          sections.push(
            `Possible duplicates:\n${r.duplicates
              .slice(0, 20)
              .map((d) => `- "${d.a.title}" (${d.a.id}) ~ "${d.b.title}" (${d.b.id}), ${Math.round(d.similarity * 100)}% similar`)
              .join("\n")}`,
          )
        if (r.resolvedBlockers.length)
          sections.push(`Resolved blockers older than 30 days:\n${r.resolvedBlockers.map((e) => `- ${e.title} (${e.id})`).join("\n")}`)
        if (r.untouched.length)
          sections.push(`Not updated for 6+ months:\n${r.untouched.map((e) => `- ${e.title} (${e.id}, ${e.updated.slice(0, 10)})`).join("\n")}`)
        if (r.empty.length) sections.push(`Entries without a body:\n${r.empty.map((e) => `- ${e.title} (${e.id})`).join("\n")}`)
        if (r.oversizedBlocks.length)
          sections.push(`Oversized blocks: ${r.oversizedBlocks.map((b) => `${b.name} ${b.content.length}/${b.limit}`).join(", ")}`)
        return sections.length ? sections.join("\n\n") : "Nothing to tidy."
      },
    },
    {
      name: "logbook_export",
      description:
        'Export the logbook to a JSON file. scope "project" exports this project\'s entries and block; "all" also includes global entries and the human block.',
      input: object({
        scope: { type: "string", enum: ["project", "all"] },
        path: { type: "string", description: "Output file; defaults to the logbook's exports folder" },
      }),
      run(input) {
        const scope = input.scope === "project" ? "project" : "all"
        const data = logbook.exportAll(scope)
        const stamp = data.exported.slice(0, 19).replace(/[:T]/g, "-")
        const target = input.path
          ? resolvePath(String(input.path))
          : join(logbook.root, "exports", `${scope === "all" ? "all" : logbook.project.id}-${stamp}.json`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf8")
        return `Exported ${data.entries.length} entries and ${data.blocks.filter((b) => b.content).length} blocks to ${target}.`
      },
    },
    {
      name: "logbook_import",
      description:
        "Import entries from an open-logbook export file into this logbook. Identical entries are skipped, conflicting ids get a new id, and blocks are only filled if empty here.",
      input: object({ path: { type: "string" } }, ["path"]),
      run(input) {
        const source = resolvePath(String(input.path))
        let data: unknown
        try {
          data = JSON.parse(readFileSync(source, "utf8"))
        } catch (error) {
          return `Could not read ${source}: ${(error as Error).message}`
        }
        try {
          const r = logbook.importAll(data)
          const blocks = [
            r.blocksSet.length ? `filled blocks: ${r.blocksSet.join(", ")}` : "",
            r.blocksSkipped.length ? `kept existing blocks: ${r.blocksSkipped.join(", ")} (merge by hand if needed)` : "",
          ].filter(Boolean)
          return `Imported ${r.added} entries (${r.renamed} under a new id), skipped ${r.skipped} already present.${blocks.length ? ` ${blocks.join("; ")}.` : ""}`
        } catch (error) {
          return `Import failed: ${(error as Error).message}`
        }
      },
    },
  ]
}
