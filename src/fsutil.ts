import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// On Windows a rename or delete fails with EPERM, EBUSY or EACCES while
// another process briefly holds the file: a virus scanner, the search
// indexer, OneDrive or an editor. Those locks go away within milliseconds,
// so the operation is retried with a short backoff before giving up.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"])
const DELAYS_MS = [10, 25, 50, 100, 200, 400]

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number) {
  Atomics.wait(sleepCell, 0, 0, ms)
}

export function retrySync<T>(fn: () => T, sleep: (ms: number) => void = sleepSync): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (!code || !TRANSIENT.has(code) || attempt >= DELAYS_MS.length) throw error
      sleep(DELAYS_MS[attempt])
    }
  }
}

/** Write via a temporary file and rename, so readers never see half a file. */
export function writeAtomic(path: string, text: string, sleep?: (ms: number) => void) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, text, "utf8")
  try {
    retrySync(() => renameSync(tmp, path), sleep)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // leave the temp file; it is ignored when reading
    }
    throw error
  }
}

export function removeFile(path: string, sleep?: (ms: number) => void) {
  retrySync(() => rmSync(path, { force: true }), sleep)
}
