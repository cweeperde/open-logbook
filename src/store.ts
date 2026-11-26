import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, stringify } from "./frontmatter.ts"
import { removeFile, writeAtomic } from "./fsutil.ts"
import type { Project } from "./project.ts"
import { redact } from "./redact.ts"

export const ENTRY_TYPES = ["decision", "learning", "preference", "blocker", "context"] as const
export type EntryType = (typeof ENTRY_TYPES)[number]
export type Scope = "project" | "global"
export const BLOCK_NAMES = ["human", "project", "session"] as const
export type BlockName = (typeof BLOCK_NAMES)[number]
export const BLOCK_LIMITS: Record<BlockName, number> = { human: 8000, project: 6000, session: 4000 }

export interface Provenance {
  branch?: string
  commit?: string
  model?: string
  session?: string
}

export interface Entry extends Provenance {
  id: string
  scope: Scope
  type: EntryType
  title: string
  body: string
  tags: string[]
  pinned: boolean
  status?: "open" | "resolved"
  /** YYYY-MM-DD; after this day the entry no longer counts and is archived. */
  expires?: string
  created: string
  updated: string
}

export interface Block {
  name: BlockName
  content: string
  limit: number
  /** ISO time of the last write, when known. */
  updated?: string
}

export interface NewEntry extends Provenance {
  type: EntryType
  title: string
  body?: string
  tags?: string[]
  scope?: Scope
  pinned?: boolean
  status?: "open" | "resolved"
  expires?: string
}

export type EntryPatch = Partial<Pick<Entry, "type" | "title" | "body" | "tags" | "pinned" | "status" | "scope">> & {
  /** A YYYY-MM-DD date, or "" to remove the expiry. */
  expires?: string
}

/** A valid YYYY-MM-DD date, or undefined. */
export function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return undefined
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? undefined : `${m[1]}-${m[2]}-${m[3]}`
}

/** True once the expiry day is over (local date). */
export function isExpired(entry: Pick<Entry, "expires">, now = new Date()): boolean {
  if (!entry.expires) return false
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return entry.expires < today
}

export const ARCHIVE_RESOLVED_AFTER_DAYS = 30

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    // letters that Unicode normalisation does not decompose
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return slug || "entry"
}

function clean(text: string): { text: string; redactions: number } {
  const { text: out, count } = redact(text)
  return { text: out, redactions: count }
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value === "string" && value.trim()) return value.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}

export class Logbook {
  readonly root: string
  readonly project: Project
  /** Secrets removed by the most recent write, so tools can tell the agent. */
  lastRedactions = 0

  constructor(root: string, project: Project) {
    this.root = root
    this.project = project
  }

  get projectDir(): string {
    return join(this.root, "projects", this.project.id)
  }

  private entriesDir(scope: Scope): string {
    return join(scope === "global" ? this.root : this.projectDir, "entries")
  }

  private blockPath(name: BlockName): string {
    return name === "human" ? join(this.root, "human.md") : join(this.projectDir, `${name}.md`)
  }

  /** Record which repo a project folder belongs to, so people can find their way around ~/.open-logbook. */
  touchProject() {
    const meta = { id: this.project.id, label: this.project.label, remote: this.project.remote, root: this.project.root }
    const path = join(this.projectDir, "project.json")
    const text = `${JSON.stringify(meta, null, 2)}\n`
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeAtomic(path, text)
  }

  /** Remember that the one-time project start ran, so it is not repeated. */
  markProjectStarted() {
    this.touchProject()
    writeAtomic(join(this.projectDir, ".started"), `${new Date().toISOString()}\n`)
  }

  // --- blocks ---------------------------------------------------------------

  readBlock(name: BlockName): Block {
    const path = this.blockPath(name)
    if (!existsSync(path)) return { name, content: "", limit: BLOCK_LIMITS[name] }
    const { fields, body } = parse(readFileSync(path, "utf8"))
    // A limit stored in an older file never shrinks the current default.
    const limit = Math.max(typeof fields.limit === "number" && fields.limit > 0 ? fields.limit : 0, BLOCK_LIMITS[name])
    const updated = typeof fields.updated === "string" ? fields.updated : undefined
    return { name, content: body.trim(), limit, updated }
  }

  writeBlock(name: BlockName, content: string): Block {
    const current = this.readBlock(name)
    const { text, redactions } = clean(content.trim())
    this.lastRedactions = redactions
    const updated = new Date().toISOString()
    const fields = { block: name, limit: current.limit, updated }
    writeAtomic(this.blockPath(name), stringify(fields, text))
    if (name !== "human") this.touchProject()
    return { name, content: text, limit: current.limit, updated }
  }

  // --- entries --------------------------------------------------------------

  private toEntry(path: string, scope: Scope): Entry | undefined {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return undefined
    }
    const { fields: f, body } = parse(text)
    const id = path.replace(/^.*[\\/]/, "").replace(/\.md$/, "")
    const type = ENTRY_TYPES.includes(f.type as EntryType) ? (f.type as EntryType) : "context"
    const created = typeof f.created === "string" ? f.created : new Date(0).toISOString()
    return {
      id,
      scope,
      type,
      title: typeof f.title === "string" && f.title ? f.title : id,
      body: body.trim(),
      tags: asStringList(f.tags),
      pinned: f.pinned === true,
      status: f.status === "open" || f.status === "resolved" ? f.status : type === "blocker" ? "open" : undefined,
      expires: normalizeDate(f.expires),
      created,
      updated: typeof f.updated === "string" ? f.updated : created,
      branch: typeof f.branch === "string" ? f.branch : undefined,
      commit: f.commit != null ? String(f.commit) : undefined,
      model: typeof f.model === "string" ? f.model : undefined,
      session: typeof f.session === "string" ? f.session : undefined,
    }
  }

  private serialize(entry: Entry): string {
    const fields = {
      type: entry.type,
      title: entry.title,
      tags: entry.tags.length ? entry.tags : undefined,
      status: entry.type === "blocker" ? (entry.status ?? "open") : undefined,
      pinned: entry.pinned || undefined,
      expires: entry.expires,
      created: entry.created,
      updated: entry.updated,
      branch: entry.branch,
      commit: entry.commit,
      model: entry.model,
      session: entry.session,
    }
    return stringify(fields, entry.body)
  }

  /** Active entries, newest first. Expired ones are left out unless asked for. */
  list(scope: Scope | "all" = "all", options: { includeExpired?: boolean } = {}): Entry[] {
    const scopes: Scope[] = scope === "all" ? ["project", "global"] : [scope]
    const now = new Date()
    const out: Entry[] = []
    for (const s of scopes) {
      const dir = this.entriesDir(s)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue
        const entry = this.toEntry(join(dir, name), s)
        if (entry && (options.includeExpired || !isExpired(entry, now))) out.push(entry)
      }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  get(id: string): Entry | undefined {
    const safe = id.replace(/\.md$/, "")
    if (!/^[a-z0-9-]+$/.test(safe)) return undefined
    for (const scope of ["project", "global"] as const) {
      const path = join(this.entriesDir(scope), `${safe}.md`)
      if (existsSync(path)) return this.toEntry(path, scope)
    }
    return undefined
  }

  private uniqueId(base: string): string {
    let id = base
    for (let n = 2; this.get(id); n++) id = `${base}-${n}`
    return id
  }

  save(input: NewEntry): Entry {
    const now = new Date().toISOString()
    const title = clean(input.title.trim())
    const body = clean((input.body ?? "").trim())
    this.lastRedactions = title.redactions + body.redactions
    const entry: Entry = {
      id: this.uniqueId(`${now.slice(0, 10)}-${slugify(title.text)}`),
      scope: input.scope ?? "project",
      type: input.type,
      title: title.text,
      body: body.text,
      tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
      pinned: input.pinned ?? false,
      status: input.type === "blocker" ? (input.status ?? "open") : undefined,
      expires: normalizeDate(input.expires),
      created: now,
      updated: now,
      branch: input.branch,
      commit: input.commit,
      model: input.model,
      session: input.session,
    }
    writeAtomic(join(this.entriesDir(entry.scope), `${entry.id}.md`), this.serialize(entry))
    if (entry.scope === "project") this.touchProject()
    return entry
  }

  update(id: string, patch: EntryPatch, by: Provenance = {}): Entry | undefined {
    const current = this.get(id)
    if (!current) return undefined
    let redactions = 0
    const next: Entry = { ...current, ...by, updated: new Date().toISOString() }
    if (patch.title !== undefined) {
      const t = clean(patch.title.trim())
      next.title = t.text
      redactions += t.redactions
    }
    if (patch.body !== undefined) {
      const b = clean(patch.body.trim())
      next.body = b.text
      redactions += b.redactions
    }
    if (patch.tags !== undefined) next.tags = patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    if (patch.type !== undefined) next.type = patch.type
    if (patch.status !== undefined) next.status = patch.status
    if (patch.expires !== undefined) next.expires = patch.expires === "" ? undefined : (normalizeDate(patch.expires) ?? next.expires)
    if (next.type === "blocker" && !next.status) next.status = "open"
    if (patch.scope !== undefined) next.scope = patch.scope
    this.lastRedactions = redactions
    const oldPath = join(this.entriesDir(current.scope), `${current.id}.md`)
    const newPath = join(this.entriesDir(next.scope), `${next.id}.md`)
    writeAtomic(newPath, this.serialize(next))
    if (newPath !== oldPath) removeFile(oldPath)
    return next
  }

  private trashDir(): string {
    const dir = join(this.root, "trash")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Move an entry to trash/ (recoverable by moving the file back). */
  forget(id: string, reason?: string): Entry | undefined {
    const entry = this.get(id)
    return entry ? this.moveOut(entry, this.trashDir(), { forgotten: new Date().toISOString(), reason: reason || undefined }) : undefined
  }

  /** Move an entry out of the active logbook into trash/ or archive/, keeping a readable copy. */
  private moveOut(entry: Entry, dir: string, extra: Record<string, unknown>): Entry {
    const source = join(this.entriesDir(entry.scope), `${entry.id}.md`)
    const { fields, body } = parse(readFileSync(source, "utf8"))
    const from = entry.scope === "global" ? "global" : this.project.id
    // Written first, so a crash in between leaves a copy rather than nothing.
    let target = join(dir, `${entry.id}.md`)
    if (existsSync(target)) target = join(dir, `${entry.id}.${Date.now()}.md`)
    writeAtomic(target, stringify({ ...fields, ...extra, from }, body))
    removeFile(source)
    return entry
  }

  private archiveDir(): string {
    const dir = join(this.root, "archive")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * Housekeeping, run at startup: entries past their expiry date and blockers
   * resolved more than 30 days ago move to archive/ (readable, restorable).
   */
  archiveStale(now = new Date()): Entry[] {
    const cutoff = now.getTime() - ARCHIVE_RESOLVED_AFTER_DAYS * 86_400_000
    const moved: Entry[] = []
    for (const e of this.list("all", { includeExpired: true })) {
      const expired = isExpired(e, now)
      const oldResolved = e.type === "blocker" && e.status === "resolved" && Date.parse(e.updated) < cutoff
      if (!expired && !oldResolved) continue
      try {
        moved.push(
          this.moveOut(e, this.archiveDir(), {
            archived: now.toISOString(),
            reason: expired ? `expired ${e.expires}` : "resolved blocker",
          }),
        )
      } catch {
        // a file locked or removed meanwhile; try again next start
      }
    }
    return moved
  }

  // --- export / import ------------------------------------------------------

  exportAll(scope: "project" | "all"): ExportFile {
    const entries = this.list(scope === "all" ? "all" : "project").map((e) => ({ ...e }))
    const blocks = (scope === "all" ? BLOCK_NAMES : (["project", "session"] as const)).map((n) =>
      this.readBlock(n),
    )
    return { format: "open-logbook", version: 1, exported: new Date().toISOString(), project: this.project.label, blocks, entries }
  }

  importAll(data: unknown): ImportReport {
    const file = data as Partial<ExportFile>
    if (!file || file.format !== "open-logbook" || !Array.isArray(file.entries)) {
      throw new Error("not an open-logbook export (expected format: open-logbook)")
    }
    const report: ImportReport = { added: 0, skipped: 0, renamed: 0, blocksSet: [], blocksSkipped: [] }
    for (const raw of file.entries) {
      if (!raw || typeof raw.title !== "string") continue
      const type = ENTRY_TYPES.includes(raw.type) ? raw.type : "context"
      const scope: Scope = raw.scope === "global" ? "global" : "project"
      const existing = typeof raw.id === "string" ? this.get(raw.id) : undefined
      if (existing && existing.body === (raw.body ?? "").trim() && existing.title === raw.title) {
        report.skipped++
        continue
      }
      const created = typeof raw.created === "string" ? raw.created : new Date().toISOString()
      const base = typeof raw.id === "string" && /^[a-z0-9-]+$/.test(raw.id) ? raw.id : `${created.slice(0, 10)}-${slugify(raw.title)}`
      const id = this.uniqueId(base)
      if (id !== base) report.renamed++
      const title = clean(raw.title)
      const body = clean(raw.body ?? "")
      const entry: Entry = {
        id,
        scope,
        type,
        title: title.text,
        body: body.text,
        tags: asStringList(raw.tags),
        pinned: raw.pinned === true,
        status: type === "blocker" ? (raw.status === "resolved" ? "resolved" : "open") : undefined,
        created,
        updated: typeof raw.updated === "string" ? raw.updated : created,
        branch: raw.branch,
        commit: raw.commit,
        model: raw.model,
        session: raw.session,
      }
      writeAtomic(join(this.entriesDir(scope), `${id}.md`), this.serialize(entry))
      report.added++
    }
    for (const block of file.blocks ?? []) {
      if (!BLOCK_NAMES.includes(block?.name)) continue
      if (!block.content?.trim()) continue
      if (this.readBlock(block.name).content) {
        report.blocksSkipped.push(block.name)
      } else {
        this.writeBlock(block.name, block.content)
        report.blocksSet.push(block.name)
      }
    }
    if (report.added) this.touchProject()
    return report
  }
}

export interface ExportFile {
  format: "open-logbook"
  version: 1
  exported: string
  project: string
  blocks: Block[]
  entries: Entry[]
}

export interface ImportReport {
  added: number
  skipped: number
  renamed: number
  blocksSet: BlockName[]
  blocksSkipped: BlockName[]
}
