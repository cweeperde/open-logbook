// Sessions in incognito mode. Kept in a small file, not just in memory, so a
// restart of OpenCode's background service cannot silently turn the logbook
// back on in the middle of an incognito session.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomic } from "./fsutil.ts"

/** Sessions older than this are dropped from the file; their incognito state no longer matters. */
const KEEP_DAYS = 30

export class IncognitoSessions {
  private readonly path: string
  private sessions = new Map<string, number>()

  constructor(root: string) {
    this.path = join(root, "incognito.json")
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, "utf8"))
        for (const [id, at] of Object.entries(data ?? {})) if (typeof at === "number") this.sessions.set(id, at)
      }
    } catch {
      // unreadable file: start empty rather than failing the plugin
    }
  }

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  /** Turn incognito on or off for a session; returns the new state. */
  toggle(sessionID: string, now = Date.now()): boolean {
    const on = !this.sessions.has(sessionID)
    if (on) this.sessions.set(sessionID, now)
    else this.sessions.delete(sessionID)
    for (const [id, at] of this.sessions) if (now - at > KEEP_DAYS * 86_400_000) this.sessions.delete(id)
    try {
      writeAtomic(this.path, `${JSON.stringify(Object.fromEntries(this.sessions), null, 2)}\n`)
    } catch {
      // still correct for this process; persisting is best effort
    }
    return on
  }
}
