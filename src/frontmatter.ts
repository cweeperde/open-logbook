// A deliberately small frontmatter format: one `key: value` per line between
// `---` fences. Values that would be ambiguous as plain text (numbers, booleans,
// lists, text with leading spaces or newlines) are written as JSON, so files
// round-trip exactly and stay easy to edit by hand.

export type Fields = Record<string, unknown>

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export function parse(text: string): { fields: Fields; body: string } {
  const match = FENCE.exec(text)
  if (!match) return { fields: {}, body: text }
  const fields: Fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    fields[line.slice(0, colon).trim()] = parseValue(line.slice(colon + 1).trim())
  }
  return { fields, body: text.slice(match[0].length).replace(/^\r?\n/, "") }
}

export function parseValue(raw: string): unknown {
  if (raw === "") return ""
  if (/^(true|false|null)$/.test(raw) || /^-?\d+(\.\d+)?$/.test(raw) || /^["[{]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      // fall through: hand-written lists like [a, b] are not JSON
    }
  }
  const list = /^\[(.*)\]$/.exec(raw)
  if (list) {
    return list[1]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }
  return raw
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const plain = value.trim() === value && !/[\r\n]/.test(value) && parseValue(value) === value
    return plain ? value : JSON.stringify(value)
  }
  return JSON.stringify(value)
}

export function stringify(fields: Fields, body: string): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
  const text = body.replace(/\s+$/, "")
  return `---\n${lines.join("\n")}\n---\n${text ? `\n${text}\n` : ""}`
}
