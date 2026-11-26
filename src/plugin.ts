import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { COMMANDS, INCOGNITO_COMMAND } from "./commands.ts"
import { AFTER_COMPACTION_NOTE, buildContext, COMPACTION_NOTE } from "./context.ts"
import { capture } from "./extract.ts"
import type { HistorySource } from "./history.ts"
import { IncognitoSessions } from "./incognito.ts"
import { identify, provenanceSource } from "./project.ts"
import { needsProjectStart, startProject } from "./projectstart.ts"
import { Logbook } from "./store.ts"
import { createTools } from "./tools.ts"

type Context = Plugin.Context

/**
 * Plugin options (in opencode.json, `{ "package": "...", "options": { ... } }`):
 *   storage  folder for the logbook (default ~/.open-logbook, or $OPEN_LOGBOOK_DIR)
 *   budget   tokens for the session-start context (default 5000)
 *   capture  use the session's model to keep the logbook current: at compaction,
 *            and once per new project to read its docs (default true)
 */
export function resolveSettings(options: Record<string, unknown> = {}, env = process.env) {
  const storage =
    typeof options.storage === "string" && options.storage
      ? options.storage.replace(/^~(?=$|[\\/])/, homedir())
      : env.OPEN_LOGBOOK_DIR || join(homedir(), ".open-logbook")
  const budget = typeof options.budget === "number" && options.budget >= 200 ? options.budget : 5000
  return {
    storage: resolve(storage),
    budgetChars: budget * 4,
    capture: options.capture !== false,
  }
}

/** OPEN_LOGBOOK_DEBUG=1 logs to stderr; set it to a file path to append there instead. */
const debug = (message: string) => {
  const target = process.env.OPEN_LOGBOOK_DEBUG
  if (!target) return
  const line = `${new Date().toISOString()} [open-logbook] ${message}`
  if (target === "1") console.error(line)
  else
    try {
      appendFileSync(target, `${line}\n`)
    } catch {
      console.error(line)
    }
}

export const INCOGNITO_ON = `Logbook incognito is on for the rest of this session. Nothing from the logbook is loaded or searched, and nothing from this session is saved. Run /${INCOGNITO_COMMAND} again to turn it off. New sessions use the logbook as usual.`
export const INCOGNITO_OFF = `Logbook incognito is off. The logbook is loaded again from the next message on, and this session can be remembered.`

const isLogbookTool = (name: string) => /^logbook_/.test(name)

const plugin = {
  id: "open-logbook",
  async setup(ctx: Context) {
    const settings = resolveSettings(ctx.options)
    const directory = ctx.location.project?.directory ?? ctx.location.directory
    const project = identify(directory)
    const logbook = new Logbook(settings.storage, project)
    const gitState = provenanceSource(project.root)

    try {
      const archived = logbook.archiveStale()
      if (archived.length) debug(`archived ${archived.length} expired or old resolved entries`)
    } catch (error) {
      debug(`housekeeping failed: ${(error as Error).message}`)
    }

    // Per-session state. The injected snapshot is built once and reused so the
    // provider's prompt cache stays valid; compaction clears it.
    const snapshots = new Map<string, string>()
    const models = new Map<string, any>()
    const compacted = new Set<string>()
    const capturing = new Set<string>()
    const incognito = new IncognitoSessions(settings.storage)
    let projectStartRunning = false

    const modelName = (sessionID?: string) => {
      const m = sessionID ? models.get(sessionID) : undefined
      return m ? `${m.providerID}/${m.id}` : undefined
    }
    const prov = async (sessionID?: string) => ({
      ...(await gitState()),
      model: modelName(sessionID),
      session: sessionID,
    })
    const generateWith = (model: any) => async (prompt: string) =>
      (await ctx.experimental.generate.text({ prompt, model })).text

    await ctx.session.hook("context", (event) => {
      models.set(event.sessionID, event.model)
      if (incognito.has(event.sessionID)) {
        // Fully off: no logbook text, and the agent cannot reach the tools.
        for (const name of Object.keys(event.tools)) if (isLogbookTool(name)) delete event.tools[name]
        return
      }
      let text = snapshots.get(event.sessionID)
      if (text === undefined) {
        text = buildContext(logbook, settings.budgetChars)
        snapshots.set(event.sessionID, text)
      }
      event.system.push({ type: "text", text })
      if (compacted.has(event.sessionID)) {
        event.system.push({ type: "text", text: AFTER_COMPACTION_NOTE })
        compacted.delete(event.sessionID)
      }
      // First time in this project: draft the project profile from its root docs, in the background.
      if (settings.capture && !projectStartRunning && needsProjectStart(logbook)) {
        projectStartRunning = true
        void startProject(logbook, generateWith(event.model))
          .then((files) => debug(`project start read ${files.length ? files.join(", ") : "no docs"}`))
          .catch((error) => debug(`project start failed: ${(error as Error).message}`))
          .finally(() => {
            projectStartRunning = false
          })
      }
    })

    await ctx.session.hook("compaction", (event) => {
      snapshots.delete(event.sessionID)
      if (incognito.has(event.sessionID)) return
      if (!settings.capture) {
        event.system.push({ type: "text", text: COMPACTION_NOTE })
        compacted.add(event.sessionID)
        return
      }
      if (capturing.has(event.sessionID)) return
      capturing.add(event.sessionID)
      // Runs alongside the compaction instead of delaying it.
      const messages = [...event.messages]
      const model = event.model
      void (async () => {
        try {
          const result = await capture(logbook, messages, generateWith(model), {
            ...(await prov(event.sessionID)),
            model: `${model.providerID}/${model.id}`,
          })
          debug(
            `capture: ${result.saved.length} saved, ${result.skipped} duplicates skipped, profiles updated: ${result.profiles.join(", ") || "none"}${result.session ? ", session note written" : ""}`,
          )
        } catch (error) {
          const message = `capture at compaction failed: ${(error as Error).message}`
          debug(message)
          console.error(`[open-logbook] ${message}`)
        } finally {
          capturing.delete(event.sessionID)
        }
      })()
    })

    const history: HistorySource = {
      async sessions(limit) {
        const projectID = (ctx.location as any).project?.id
        const result: any = await ctx.session.list({
          limit,
          order: "desc",
          ...(projectID ? { project: projectID } : { directory: project.root as any }),
        })
        return (result?.data ?? []).map((s: any) => ({
          id: String(s.id),
          title: s.title,
          updated: s.time?.updated ?? s.time?.created,
        }))
      },
      async messages(sessionID) {
        return (await ctx.session.context({ sessionID: sessionID as any })) as ReadonlyArray<unknown>
      },
    }

    const tools = createTools(logbook, prov, directory, history)
    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as any,
          // Plugin tools are otherwise only reachable through OpenCode's code-mode
          // `execute` tool; memory tools should be one direct call away.
          options: { codemode: false },
          execute: async (input: any, call) => {
            if (incognito.has(call.sessionID)) return { content: "The logbook is off in this session (incognito)." }
            try {
              return { content: await tool.run(input ?? {}, { sessionID: call.sessionID }) }
            } catch (error) {
              return { content: `open-logbook error: ${(error as Error).message}` }
            }
          },
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: INCOGNITO_COMMAND,
        description: "Turn the logbook off (or back on) for the rest of this session",
        execute: async (invocation) => {
          debug(`command ${INCOGNITO_COMMAND}`)
          const on = incognito.toggle(invocation.sessionID)
          snapshots.delete(invocation.sessionID)
          debug(`incognito ${on ? "on" : "off"} for ${invocation.sessionID}`)
          // A visible notice in the session, without starting a model turn.
          await ctx.session.synthetic({
            sessionID: invocation.sessionID,
            text: on ? INCOGNITO_ON : INCOGNITO_OFF,
            description: on ? "Logbook incognito on" : "Logbook incognito off",
            delivery: invocation.delivery,
            resume: false,
          })
        },
      })
      for (const command of COMMANDS) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async (invocation) => {
            debug(`command ${command.name}`)
            if (incognito.has(invocation.sessionID)) {
              await ctx.session.synthetic({
                sessionID: invocation.sessionID,
                text: `The logbook is off in this session (incognito). Run /${INCOGNITO_COMMAND} to turn it back on.`,
                description: "Logbook incognito",
                delivery: invocation.delivery,
                resume: false,
              })
              return
            }
            await ctx.session.prompt({
              sessionID: invocation.sessionID,
              text: command.prompt(invocation.prompt.text ?? ""),
              delivery: invocation.delivery,
            })
          },
        })
      }
    })
  },
}

export default plugin
