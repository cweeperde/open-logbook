import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildContext } from "../src/context.ts"
import { applyExtraction, parseExtraction, transcript } from "../src/extract.ts"
import { retrySync, writeAtomic } from "../src/fsutil.ts"
import { checkHealth, formatHealth } from "../src/health.ts"
import { formatHistory, searchHistory, textsOf } from "../src/history.ts"
import { needsProjectStart, rootDocs, startProject } from "../src/projectstart.ts"
import { canonical, identify, normalizeRemote, provenanceSource } from "../src/project.ts"
import { BLOCK_LIMITS, isExpired, Logbook } from "../src/store.ts"

const temp = (name: string) => mkdtempSync(join(tmpdir(), `open-logbook-${name}-`))
const fresh = () => new Logbook(temp("feat"), { id: "p", label: "p", root: temp("root") })
const err = (code: string) => Object.assign(new Error(code), { code })

// --- file writes --------------------------------------------------------------

test("transient Windows lock errors are retried with backoff", () => {
  const waits: number[] = []
  let calls = 0
  const result = retrySync(
    () => {
      if (++calls < 4) throw err(["EPERM", "EBUSY", "EACCES"][calls - 1])
      return "done"
    },
    (ms) => waits.push(ms),
  )
  assert.equal(result, "done")
  assert.deepEqual(waits, [10, 25, 50])
})

test("other errors and endless locks are not retried forever", () => {
  assert.throws(() => retrySync(() => { throw err("ENOENT") }, () => {}), /ENOENT/)
  let calls = 0
  assert.throws(() => retrySync(() => { calls++; throw err("EBUSY") }, () => {}), /EBUSY/)
  assert.equal(calls, 7)
})

test("atomic writes leave no temp files behind", () => {
  const dir = temp("write")
  writeAtomic(join(dir, "a", "b.md"), "one")
  writeAtomic(join(dir, "a", "b.md"), "two")
  assert.equal(readFileSync(join(dir, "a", "b.md"), "utf8"), "two")
  assert.deepEqual(readdirSync(join(dir, "a")), ["b.md"])
})

// --- project identity -----------------------------------------------------------

test("local-path remotes fall back to the path", () => {
  for (const url of ["/srv/git/x.git", "C:/repos/x.git", "C:\\repos\\x.git", "file:///srv/x", "../x.git"]) {
    assert.equal(normalizeRemote(url), undefined, url)
  }
  const repo = temp("localremote")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "C:/somewhere/else.git"])
  assert.match(identify(repo).id, /^local_/)
})

test("canonical paths make symlinked or differently spelled folders one project", () => {
  const dir = temp("canon")
  const real = join(dir, "Project")
  mkdirSync(real)
  assert.equal(canonical(real), canonical(join(dir, ".", "Project")))
  if (process.platform !== "linux") {
    // Windows and macOS file systems ignore case by default.
    assert.equal(identify(join(dir, "project")).id, identify(real).id)
  }
  try {
    symlinkSync(real, join(dir, "link"), "junction")
  } catch {
    return // symlinks need extra rights on some Windows setups
  }
  assert.equal(identify(join(dir, "link")).id, identify(real).id)
})

test("git state is read asynchronously and cached", async () => {
  const repo = temp("gitstate")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "x"])
  const source = provenanceSource(repo)
  const first = source()
  assert.equal(source(), first, "a second call within the TTL reuses the same lookup")
  const state = await first
  assert.equal(state.branch, "main")
  assert.match(state.commit ?? "", /^[0-9a-f]{7,}$/)
  assert.deepEqual(await provenanceSource(temp("nogit"))(), { branch: undefined, commit: undefined })
})

// --- capture -----------------------------------------------------------------------

test("model answers are parsed leniently and validated", () => {
  const text =
    'Sure!\n```json\n{"entries":[{"type":"learning","title":" T ","body":"b","tags":["X"],"scope":"global"},{"type":"bad","title":"x"}],"session":"S"}\n```'
  const r = parseExtraction(text)
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].title, "T")
  assert.equal(r.entries[0].scope, "global")
  assert.equal(r.session, "S")
  assert.deepEqual(parseExtraction("no json here"), { entries: [], session: "" })
})

test("the transcript keeps text and tool calls and trims from the front", () => {
  const t = transcript([
    { role: "system", content: [{ type: "text", text: "secret system prompt" }] },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "tool-call", name: "bash", input: { command: "ls" } }] },
  ])
  assert.doesNotMatch(t, /secret system prompt/)
  assert.match(t, /USER: hello/)
  assert.match(t, /\[tool bash: \{"command":"ls"\}\]/)
  assert.match(transcript([{ role: "user", content: "x".repeat(500) }], 100), /^\[…earlier part omitted…\]\nx{100}$/)
})

// --- session block and health -----------------------------------------------------------

test("a session note older than 14 days is only mentioned", () => {
  const lb = fresh()
  lb.writeBlock("session", "Working on the parser. Next: tests.")
  const now = Date.now()
  assert.match(buildContext(lb, 8000, now), /Last session, written today[\s\S]*Next: tests\./)
  const later = buildContext(lb, 8000, now + 20 * 86_400_000)
  assert.match(later, /20 days ago/)
  assert.doesNotMatch(later, /Next: tests\./)
})

test("health check reports broken files, leftovers and orphans", () => {
  const lb = fresh()
  lb.save({ type: "learning", title: "fine" })
  const entries = join(lb.projectDir, "entries")
  writeFileSync(join(entries, "bad.md"), "---\ntype: wrongtype\n---\nx")
  const tmp = join(entries, "x.md.1.2.tmp")
  writeFileSync(tmp, "half")
  utimesSync(tmp, new Date(2020, 0, 1), new Date(2020, 0, 1))
  mkdirSync(join(lb.root, "projects", "gone"), { recursive: true })
  writeFileSync(join(lb.root, "projects", "gone", "project.json"), JSON.stringify({ root: join(lb.root, "does-not-exist") }))
  const r = checkHealth(lb)
  assert.equal(r.writable, true)
  assert.equal(r.brokenEntries.length, 1)
  assert.equal(r.leftoverTemp.length, 1)
  assert.deepEqual(r.orphanProjects.map((o) => o.id), ["gone"])
  assert.match(formatHealth(r), /3 problems/)
  assert.equal(formatHealth(checkHealth(fresh())), "Health: no problems found.")
})

// --- 1.0: limits, expiry, archive ---------------------------------------------------

test("profiles have room: 8000 / 6000 / 4000 characters, and old stored limits do not shrink them", () => {
  assert.deepEqual(BLOCK_LIMITS, { human: 8000, project: 6000, session: 4000 })
  const lb = fresh()
  mkdirSync(lb.root, { recursive: true })
  writeFileSync(join(lb.root, "human.md"), "---\nblock: human\nlimit: 1500\n---\n\nOld profile.\n")
  assert.equal(lb.readBlock("human").limit, 8000)
})

test("expired entries leave search and context, and are archived at startup", () => {
  const lb = fresh()
  const past = lb.save({ type: "context", title: "At a conference in Oslo until 1 November", expires: "2020-11-01", scope: "global" })
  const future = lb.save({ type: "context", title: "Deadline on Friday", expires: "2999-01-01" })
  lb.save({ type: "learning", title: "Plain fact" })
  assert.equal(isExpired(past), true)
  assert.equal(isExpired(future), false)
  assert.deepEqual(lb.list().map((e) => e.title).sort(), ["Deadline on Friday", "Plain fact"])
  assert.doesNotMatch(buildContext(lb, 20000), /Oslo/)
  const moved = lb.archiveStale()
  assert.deepEqual(moved.map((e) => e.id), [past.id])
  const archived = readFileSync(join(lb.root, "archive", `${past.id}.md`), "utf8")
  assert.match(archived, /reason: expired 2020-11-01/)
  assert.equal(lb.list("all", { includeExpired: true }).length, 2)
})

test("expiry can be set, changed and removed", () => {
  const lb = fresh()
  const e = lb.save({ type: "context", title: "Travelling", expires: "2999-12-31T10:00:00Z" })
  assert.equal(e.expires, "2999-12-31")
  assert.equal(lb.update(e.id, { expires: "3000-01-02" })?.expires, "3000-01-02")
  assert.equal(lb.update(e.id, { expires: "not a date" })?.expires, "3000-01-02", "invalid dates are ignored")
  assert.equal(lb.update(e.id, { expires: "" })?.expires, undefined)
})

test("blockers resolved more than 30 days ago are archived; recent ones stay", () => {
  const lb = fresh()
  const old = lb.save({ type: "blocker", title: "Old problem" })
  lb.update(old.id, { status: "resolved" })
  const recent = lb.save({ type: "blocker", title: "Recent problem" })
  lb.update(recent.id, { status: "resolved" })
  const open = lb.save({ type: "blocker", title: "Still open" })
  const later = new Date(Date.now() + 40 * 86_400_000)
  // Only the first one is "old" from the point of view of a clock 40 days ahead;
  // bring the recent one up to date relative to that clock by touching it then.
  const moved = lb.archiveStale(later)
  assert.deepEqual(moved.map((e) => e.id).sort(), [old.id, recent.id].sort())
  assert.equal(lb.get(open.id)?.status, "open")
  assert.equal(lb.archiveStale(new Date()).length, 0)
})

// --- 1.0: profile updates at compaction ------------------------------------------------

test("capture rewrites a profile only when the model reports a change", () => {
  const lb = fresh()
  lb.writeBlock("human", "Name: Sam.")
  lb.writeBlock("project", "A CSV importer.")
  const found = parseExtraction(JSON.stringify({ entries: [], human: "Name: Sam. Lives in Berlin.", project: null, session: "" }))
  const r = applyExtraction(lb, found, {})
  assert.deepEqual(r.profiles, ["human"])
  assert.equal(lb.readBlock("human").content, "Name: Sam. Lives in Berlin.")
  assert.equal(lb.readBlock("project").content, "A CSV importer.")
  const same = applyExtraction(lb, parseExtraction(JSON.stringify({ entries: [], human: "Name: Sam. Lives in Berlin." })), {})
  assert.deepEqual(same.profiles, [], "an identical profile is not rewritten")
})

test("captured entries keep scope and expiry", () => {
  const r = parseExtraction(
    JSON.stringify({ entries: [{ type: "context", title: "Moves to Lisbon in March", scope: "global", expires: "2999-03-31" }] }),
  )
  assert.equal(r.entries[0].scope, "global")
  assert.equal(r.entries[0].expires, "2999-03-31")
})

// --- 1.0: project start ------------------------------------------------------------------

test("project start reads only root-level text docs, most relevant first", () => {
  const root = temp("docs")
  writeFileSync(join(root, "README.md"), "# Demo\nA demo app.")
  writeFileSync(join(root, "AGENTS.md"), "Run npm test before committing.")
  writeFileSync(join(root, "CHANGELOG.md"), "x".repeat(10_000))
  writeFileSync(join(root, "LICENSE.md"), "license text")
  writeFileSync(join(root, "notes.txt"), "Some notes.")
  writeFileSync(join(root, "index.ts"), "code")
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "docs", "deep.md"), "not read")
  const docs = rootDocs(root)
  assert.deepEqual(docs.map((d) => d.name), ["AGENTS.md", "README.md", "notes.txt", "CHANGELOG.md"])
  assert.ok(docs[3].text.length < 3100, "changelogs are read only briefly")
})

test("project start drafts the profile once and never overwrites one", async () => {
  const root = temp("start")
  writeFileSync(join(root, "README.md"), "# Demo\nA demo app.")
  const lb = new Logbook(temp("startlb"), { id: "demo", label: "demo", root })
  assert.equal(needsProjectStart(lb), true)
  const prompts: string[] = []
  const files = await startProject(lb, async (p) => {
    prompts.push(p)
    return "Demo app. Test with npm test."
  })
  assert.deepEqual(files, ["README.md"])
  assert.match(prompts[0], /===== README\.md =====/)
  assert.equal(lb.readBlock("project").content, "Demo app. Test with npm test.")
  assert.equal(needsProjectStart(lb), false)

  const other = new Logbook(temp("startlb2"), { id: "demo", label: "demo", root })
  other.writeBlock("project", "Written by hand.")
  assert.equal(needsProjectStart(other), false, "an existing profile means nothing to start")
})

// --- 1.0: history ------------------------------------------------------------------------

test("history search finds earlier sessions by their text", async () => {
  const source = {
    sessions: async () => [
      { id: "s1", title: "Import bank files", updated: Date.UTC(2026, 10, 1) },
      { id: "s2", title: "Unrelated", updated: Date.UTC(2026, 10, 2) },
      { id: "current", title: "Now" },
    ],
    messages: async (id: string) =>
      id === "s1"
        ? [{ role: "user", parts: [{ type: "text", text: "The bank CSV uses semicolons and windows-1252." }] }]
        : [{ role: "user", parts: [{ type: "text", text: "Something else entirely." }] }],
  }
  const hits = await searchHistory(source, "semicolons bank", { exclude: "current" })
  assert.deepEqual(hits.map((h) => h.session.id), ["s1"])
  assert.match(formatHistory(hits), /Import bank files \(2026-11-01, s1\)[\s\S]*semicolons/)
  assert.equal(formatHistory([]), "No earlier session of this project mentions that.")
  assert.deepEqual(textsOf({ a: [{ text: "x" }, { b: { text: "y" } }], text: 3 }), ["x", "y"])
})
