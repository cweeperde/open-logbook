// A guard for sensitive personal information. Models do not reliably ask
// before saving things like a diagnosis, so the save tools check for it and
// refuse until the user has agreed. Logbook text is written in English, so the
// terms are English. This is a safety net, not a classifier: it errs on the
// side of asking.

const CATEGORIES: Record<string, RegExp> = {
  health:
    /\b(diabet\w*|cancer|tumou?r|depress\w*|anxiety|adhd|autis\w*|bipolar|schizo\w*|ptsd|eating disorder|anorexi\w*|bulimi\w*|pregnan\w*|miscarriage|illness|disease|chronic|diagnos\w*|medication|prescri\w*|therap(y|ist)|psychiatr\w*|disabilit\w*|disabled|hiv|aids|epilep\w*|migraine|surgery|addict\w*|rehab|suicid\w*|self[- ]harm|mental health|insulin)\b/i,
  finances: /\b(salary|income|debt|loan|mortgage|bankrupt\w*|net worth|credit score|savings of|in debt|unemploy\w*|welfare|benefits claim)\b/i,
  relationships: /\b(divorc\w*|break[- ]?up|separated from|affair|dating|girlfriend|boyfriend|custody)\b/i,
  politics: /\b(votes? for|voted for|party member|political views?|politically|left[- ]wing|right[- ]wing)\b/i,
  religion: /\b(religio\w*|christian|muslim|jewish|hindu|buddhist|atheist|church|mosque|synagogue|faith)\b/i,
  legal: /\b(lawsuit|sued|arrest\w*|convict\w*|criminal record|on probation|court case|prison|jail)\b/i,
  sexuality: /\b(gay|lesbian|bisexual|queer|transgender|sexual orientation|asexual|non[- ]binary)\b/i,
}

/** Sensitive categories found in a text. */
export function sensitiveCategories(text: string): string[] {
  return Object.entries(CATEGORIES)
    .filter(([, rx]) => rx.test(text))
    .map(([name]) => name)
}

/** Categories present in `next` that `previous` did not already contain. */
export function newSensitiveCategories(previous: string, next: string): string[] {
  const before = new Set(sensitiveCategories(previous))
  return sensitiveCategories(next).filter((c) => !before.has(c))
}

export function consentMessage(categories: string[]): string {
  return `Not saved: this looks like sensitive personal information (${categories.join(", ")}). Ask the user in one short question whether you may remember it, e.g. "May I remember that? It stays on your machine." If they agree, call this tool again with consent: true. If they decline, save the rest without the sensitive part and do not ask again.`
}
