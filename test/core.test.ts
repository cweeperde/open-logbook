import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildContext, tidyReport } from "../src/context.ts"
import { parse, stringify } from "../src/frontmatter.ts"
import { identify, normalizeRemote } from "../src/project.ts"
import { redact } from "../src/redact.ts"
import { search } from "../src/search.ts"
import { Logbook, slugify } from "../src/store.ts"

function temp(name: string) {
  return mkdtempSync(join(tmpdir(), `open-logbook-${name}-`))
}

function fresh(project = { id: "github.com_me_repo", label: "github.com/me/repo", root: "/repo" }) {
  return new Logbook(temp("store"), project)
}

// --- frontmatter --------------------------------------------------------------

test("frontmatter round-trips values that look like other types", () => {
  const fields = { title: "Use 1234 workers", commit: "0123456", tags: ["a", "b"], pinned: true, note: " spaced" }
  const { fields: back, body } = parse(stringify(fields, "Body text\n\nmore"))
  assert.deepEqual(back, fields)
  assert.equal(body.trim(), "Body text\n\nmore")
})

test("frontmatter accepts hand-written lists and plain text", () => {
  const { fields } = parse("---\ntags: [ci, testing]\ntitle: Fix: retries\n---\nhi")
  assert.deepEqual(fields.tags, ["ci", "testing"])
  assert.equal(fields.title, "Fix: retries")
})

test("text without frontmatter is all body", () => {
  assert.deepEqual(parse("just text"), { fields: {}, body: "just text" })
})

// --- project identity --------------------------------------------------------

test("remote URLs normalise to host/owner/repo", () => {
  for (const url of [
    "git@github.com:Me/Repo.git",
    "https://github.com/me/repo",
    "https://user:ghp_secret@github.com/me/repo.git",
    "ssh://git@github.com/me/repo.git",
    "ssh://git@github.com:22/me/repo",
    "git+https://github.com/me/repo.git/",
  ]) {
    assert.equal(normalizeRemote(url), "github.com/me/repo", url)
  }
  assert.equal(normalizeRemote("git@gitlab.example.com:group/sub/proj.git"), "gitlab.example.com/group/sub/proj")
})

test("identify uses the git remote, and falls back to the path", () => {
  const repo = temp("repo")
  execFileSync("git", ["init", "-q", repo])
  const sub = join(repo, "src", "deep")
  mkdirSync(sub, { recursive: true })
  const local = identify(sub)
  assert.match(local.id, /^local_open-logbook-repo-[a-z0-9]+_[0-9a-f]{8}$/)
  assert.equal(identify(repo).id, local.id, "subfolders map to the repo root")

  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:Me/Thing.git"])
  const remote = identify(sub)
  assert.equal(remote.label, "github.com/me/thing")
  assert.equal(remote.id, "github.com_me_thing")
})

test("identify works outside git", () => {
  const dir = temp("plain")
  assert.match(identify(dir).id, /^local_/)
})

// --- redaction ------------------------------------------------------------------

test("redacts common secret formats and keeps the surrounding text", () => {
  const cases: Array<[string, RegExp]> = [
    [`token ghp_${"a".repeat(36)} here`, /token \[redacted github token\] here/],
    [`OPENAI_API_KEY=sk-proj-${"x".repeat(40)}`, /\[redacted/],
    [`key sk-ant-api03-${"y".repeat(40)}`, /\[redacted anthropic key\]/],
    ["aws AKIAABCDEFGHIJKLMNOP done", /aws \[redacted aws key\] done/],
    [`Authorization: Bearer ${"z".repeat(30)}`, /Bearer \[redacted\]/],
    ['password = "hunter2hunter2"', /password = "\[redacted\]"/],
    ["-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", /^\[redacted private key\]$/],
  ]
  for (const [input, expected] of cases) {
    const { text, count } = redact(input)
    assert.match(text, expected, input)
    assert.ok(count >= 1)
  }
})

test("private tags are removed, and an unclosed tag hides the rest", () => {
  assert.equal(redact("a <private>secret</private> b").text, "a [private] b")
  assert.equal(redact("a <private>secret and more").text, "a [private]")
})

test("ordinary text is untouched", () => {
  const text = "Run tests with node --test; commit 0a1b2c3; uuid 123e4567-e89b-12d3-a456-426614174000"
  assert.deepEqual(redact(text), { text, count: 0 })
})

// --- store ----------------------------------------------------------------------

test("save, get, update, forget", () => {
  const lb = fresh()
  const e = lb.save({ type: "decision", title: "Use Node's test runner", body: "No Bun in CI.", tags: ["Testing"], branch: "main" })
  assert.equal(e.id, `${e.created.slice(0, 10)}-use-node-s-test-runner`)
  assert.deepEqual(lb.get(e.id)?.tags, ["testing"])
  assert.equal(lb.get(e.id)?.branch, "main")

  const second = lb.save({ type: "decision", title: "Use Node's test runner" })
  assert.equal(second.id, `${e.id}-2`, "same title gets a unique id")

  const updated = lb.update(e.id, { body: "No Bun in CI, and Node 24 strips types.", pinned: true })
  assert.equal(updated?.pinned, true)
  assert.equal(lb.get(e.id)?.body, "No Bun in CI, and Node 24 strips types.")

  assert.ok(lb.forget(e.id, "test"))
  assert.equal(lb.get(e.id), undefined)
  const trash = readdirSync(join(lb.root, "trash"))
  assert.ok(trash.includes(`${e.id}.md`))
  assert.match(readFileSync(join(lb.root, "trash", `${e.id}.md`), "utf8"), /reason: test/)
})

test("entries are stored per project and globally, outside the repo", () => {
  const lb = fresh()
  const p = lb.save({ type: "learning", title: "Project fact" })
  const g = lb.save({ type: "preference", title: "Answer in German", scope: "global" })
  assert.ok(existsSync(join(lb.root, "projects", "github.com_me_repo", "entries", `${p.id}.md`)))
  assert.ok(existsSync(join(lb.root, "entries", `${g.id}.md`)))
  assert.ok(existsSync(join(lb.root, "projects", "github.com_me_repo", "project.json")))

  const other = new Logbook(lb.root, { id: "other", label: "other", root: "/other" })
  assert.deepEqual(other.list().map((e) => e.title), ["Answer in German"], "global entries are shared, project ones are not")
})

test("moving an entry to another scope keeps one copy", () => {
  const lb = fresh()
  const e = lb.save({ type: "preference", title: "Tabs not spaces" })
  lb.update(e.id, { scope: "global" })
  assert.equal(lb.list().length, 1)
  assert.equal(lb.get(e.id)?.scope, "global")
})

test("blockers default to open; secrets are redacted on save", () => {
  const lb = fresh()
  const b = lb.save({ type: "blocker", title: "CI flaky", body: `token ghp_${"q".repeat(36)}` })
  assert.equal(b.status, "open")
  assert.doesNotMatch(readFileSync(join(lb.projectDir, "entries", `${b.id}.md`), "utf8"), /ghp_/)
  assert.equal(lb.lastRedactions, 1)
  lb.update(b.id, { status: "resolved" })
  assert.equal(lb.get(b.id)?.status, "resolved")
})

test("hand-edited entry files are read leniently", () => {
  const lb = fresh()
  const dir = join(lb.projectDir, "entries")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "my-note.md"), "---\ntype: learning\ntags: [a, b]\n---\nWritten by hand.\n")
  writeFileSync(join(dir, "no-frontmatter.md"), "Just text\n")
  const list = lb.list()
  assert.equal(list.length, 2)
  const note = lb.get("my-note")
  assert.equal(note?.title, "my-note")
  assert.deepEqual(note?.tags, ["a", "b"])
  assert.equal(lb.get("no-frontmatter")?.type, "context")
})

test("get rejects path tricks", () => {
  const lb = fresh()
  assert.equal(lb.get("../../etc/passwd"), undefined)
})

test("blocks keep their limit and report size", () => {
  const lb = fresh()
  assert.equal(lb.readBlock("human").content, "")
  lb.writeBlock("project", "Node plugin. Test with npm test.")
  const block = lb.readBlock("project")
  assert.equal(block.content, "Node plugin. Test with npm test.")
  assert.equal(block.limit, 6000)
  assert.ok(block.updated && Date.now() - Date.parse(block.updated) < 60_000)
  assert.equal(lb.readBlock("session").limit, 4000)
})

test("export and import round-trip, skipping duplicates", () => {
  const a = fresh()
  a.save({ type: "decision", title: "One" })
  a.save({ type: "learning", title: "Two", scope: "global" })
  a.writeBlock("human", "Likes short answers.")
  const data = JSON.parse(JSON.stringify(a.exportAll("all")))

  const b = fresh()
  const first = b.importAll(data)
  assert.equal(first.added, 2)
  assert.deepEqual(first.blocksSet, ["human"])
  const again = b.importAll(data)
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 2)
  assert.deepEqual(again.blocksSkipped, ["human"])
  assert.throws(() => b.importAll({ nope: true }), /not an open-logbook export/)
})

test("slugify handles accents and empty titles", () => {
  assert.equal(slugify("Größe ändern & testen"), "grosse-andern-testen")
  assert.equal(slugify("!!!"), "entry")
})

// --- search ---------------------------------------------------------------------

test("search ranks title matches first and filters", () => {
  const lb = fresh()
  lb.save({ type: "learning", title: "Run tests with node --test", body: "Uses type stripping." })
  lb.save({ type: "decision", title: "Database choice", body: "We test against SQLite in CI." })
  lb.save({ type: "blocker", title: "Windows path bug", body: "Paths with spaces break the tests." })
  const hits = search(lb.list(), { query: "tests" })
  assert.equal(hits[0].entry.title, "Run tests with node --test")
  assert.equal(hits.length, 3, "prefix matching finds test, tests and testing")
  assert.deepEqual(search(lb.list(), { query: "tests", type: "blocker" }).map((h) => h.entry.type), ["blocker"])
  assert.equal(search(lb.list(), { query: "kubernetes" }).length, 0)
  assert.equal(search(lb.list(), {}).length, 3)
})

// --- context --------------------------------------------------------------------

test("session context holds blocks, pinned, open blockers and recent decisions", () => {
  const lb = fresh()
  lb.writeBlock("human", "Prefers German.")
  lb.save({ type: "learning", title: "Pinned learning", pinned: true })
  const solved = lb.save({ type: "blocker", title: "Solved blocker" })
  lb.update(solved.id, { status: "resolved" })
  lb.save({ type: "blocker", title: "Open blocker" })
  for (let i = 1; i <= 7; i++) lb.save({ type: "decision", title: `Decision ${i}` })
  lb.save({ type: "learning", title: "Unpinned learning" })

  const text = buildContext(lb, 8000)
  assert.match(text, /Prefers German\./)
  assert.match(text, /Pinned learning/)
  assert.match(text, /Open blocker/)
  assert.doesNotMatch(text, /Solved blocker/)
  assert.doesNotMatch(text, /Unpinned learning/)
  assert.equal((text.match(/\[decision\]/g) ?? []).length, 5)
  assert.match(text, /more entries are in the logbook/)
})

test("session context respects the budget", () => {
  const lb = fresh()
  for (let i = 0; i < 50; i++) lb.save({ type: "learning", title: `Pinned ${i} ${"x".repeat(80)}`, pinned: true })
  const text = buildContext(lb, 3000)
  assert.ok(text.length < 3300, `context was ${text.length} characters`)
})

test("oversized blocks carry a note to condense", () => {
  const lb = fresh()
  lb.writeBlock("human", "x".repeat(8100))
  assert.match(buildContext(lb, 8000), /over its 8000 limit/)
  assert.equal(tidyReport(lb).oversizedBlocks.length, 1)
})

test("tidy report finds duplicates", () => {
  const lb = fresh()
  lb.save({ type: "decision", title: "Use SQLite for storage", tags: ["db"] })
  lb.save({ type: "decision", title: "Use SQLite storage", tags: ["db"] })
  lb.save({ type: "learning", title: "Use SQLite for storage" })
  const r = tidyReport(lb)
  assert.equal(r.duplicates.length, 1, "only same-type pairs count")
  assert.equal(r.empty.length, 3)
})
