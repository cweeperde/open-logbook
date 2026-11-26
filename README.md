# open-logbook

**Long-term memory for [OpenCode](https://opencode.ai).** Your agent remembers who you are, how you like to work, and what happened in each project, across every session. Everything stays on your machine as plain Markdown files.

## Install

```bash
opencode plugin add github:cweeperde/open-logbook#main
```

Restart OpenCode. That's it: no API key, no database, nothing to configure. Updates install themselves.

## What you get

- **It knows you.** Your name, work, tools, preferences and plans are kept in a profile that every session starts with. Sensitive things like health or finances are only kept if you say yes when asked.
- **It knows your project.** The first time you open a project, it reads the docs in its root (README, AGENTS.md, CLAUDE.md and the like) and writes a project profile. Decisions, gotchas and open problems are added as you work.
- **It fills itself, quietly.** The agent saves as things come up, with at most a short "Updating logbook". When a long conversation gets compacted, anything still missing is saved too.
- **You stay in control.** See and correct what it knows with `/logbook-me`, go incognito for a session, and edit any file in `~/.open-logbook/` by hand.

## Commands

| Command | |
| --- | --- |
| `/logbook` | Overview and health check |
| `/logbook-add <text>` | Remember something |
| `/logbook-search <question>` | Ask what the logbook knows (also looks through earlier sessions) |
| `/logbook-forget <what>` | Remove something (asks first) |
| `/logbook-me` | Show what it knows about you, and correct it |
| `/logbook-setup` | A few quick questions so it gets to know you |
| `/logbook-sync` | Refresh your profile and the project profile now |
| `/logbook-incognito` | Logbook off for the rest of this session (run again to turn it back on) |
| `/logbook-tidy` | Find duplicates and stale entries |
| `/logbook-export`, `/logbook-import` | Move your logbook to another machine |

You don't need any of them for normal use.

<details>
<summary><b>How it works</b></summary>

The logbook holds three profiles, `human` (you, across all projects), `project` (this codebase) and `session` (where work stopped), plus entries of five types: `decision`, `learning`, `preference`, `blocker`, `context`.

Every session starts with the profiles, pinned entries, open blockers and the five newest decisions, up to about 5,000 tokens. The rest is one search away. This text is built once per session and sent unchanged, so your provider's prompt cache keeps working.

The logbook grows in three ways:

1. The agent saves as it works. When you mention something about yourself, it updates your profile right away.
2. When OpenCode compacts a long conversation, the session's own model reads the compacted part once in the background, saves facts that are still missing (tagged `auto`), updates a profile only if something about you or the project actually changed, and writes a fresh `session` note.
3. On first contact with a project, its root documentation files are read once to draft the project profile. Only text and Markdown files at the top level are read: no code, no subfolders.

Time-bound facts ("on holiday until 3 December") get an expiry date and drop out after it. Blockers resolved more than 30 days ago move to an archive. If the logbook has nothing on a topic, the agent can search your earlier OpenCode sessions of the same project.

Projects are recognised by their git remote, so the same logbook follows a repo to another folder or machine. Without a remote, the folder path is used.

</details>

<details>
<summary><b>Privacy</b></summary>

- The logbook never leaves your machine on its own. What is loaded into a session goes to your model provider like any other context.
- Sensitive personal information (health, finances, relationships, political or religious views, legal matters, sexuality) is never saved without asking. The save tools refuse it until you agree, and automatic capture never stores it.
- Recognisable secrets (common API keys and tokens, private keys, `password = ...`) are removed before anything is written. Text inside `<private>...</private>` is replaced with `[private]`.
- `/logbook-incognito` turns the logbook off for the rest of a session: nothing is loaded, searched or saved. It stays off even if OpenCode restarts; a new session starts normally.

</details>

<details>
<summary><b>Where your data lives</b></summary>

```
~/.open-logbook/
  human.md                       your profile
  entries/                       entries for every project
  projects/github.com_you_repo/
    project.md                   the project profile
    session.md                   where the last work stopped
    entries/                     one Markdown file per entry
  archive/                       expired facts and old resolved blockers
  trash/                         forgotten entries, restorable
```

Profiles and entries are written in English, whatever language you work in; the agent still answers in yours. Each entry records when it was written and on which branch, commit, model and session.

Profile sizes: you 8,000 characters, the project 6,000, the session note 4,000.

</details>

<details>
<summary><b>Settings</b></summary>

All optional, using the object form of the plugin entry in your OpenCode config:

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

| Option | Default | |
| --- | --- | --- |
| `storage` | `~/.open-logbook` | Where the logbook lives (or set `OPEN_LOGBOOK_DIR`) |
| `budget` | `5000` | Tokens loaded at session start |
| `capture` | `true` | Use the session's model to keep the logbook current at compaction and to read a new project's docs |

Set `OPEN_LOGBOOK_DEBUG=1` (or a file path) to see what the plugin does.

</details>

<details>
<summary><b>Updates and versions</b></summary>

Installing from `#main` means OpenCode checks for updates at startup and every 24 hours, installs them and reloads the plugin. If a new version fails to load, the previous one keeps running.

To stay on one version instead, install its tag, e.g. `github:cweeperde/open-logbook#v1.0.0`, and update with `opencode plugin update` when you want. Changes are listed on the [releases page](https://github.com/cweeperde/open-logbook/releases).

Tested on Windows, macOS and Linux, under Node and Bun.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm install
npm test            # Node
npm run test:bun    # Bun, as OpenCode runs it
npm run typecheck
```

To release: set the version in `package.json`, add a dated entry to `CHANGELOG.md`, merge, and push the tag `v<version>`. A workflow checks both and publishes the release.

</details>

## License

[Apache-2.0](LICENSE) · © 2026 [cweeper](https://github.com/cweeperde) · keep the [NOTICE](NOTICE) file when redistributing.
