# Changelog

## 1.0.0 - 2026-11-26

First release.

- Profiles loaded at every session start: `human` (the user, up to 8,000 characters), `project` (up to 6,000) and `session` (where work stopped, up to 4,000), plus pinned entries, open blockers and recent decisions, up to about 5,000 tokens. Built once per session so the prompt cache holds.
- Remembers personal facts about the user as well as project knowledge, in English, and saves quietly. Sensitive personal information is only saved after the user agrees; the save tools enforce it, and automatic capture never stores it.
- Entries of type decision, learning, preference, blocker and context, one Markdown file each, with pinning, blocker status, expiry dates and provenance. Expired facts and blockers resolved over 30 days ago are archived.
- Keeps itself current: at compaction the session's model saves missing facts, updates a profile only when something changed, and writes the session note. On first contact with a project, its root docs are read once to draft the project profile.
- Commands, all starting with `/logbook`: overview, add, search, forget, me, setup, sync, incognito, tidy, export, import.
- Incognito mode per session: nothing loaded, searched or saved; survives restarts.
- Searches earlier OpenCode sessions of the project when the logbook has nothing on a topic.
- Secrets and `<private>` text are removed before anything is written; health check in `/logbook`.
- Works on Windows, macOS and Linux, under Node and Bun.
