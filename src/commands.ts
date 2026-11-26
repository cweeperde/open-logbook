// Slash commands for the user, all starting with /logbook so they list
// together. Each turns the user's words into a prompt for the agent, which
// then uses the logbook tools. /logbook-incognito is handled in plugin.ts.

export interface CommandSpec {
  name: string
  description: string
  prompt: (args: string) => string
}

const need = (args: string, what: string) => (args.trim() ? args.trim() : `(nothing given; ask me ${what})`)

export const INCOGNITO_COMMAND = "logbook-incognito"

export const COMMANDS: CommandSpec[] = [
  {
    name: "logbook",
    description: "Overview of the logbook and a health check",
    prompt: () =>
      `Give me a short overview of the logbook: call logbook_list, then show the user, project and session profiles (logbook_block_get) and the five most recently updated entries (logbook_search without a query). Mention any health problems it reports.`,
  },
  {
    name: "logbook-add",
    description: "Remember something",
    prompt: (args) =>
      `Remember this in the logbook: ${need(args, "what to remember")}\n\nIf it is about me, update my profile (block "human") or save a global entry; if it is about the project, update the project profile or save a project entry. Pick the fitting type and add an expiry date if it is time-bound. Search first and update a matching entry instead of adding a duplicate. If it is sensitive, ask me before saving. Confirm in a few words, without repeating everything.`,
  },
  {
    name: "logbook-search",
    description: "Ask what the logbook knows",
    prompt: (args) =>
      `What does the logbook know about: ${need(args, "what to look for")}\n\nUse logbook_search (try a second query with other words if the first finds little) and read the entries that matter. If the logbook has nothing, try logbook_history to look through earlier sessions of this project. Answer from what you found, and say plainly if nothing relevant is stored.`,
  },
  {
    name: "logbook-forget",
    description: "Remove something from the logbook (asks first)",
    prompt: (args) =>
      `I want this removed from the logbook: ${need(args, "what to forget")}\n\nFind the matching entries and any matching lines in the profiles. List them and ask me which to remove; only then call logbook_forget, or rewrite the profile with logbook_block_set without those lines.`,
  },
  {
    name: "logbook-me",
    description: "Show what the logbook knows about me, and correct it",
    prompt: (args) =>
      args.trim()
        ? `Correct what the logbook knows about me: ${args.trim()}\n\nUpdate my profile (block "human") and any global entries that are affected, so nothing outdated remains. Confirm in one short line.`
        : `Show me what the logbook knows about me: my profile (logbook_block_get "human") and the global entries (logbook_search with scope "global"), as a short readable list in my language. Then ask whether anything is wrong or missing; if I correct something, update the profile and entries.`,
  },
  {
    name: "logbook-sync",
    description: "Refresh the user and project profiles now",
    prompt: () =>
      `Refresh the logbook profiles. Read the user profile and project profile (logbook_block_get "human" and "project") and the entries (logbook_search with a limit of 50, once for scope "global" and once for "project"). Rewrite each profile so it reflects everything current: merge in facts from the entries and from this conversation, drop what is outdated or contradicted, keep it concise and under its size limit, in English. Save with logbook_block_set only the profiles that actually change. Then say in one short line which profiles were updated.`,
  },
  {
    name: "logbook-setup",
    description: "Answer a few questions so the logbook knows you",
    prompt: () =>
      `Help the logbook get to know me. First read my current profile (logbook_block_get "human"). Then ask me, in my language and in one short message, the questions it cannot answer yet, at most about six: what to call me, what I do, the languages I use, my time zone or location, my main tools and setup, and how I like answers (short or detailed, tone). Tell me I can skip any of them. When I answer, write my profile with logbook_block_set "human", in English, merged with what is already there. Confirm in one line.`,
  },
  {
    name: "logbook-tidy",
    description: "Find duplicates and stale entries, and propose clean-ups",
    prompt: () =>
      `Tidy the logbook. Run logbook_tidy_report, read the entries it points at, and propose concrete changes: which duplicates to merge (and the merged text), which outdated entries to forget, and how to condense oversized profiles. Present the proposals as a numbered list and wait for my OK before changing anything.`,
  },
  {
    name: "logbook-export",
    description: "Export the logbook to a JSON file",
    prompt: (args) =>
      `Export the logbook with logbook_export${args.trim() ? ` to this path: ${args.trim()}` : ""}. Use scope "all" unless I said "project". Tell me where the file is.`,
  },
  {
    name: "logbook-import",
    description: "Import a logbook export file",
    prompt: (args) =>
      `Import this open-logbook export with logbook_import: ${need(args, "for the file path")}. Report what was added and skipped, and if a profile was kept because it already had content, show me both versions so I can decide how to merge them.`,
  },
]
