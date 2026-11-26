# open-logbook

A memory plugin for [OpenCode](https://opencode.ai). It keeps notes about you and about each project in Markdown files on your machine and loads the relevant parts at the start of every session, so the agent does not start from zero each time.

## Install

```bash
opencode plugin add github:cweeperde/open-logbook#main
```

Then restart OpenCode. No API key, database or configuration is needed. Because the install follows the `main` branch, OpenCode installs updates on its own.

## What it does

The logbook keeps three profiles: one about you (shared by all projects), one about the current project, and a short note on where the last session stopped. Everything else is stored as individual entries: decisions, learnings, preferences, blockers and background context.

At the start of a session, the profiles are loaded together with pinned entries, open blockers and the most recent decisions. The agent can search the rest when it needs it.

The agent updates the logbook while it works. When a long conversation is compacted, the session's model reads the compacted part once and saves what is still missing. The first time you open a project, the plugin reads the documentation files in its root (such as README.md, AGENTS.md or CLAUDE.md) to write a first project profile.

Sensitive personal information, such as health or financial details, is only saved after the agent has asked you and you agreed.

## Commands

| Command | What it does |
| --- | --- |
| `/logbook` | Shows an overview and runs a health check |
| `/logbook-add <text>` | Saves something you want remembered |
| `/logbook-search <question>` | Answers from the logbook, and from earlier sessions if needed |
| `/logbook-forget <what>` | Removes entries, after asking which ones |
| `/logbook-me` | Shows what the logbook knows about you and lets you correct it |
| `/logbook-setup` | Asks a few questions to fill in your profile |
| `/logbook-sync` | Rewrites your profile and the project profile from the current entries |
| `/logbook-incognito` | Turns the logbook off for the rest of the session; run it again to turn it back on |
| `/logbook-tidy` | Lists duplicates and stale entries and proposes clean-ups |
| `/logbook-export`, `/logbook-import` | Write the logbook to a JSON file and read it back |

None of them are needed for normal use.

<details>
<summary><b>Details</b></summary>

**Profiles and entries.** The profiles are `human` (up to 8,000 characters), `project` (6,000) and `session` (4,000). Entries have one of five types: `decision`, `learning`, `preference`, `blocker` or `context`. Each entry records when it was written and on which branch, commit, model and session.

**Session start.** Up to about 5,000 tokens are loaded. The text is built once per session and sent unchanged with each request, so the provider's prompt cache stays valid.

**Updates during a session.** When you mention something about yourself, the agent updates your profile in the same turn. At compaction, a profile is only rewritten if something in it changed. New entries from compaction are tagged `auto`.

**Expiry and archive.** Time-bound facts can have an expiry date and stop being loaded after it. Blockers that were resolved more than 30 days ago move to an archive folder.

**Earlier sessions.** If the logbook has nothing on a topic, the agent can search your earlier OpenCode sessions of the same project.

**Projects** are identified by their git remote, so the same logbook is used when the repository is in a different folder or on another machine. Without a remote, the folder path is used.

**Language.** Profiles and entries are written in English. The agent still answers in your language.

</details>

<details>
<summary><b>Privacy</b></summary>

- The logbook is stored only on your machine. Whatever is loaded into a session is sent to your model provider, like the rest of the conversation.
- Health, financial, relationship, political, religious, legal and sexuality-related information is only saved after you agree. The save tools refuse it otherwise, and the automatic save at compaction never stores it. This check works on keywords, so it can miss things or ask when it does not need to.
- Common secret formats (API keys, tokens, private keys, `password = ...`) are removed before anything is written. Text inside `<private>...</private>` is replaced with `[private]`.
- `/logbook-incognito` stops all loading, searching and saving for the rest of the session, including after a restart of OpenCode. New sessions use the logbook again.

</details>

<details>
<summary><b>Files</b></summary>

```
~/.open-logbook/
  human.md                       your profile
  entries/                       entries that apply to all projects
  projects/github.com_you_repo/
    project.md                   project profile
    session.md                   where the last session stopped
    entries/                     one Markdown file per entry
  archive/                       expired entries and old resolved blockers
  trash/                         entries removed with /logbook-forget
```

All files are plain Markdown and can be edited or deleted by hand.

</details>

<details>
<summary><b>Settings</b></summary>

Settings are optional and go into the object form of the plugin entry in your OpenCode config:

```json
{
  "plugins": [
    {
      "package": "github:cweeperde/open-logbook#main",
      "options": { "storage": "~/notes/logbook", "budget": 5000, "capture": true }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `storage` | `~/.open-logbook` | Where the files are stored. The `OPEN_LOGBOOK_DIR` environment variable does the same. |
| `budget` | `5000` | Tokens loaded at session start |
| `capture` | `true` | Whether the session's model is used at compaction and to read a new project's docs |

`OPEN_LOGBOOK_DEBUG=1` prints what the plugin does. Set it to a file path to write the log there instead.

</details>

<details>
<summary><b>Updates and versions</b></summary>

With `#main`, OpenCode checks for updates at startup and every 24 hours, installs them and reloads the plugin. If a new version fails to load, the previous one keeps running.

To stay on a fixed version, install a tag instead, for example `github:cweeperde/open-logbook#v1.0.0`, and update with `opencode plugin update`. Changes are listed on the [releases page](https://github.com/cweeperde/open-logbook/releases).

The tests run on Windows, macOS and Linux, under Node and Bun.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm install
npm test            # Node
npm run test:bun    # Bun, which OpenCode uses to run plugins
npm run typecheck
```

To release a version, set it in `package.json`, add a dated entry to `CHANGELOG.md`, merge, and push the tag `v<version>`. A workflow checks both and publishes the release.

</details>

## Disclaimer

This plugin is provided as is, without warranty of any kind (see sections 7 and 8 of the [license](LICENSE)). I am not responsible for any problems, data loss or other damage that may result from using it.

The logbook is written and read by AI models, which can make mistakes: they may save wrong or outdated information, miss things, or act on a misremembered fact. Check what is stored with `/logbook-me` and `/logbook`, and correct it when needed.

Parts of this project's code and documentation were written or assisted by AI.

## License

[Apache-2.0](LICENSE). © 2026 [cweeper](https://github.com/cweeperde). Keep the [NOTICE](NOTICE) file when redistributing.
