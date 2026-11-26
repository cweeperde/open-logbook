import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin, { resolveSettings } from "../src/plugin.ts"

// A stand-in for the parts of OpenCode's plugin context that open-logbook uses.
async function load(options: Record<string, unknown> = {}) {
  const storage = mkdtempSync(join(tmpdir(), "open-logbook-plugin-"))
  const project = mkdtempSync(join(tmpdir(), "open-logbook-proj-"))
  const hooks: Record<string, (event: any) => void | Promise<void>> = {}
  const toolHooks: Record<string, (event: any) => void | Promise<void>> = {}
  const tools: Record<string, any> = {}
  const generated: string[] = []
  const commands: Record<string, any> = {}
  const prompts: any[] = []
  const synthetics: any[] = []
  const history = (options.history as any) ?? { sessions: [], messages: {} }
  const ctx: any = {
    options: { storage, ...options },
    location: { directory: project, project: { directory: project, id: "proj_1" } },
    session: {
      hook: async (name: string, cb: any) => {
        hooks[name] = cb
        return { dispose: async () => {} }
      },
      prompt: async (input: any) => {
        prompts.push(input)
      },
      synthetic: async (input: any) => {
        synthetics.push(input)
      },
      list: async () => ({ data: history.sessions, cursor: {} }),
      context: async ({ sessionID }: any) => history.messages[sessionID] ?? [],
    },
    tool: {
      transform: async (cb: any) => cb({ add: (t: any) => (tools[t.name] = t) }),
      hook: async (name: string, cb: any) => {
        toolHooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    experimental: {
      generate: {
        text: async ({ prompt }: { prompt: string }) => {
          generated.push(prompt)
          return { text: (options.answer as string) ?? '{"entries": [], "session": ""}' }
        },
      },
    },
    command: { transform: async (cb: any) => cb({ add: (c: any) => (commands[c.name] = c) }) },
  }
  await plugin.setup(ctx)
  const call = (name: string, input: any, sessionID = "ses_1") =>
    tools[name].execute(input, { sessionID }).then((r: any) => r.content as string)
  const model = { providerID: "test-provider", id: "test-model" }
  const contextEvent = async (sessionID = "ses_1", messages: any[] = []) => {
    const event: any = {
      sessionID,
      model,
      system: [] as any[],
      messages,
      tools: Object.fromEntries([...Object.keys(tools), "read", "shell"].map((n) => [n, { description: n, input: {} }])),
    }
    await hooks.context(event)
    return event
  }
  const context = async (sessionID = "ses_1") =>
    (await contextEvent(sessionID)).system.map((p: any) => p.text).join("\n---\n")
  const command = (name: string, text = "", sessionID = "ses_1") =>
    commands[name].execute({ sessionID, prompt: { text }, delivery: "immediate" })
  return { storage, project, hooks, toolHooks, tools, commands, prompts, synthetics, generated, call, context, contextEvent, command, model }
}

test("registers all tools and commands", async () => {
  const p = await load()
  assert.deepEqual(Object.keys(p.tools).sort(), [
    "logbook_block_get",
    "logbook_block_set",
    "logbook_export",
    "logbook_forget",
    "logbook_history",
    "logbook_import",
    "logbook_list",
    "logbook_read",
    "logbook_save",
    "logbook_search",
    "logbook_tidy_report",
    "logbook_update",
  ])
  assert.deepEqual(Object.keys(p.commands).sort(), [
    "logbook",
    "logbook-add",
    "logbook-export",
    "logbook-forget",
    "logbook-import",
    "logbook-incognito",
    "logbook-me",
    "logbook-search",
    "logbook-setup",
    "logbook-sync",
    "logbook-tidy",
  ])
  for (const name of Object.keys(p.commands)) assert.match(name, /^logbook(-|$)/)
  for (const t of Object.values(p.tools)) assert.equal(t.input.type, "object")
})

test("context is injected once per session and stays byte-stable", async () => {
  const p = await load()
  const first = await p.context()
  assert.match(first, /# open-logbook/)
  await p.call("logbook_save", { type: "decision", title: "Brand new decision", body: "x" })
  assert.equal(await p.context(), first, "same session keeps its snapshot")
  assert.match(await p.context("ses_2"), /Brand new decision/, "a new session sees it")
})

test("without capture, compaction asks for unsaved facts and refreshes the snapshot", async () => {
  const p = await load({ capture: false })
  await p.context()
  await p.call("logbook_save", { type: "learning", title: "Learned mid-session", body: "y", pinned: true })
  const compaction = { sessionID: "ses_1", system: [] as any[], messages: [], model: p.model }
  await p.hooks.compaction(compaction)
  assert.match(compaction.system[0].text, /Unsaved for logbook/)
  const after = await p.context()
  assert.match(after, /Learned mid-session/)
  assert.match(after, /was just compacted/)
  assert.doesNotMatch(await p.context(), /was just compacted/, "the reminder is shown once")
})

test("saved entries record model, session and redact secrets", async () => {
  const p = await load()
  await p.context("ses_9")
  const out = await p.call("logbook_save", { type: "learning", title: "Deploy key", body: `uses ghp_${"k".repeat(36)}` }, "ses_9")
  assert.match(out, /1 secret was redacted/)
  const id = /id: ([a-z0-9-]+)/.exec(out)![1]
  const read = await p.call("logbook_read", { id })
  assert.match(read, /model: test-provider\/test-model/)
  assert.doesNotMatch(read, /ghp_/)
})

test("tools validate input instead of throwing", async () => {
  const p = await load()
  assert.match(await p.call("logbook_save", { type: "nonsense", title: "x", body: "" }), /Unknown type/)
  assert.match(await p.call("logbook_read", { id: "missing" }), /No entry/)
  assert.match(await p.call("logbook_import", { path: "does-not-exist.json" }), /Could not read/)
})

test("search, update, forget and blocks through the tools", async () => {
  const p = await load()
  const out = await p.call("logbook_save", { type: "blocker", title: "Tests hang on Windows", body: "spawn ENOENT" })
  const id = /id: ([a-z0-9-]+)/.exec(out)![1]
  assert.match(await p.call("logbook_search", { query: "windows" }), /Tests hang on Windows.*open/)
  await p.call("logbook_update", { id, status: "resolved" })
  assert.match(await p.call("logbook_search", { status: "resolved" }), /Tests hang/)
  assert.match(await p.call("logbook_block_set", { block: "human", content: "Prefers German." }), /15\/8000/)
  assert.match(await p.call("logbook_list", {}), /human: 15\/8000/)
  assert.match(await p.call("logbook_forget", { id }), /Forgot/)
  assert.match(await p.call("logbook_search", {}), /No matching entries/)
})

test("export then import into another logbook", async () => {
  const a = await load()
  await a.call("logbook_save", { type: "decision", title: "Portable", body: "z" })
  const out = await a.call("logbook_export", { scope: "all" })
  const file = /to (.+\.json)\.$/.exec(out)![1]
  assert.equal(JSON.parse(readFileSync(file, "utf8")).format, "open-logbook")
  const b = await load()
  assert.match(await b.call("logbook_import", { path: file }), /Imported 1 entries/)
})

test("commands send a prompt with the user's words", async () => {
  const p = await load()
  await p.command("logbook-add", "we deploy with fly.io")
  assert.equal(p.prompts[0].sessionID, "ses_1")
  assert.match(p.prompts[0].text, /Remember this in the logbook: we deploy with fly\.io/)
  await p.command("logbook-search")
  assert.match(p.prompts[1].text, /nothing given; ask me what to look for/)
  await p.command("logbook-me", "I moved to Hamburg")
  assert.match(p.prompts[2].text, /Correct what the logbook knows about me: I moved to Hamburg/)
})

test("settings: storage option, env var and token budget", () => {
  assert.match(resolveSettings({}, { OPEN_LOGBOOK_DIR: "/x/y" }).storage, /[\\/]x[\\/]y$/)
  assert.match(resolveSettings({}, {}).storage, /\.open-logbook$/)
  assert.equal(resolveSettings({ budget: 1000 }).budgetChars, 4000)
  assert.equal(resolveSettings({ budget: 5 }).budgetChars, 20000, "tiny budgets fall back to the default of 5000 tokens")
})

// --- capture, incognito, project start, history -----------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Background work (capture, project start) also reads git, which can take a while
// on slow CI machines: wait for the expected result instead of a fixed time.
async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(25)
  }
  assert.fail("timed out waiting for background work")
}

const conversation = [
  { role: "user", content: [{ type: "text", text: "The upload keeps failing on Windows with EBUSY. ".repeat(4) }] },
  { role: "assistant", content: [{ type: "text", text: "The antivirus holds the temp file; retrying the rename fixes it. ".repeat(4) }] },
]

test("compaction captures missing facts and the session note in the background", async () => {
  const answer = JSON.stringify({
    entries: [
      { type: "learning", title: "Windows rename fails with EBUSY under antivirus", body: "Retry the rename.", tags: ["windows"] },
      { type: "decision", title: "Existing decision", body: "dup" },
      { type: "nonsense", title: "dropped" },
    ],
    session: "Fixing uploads on Windows. Next: release 0.2.",
  })
  const p = await load({ answer })
  await p.call("logbook_save", { type: "decision", title: "Existing decision", body: "already here" })
  const compaction = { sessionID: "ses_1", system: [] as any[], messages: conversation, model: p.model }
  await p.hooks.compaction(compaction)
  assert.equal(compaction.system.length, 0, "with capture on, the summary prompt is left alone")
  await until(async () => /EBUSY/.test(await p.call("logbook_search", { query: "EBUSY" })))
  await until(async () => /release 0\.2/.test(await p.call("logbook_block_get", { block: "session" })))
  assert.equal(p.generated.length, 1)
  assert.match(p.generated[0], /Existing decision/, "the model is told what is already stored")
  const found = await p.call("logbook_search", { query: "EBUSY" })
  assert.match(found, /Windows rename fails with EBUSY/)
  assert.doesNotMatch(await p.call("logbook_search", { query: "dropped" }), /dropped/)
  assert.equal((await p.call("logbook_search", { query: "Existing decision" })).match(/Existing decision/g)?.length, 1)
  const read = await p.call("logbook_read", { id: /id: ([a-z0-9-]+)/.exec(found)![1] })
  assert.match(read, /tags: windows, auto/)
  assert.match(await p.context("ses_new"), /Last session, written today[\s\S]*release 0\.2/)
})

test("a broken model answer saves nothing and does not throw", async () => {
  const p = await load({ answer: "sorry, I can't" })
  await p.hooks.compaction({ sessionID: "ses_1", system: [], messages: conversation, model: p.model })
  await until(() => p.generated.length === 1)
  await sleep(300)
  assert.match(await p.call("logbook_search", {}), /No matching entries/)
})

test("compaction updates a profile only when the model reports a change", async () => {
  const answer = JSON.stringify({ entries: [], human: "Name: Sam. Works as a data engineer.", project: null, session: "" })
  const p = await load({ answer })
  await p.call("logbook_block_set", { block: "project", content: "Kept as is." })
  await p.hooks.compaction({ sessionID: "ses_1", system: [], messages: conversation, model: p.model })
  await until(async () => /data engineer/.test(await p.call("logbook_block_get", { block: "human" })))
  assert.match(await p.call("logbook_block_get", { block: "project" }), /Kept as is\./)
  assert.match(p.generated[0], /Current user profile:/)
})

test("incognito: nothing is loaded, the tools are gone, nothing is saved, and the user sees a notice", async () => {
  const p = await load({ answer: JSON.stringify({ entries: [{ type: "learning", title: "Should not be saved" }], session: "x" }) })
  await p.call("logbook_save", { type: "decision", title: "Known fact" })
  await p.command("logbook-incognito")
  assert.match(p.synthetics[0].text, /incognito is on/)
  assert.equal(p.synthetics[0].resume, false, "the notice does not start a model turn")

  const event = await p.contextEvent("ses_1")
  assert.equal(event.system.length, 0, "no logbook text")
  assert.deepEqual(Object.keys(event.tools).sort(), ["read", "shell"], "only non-logbook tools remain")
  assert.match(await p.call("logbook_search", { query: "Known" }), /off in this session/)
  await p.command("logbook-add", "anything")
  assert.equal(p.prompts.length, 0, "commands do not reach the agent")
  assert.match(p.synthetics[1].text, /off in this session/)

  await p.hooks.compaction({ sessionID: "ses_1", system: [], messages: conversation, model: p.model })
  await sleep(300)
  assert.equal(p.generated.length, 0, "no capture")

  assert.match(await p.context("ses_other"), /Known fact/, "other sessions are not affected")

  await p.command("logbook-incognito")
  assert.match(p.synthetics[2].text, /incognito is off/)
  assert.match(await p.context("ses_1"), /Known fact/)
})

test("first contact with a project drafts its profile from the root docs, once", async () => {
  const p = await load({ answer: "Demo app. Run with npm start." })
  writeFileSync(join(p.project, "README.md"), "# Demo\nRun with npm start.")
  await p.context("ses_1")
  await until(async () => /Demo app/.test(await p.call("logbook_block_get", { block: "project" })))
  assert.equal(p.generated.length, 1)
  assert.match(p.generated[0], /===== README\.md =====/)
  assert.match(await p.call("logbook_block_get", { block: "project" }), /Demo app/)
  await p.context("ses_2")
  await sleep(300)
  assert.equal(p.generated.length, 1, "not repeated")
})

test("logbook_history searches earlier sessions of the project, not the current one", async () => {
  const history = {
    sessions: [
      { id: "ses_old", title: "Bank import", time: { updated: Date.UTC(2026, 10, 1) } },
      { id: "ses_1", title: "Current" },
    ],
    messages: {
      ses_old: [{ parts: [{ type: "text", text: "Bank files use semicolons." }] }],
      ses_1: [{ parts: [{ type: "text", text: "semicolons mentioned now" }] }],
    },
  }
  const p = await load({ history })
  const out = await p.call("logbook_history", { query: "semicolons" })
  assert.match(out, /Bank import \(2026-11-01, ses_old\)/)
  assert.doesNotMatch(out, /Current/)
})

test("incognito survives a restart of the plugin", async () => {
  const first = await load()
  await first.command("logbook-incognito")
  const again = await load({ storage: first.storage })
  assert.equal((await again.contextEvent("ses_1")).system.length, 0, "still off after a restart")
  assert.ok((await again.contextEvent("ses_2")).system.length > 0, "other sessions unaffected")
})

// --- sensitive information ------------------------------------------------------------

test("sensitive facts need consent before the agent can save them", async () => {
  const p = await load()
  await p.call("logbook_block_set", { block: "human", content: "Kai, backend developer in Leipzig." })
  const refused = await p.call("logbook_block_set", { block: "human", content: "Kai, backend developer in Leipzig. Has type 1 diabetes." })
  assert.match(refused, /Not saved: .*sensitive.*\(health\)/)
  assert.doesNotMatch(await p.call("logbook_block_get", { block: "human" }), /diabetes/)
  assert.match(
    await p.call("logbook_block_set", { block: "human", content: "Kai, backend developer in Leipzig. Has type 1 diabetes.", consent: true }),
    /Saved the human block/,
  )
  // Once it is in the profile with consent, rewriting the profile does not ask again.
  assert.match(
    await p.call("logbook_block_set", { block: "human", content: "Kai, backend developer in Leipzig, prefers short answers. Has type 1 diabetes." }),
    /Saved the human block/,
  )
  assert.match(await p.call("logbook_save", { type: "context", title: "Going through a divorce", body: "", scope: "global" }), /relationships/)
  assert.match(await p.call("logbook_save", { type: "context", title: "Uses a standing desk", body: "", scope: "global" }), /Saved/)
})

test("capture never saves sensitive facts or adds them to a profile", async () => {
  const answer = JSON.stringify({
    entries: [
      { type: "context", title: "User takes antidepressant medication", scope: "global" },
      { type: "learning", title: "Build needs Node 24" },
    ],
    human: "Kai. Diagnosed with ADHD.",
  })
  const p = await load({ answer })
  await p.call("logbook_block_set", { block: "human", content: "Kai." })
  await p.hooks.compaction({ sessionID: "ses_1", system: [], messages: conversation, model: p.model })
  await until(async () => /Build needs Node 24/.test(await p.call("logbook_search", { query: "node" })))
  assert.doesNotMatch(await p.call("logbook_search", {}), /antidepressant/)
  assert.doesNotMatch(await p.call("logbook_block_get", { block: "human" }), /ADHD/)
})
