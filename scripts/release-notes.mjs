// Release notes from CHANGELOG.md, with the checks a release needs.
//
//   node scripts/release-notes.mjs --tag v0.2.0   print the notes for that tag;
//                                                 fail if the tag, package.json and
//                                                 the newest dated entry disagree
//   node scripts/release-notes.mjs --check        CI: package.json version must have
//                                                 a CHANGELOG entry (dated or "unreleased")

import { readFileSync } from "node:fs"

const root = new URL("..", import.meta.url)
const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version
const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8").replace(/\r\n/g, "\n")

function entry(v) {
  const escaped = v.replace(/\./g, "\\.")
  const m = new RegExp(`^## ${escaped} - (.+)\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(changelog)
  return m ? { date: m[1].trim(), body: m[2].trim() } : undefined
}

function fail(message) {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
if (args[0] === "--check") {
  if (!entry(version)) fail(`CHANGELOG.md has no "## ${version} - <date>" entry for the version in package.json`)
  console.error(`release-notes: CHANGELOG entry for ${version} found`)
} else if (args[0] === "--tag" && args[1]) {
  const tag = args[1]
  if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version}`)
  const e = entry(version)
  if (!e) fail(`CHANGELOG.md has no entry for ${version}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) fail(`CHANGELOG entry ${version} is dated "${e.date}"; set the release date before tagging`)
  process.stdout.write(
    `${e.body}\n\n## Install\n\n\`\`\`\nopencode plugin add github:cweeperde/open-logbook#main\n\`\`\`\n\n` +
      `OpenCode keeps an install from \`#main\` up to date by itself. To stay on this version instead, use \`github:cweeperde/open-logbook#${tag}\`.\n`,
  )
} else {
  fail("usage: release-notes.mjs --tag v<x.y.z> | --check")
}
