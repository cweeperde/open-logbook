// Best-effort secret removal before anything is written to the logbook.
// It recognises common token formats, not arbitrary passwords; <private> tags
// cover the rest.

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[redacted github token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted github token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted gitlab token]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[redacted anthropic key]"],
  [/\bsk-(?:proj-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,}/g, "[redacted api key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted aws key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted slack token]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted google key]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted npm token]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, "$1 [redacted]"],
  [
    /\b((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|client[_-]?secret|auth)\s*[:=]\s*)(["']?)[^\s"',;]{8,}\2/gi,
    "$1$2[redacted]$2",
  ],
]

export function redact(text: string): { text: string; count: number } {
  let count = 0
  let out = text.replace(/<private>[\s\S]*?<\/private>/gi, () => {
    count++
    return "[private]"
  })
  const open = out.search(/<private>/i)
  if (open !== -1) {
    // An unclosed tag hides everything after it rather than leaking it.
    out = `${out.slice(0, open)}[private]`
    count++
  }
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, (...args) => {
      count++
      return replacement.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? "")
    })
  }
  return { text: out, count }
}
