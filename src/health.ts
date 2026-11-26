import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parse } from "./frontmatter.ts"
import { removeFile, writeAtomic } from "./fsutil.ts"
import { ENTRY_TYPES, type Logbook } from "./store.ts"

export interface HealthReport {
  writable: boolean
  writeError?: string
  /** Entry files that are not valid entries (unknown type, unreadable). */
  brokenEntries: string[]
  /** Temporary files left behind by an interrupted write. */
  leftoverTemp: string[]
  /** Project folders whose repository is no longer at the recorded path. */
  orphanProjects: Array<{ id: string; root: string }>
}

function entryDirs(root: string): string[] {
  const dirs = [join(root, "entries")]
  const projects = join(root, "projects")
  if (existsSync(projects)) {
    for (const id of readdirSync(projects)) dirs.push(join(projects, id, "entries"))
  }
  return dirs.filter((d) => existsSync(d))
}

export function checkHealth(logbook: Logbook, now = Date.now()): HealthReport {
  const report: HealthReport = { writable: true, brokenEntries: [], leftoverTemp: [], orphanProjects: [] }

  const probe = join(logbook.root, `.write-test-${process.pid}`)
  try {
    writeAtomic(probe, "ok")
    removeFile(probe)
  } catch (error) {
    report.writable = false
    report.writeError = (error as Error).message
  }

  for (const dir of entryDirs(logbook.root)) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (name.endsWith(".tmp")) {
        // Only report temp files old enough not to belong to a write in progress.
        if (now - statSync(path).mtimeMs > 60_000) report.leftoverTemp.push(path)
        continue
      }
      if (!name.endsWith(".md")) continue
      try {
        const { fields } = parse(readFileSync(path, "utf8"))
        if (fields.type !== undefined && !ENTRY_TYPES.includes(fields.type as never)) report.brokenEntries.push(path)
      } catch {
        report.brokenEntries.push(path)
      }
    }
  }

  const projects = join(logbook.root, "projects")
  if (existsSync(projects)) {
    for (const id of readdirSync(projects)) {
      const meta = join(projects, id, "project.json")
      if (!existsSync(meta)) continue
      try {
        const { root, remote } = JSON.parse(readFileSync(meta, "utf8"))
        // Projects with a remote follow the repo anywhere, so a moved folder is fine.
        if (!remote && typeof root === "string" && !existsSync(root)) report.orphanProjects.push({ id, root })
      } catch {
        report.brokenEntries.push(meta)
      }
    }
  }
  return report
}

export function formatHealth(r: HealthReport): string {
  const lines: string[] = []
  if (!r.writable) lines.push(`The logbook folder is not writable: ${r.writeError}. Nothing can be saved until this is fixed.`)
  if (r.brokenEntries.length)
    lines.push(`Files that are not valid entries (fix the frontmatter or remove them):\n${r.brokenEntries.map((p) => `- ${p}`).join("\n")}`)
  if (r.leftoverTemp.length)
    lines.push(`Leftover temporary files from interrupted writes (safe to delete):\n${r.leftoverTemp.map((p) => `- ${p}`).join("\n")}`)
  if (r.orphanProjects.length)
    lines.push(
      `Project folders for repositories that no longer exist at their recorded path (without a git remote, so they cannot be matched again):\n${r.orphanProjects.map((o) => `- ${o.id} (was ${o.root})`).join("\n")}`,
    )
  return lines.length ? `Health: ${lines.length} problem${lines.length === 1 ? "" : "s"}\n${lines.join("\n\n")}` : "Health: no problems found."
}
