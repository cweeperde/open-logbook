import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"

export interface Project {
  /** Folder name under projects/, stable across machines when a remote exists. */
  readonly id: string
  /** Human-readable name, e.g. github.com/cweeperde/open-logbook. */
  readonly label: string
  readonly remote?: string
  readonly root: string
}

const GIT_OPTIONS = { encoding: "utf8", windowsHide: true } as const

/** Synchronous git, only used once at startup to identify the project. */
export function git(dir: string, args: string[], timeout = 3000): string | undefined {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], {
      ...GIT_OPTIONS,
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/** Asynchronous git for anything that runs during a session, so a slow repo never blocks OpenCode. */
export function gitAsync(dir: string, args: string[], timeout = 1500): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      execFile("git", ["-C", dir, ...args], { ...GIT_OPTIONS, timeout }, (error, stdout) => {
        done(error ? undefined : String(stdout).trim() || undefined)
      })
    } catch {
      done(undefined)
    }
  })
}

/**
 * Turn any common remote URL form into host/owner/repo, without credentials,
 * scheme, port or .git suffix:
 *   git@github.com:Owner/Repo.git          -> github.com/owner/repo
 *   https://user:tok@github.com/owner/repo -> github.com/owner/repo
 *   ssh://git@host:2222/group/sub/repo.git -> host/group/sub/repo
 * A remote on the local disk names no shared project and returns undefined.
 */
export function normalizeRemote(url: string): string | undefined {
  let s = url.trim()
  if (!s) return undefined
  if (/^(file:\/\/|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(s)) return undefined
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  s = s.replace(/^[^@/]+@/, "")
  if (hadScheme) {
    s = s.replace(/^([^/:]+):\d+(?=\/)/, "$1")
  } else {
    // scp-like syntax: host:path
    const scp = /^([^/:]+):(.+)$/.exec(s)
    if (scp) s = `${scp[1]}/${scp[2]}`
  }
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/{2,}/g, "/")
  return s ? s.toLowerCase() : undefined
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "")
}

/**
 * The real path with the file system's own spelling: on Windows and macOS a
 * folder opened as "Proj" or "proj", or through a symlink, is the same project.
 */
export function canonical(path: string): string {
  const full = resolve(path)
  try {
    return realpathSync.native(full)
  } catch {
    return full
  }
}

export function identify(directory: string): Project {
  const root = canonical(git(directory, ["rev-parse", "--show-toplevel"]) ?? directory)
  const firstRemote = git(root, ["remote"])?.split(/\r?\n/)[0]
  const remoteUrl =
    git(root, ["remote", "get-url", "origin"]) ?? (firstRemote ? git(root, ["remote", "get-url", firstRemote]) : undefined)
  const remote = remoteUrl ? normalizeRemote(remoteUrl) : undefined
  if (remote) return { id: slug(remote), label: remote, remote, root }
  // Windows paths are case-insensitive even where realpath cannot run (e.g. a missing folder).
  const key = process.platform === "win32" ? root.toLowerCase() : root
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8)
  return { id: `local_${slug(basename(root)) || "root"}_${hash}`, label: root, root }
}

export interface GitState {
  branch?: string
  commit?: string
}

/**
 * Branch and commit for provenance, fetched in the background and cached for a
 * few seconds, so saving several entries in a row costs at most one git call.
 */
export function provenanceSource(root: string, ttlMs = 5000) {
  let cached: { at: number; state: Promise<GitState> } | undefined
  return (): Promise<GitState> => {
    const now = Date.now()
    if (!cached || now - cached.at > ttlMs) {
      const state = Promise.all([
        gitAsync(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
        gitAsync(root, ["rev-parse", "--short", "HEAD"]),
      ]).then(([branch, commit]) => ({ branch: branch && branch !== "HEAD" ? branch : undefined, commit }))
      cached = { at: now, state }
    }
    return cached.state
  }
}
