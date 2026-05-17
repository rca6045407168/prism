/**
 * v0.1.46 — Redaction layer.
 *
 * Stolen from OpenClaw's hardening.json5 + pii-redaction.json5 — a
 * regex catalogue that masks secrets + PII before content lands in
 * (a) electron-log files, (b) chat history saved to localStorage,
 * (c) Obsidian vault notes written via ⌘⇧S.
 *
 * The default-deny posture: every string that goes through `redact()`
 * gets every pattern applied. False-positives are preferred over
 * leaks — a redacted email in a vault note is recoverable from
 * conversation context; a leaked Anthropic key is not.
 *
 * Inspired by OpenClaw's prior art:
 *   ~/openclaw-workspace/hardening.json5 (12 secret regexes)
 *   ~/openclaw-workspace/openclaw-pii-redaction.json5 (+ PII shapes
 *   + business-sensitive identifiers)
 *
 * Each pattern carries a token tag so the redaction is informative,
 * not just obscuring. "Found: sk-ant-key" → ⟨REDACTED:anthropic-key⟩.
 * Users can grep the chat history later for ⟨REDACTED:⟩ to find what
 * was scrubbed.
 */

type Rule = { tag: string; re: RegExp };

/** Secret-key patterns. Lifted directly from OpenClaw hardening.json5. */
const SECRET_RULES: Rule[] = [
  { tag: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { tag: "openrouter-key", re: /sk-or-[A-Za-z0-9_-]{20,}/g },
  { tag: "openai-key", re: /sk-[A-Za-z0-9]{32,}/g },
  { tag: "nvidia-nim-key", re: /nvapi-[A-Za-z0-9_-]{20,}/g },
  { tag: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { tag: "google-oauth", re: /ya29\.[A-Za-z0-9_-]+/g },
  { tag: "github-pat", re: /ghp_[A-Za-z0-9]{36}/g },
  { tag: "github-fg-pat", re: /github_pat_[A-Za-z0-9_]{82}/g },
  { tag: "slack-bot", re: /xoxb-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+/g },
  { tag: "slack-user", re: /xoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+/g },
  { tag: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** PII patterns. Lifted from OpenClaw pii-redaction.json5. */
const PII_RULES: Rule[] = [
  // Email — most aggressive; will match anything that looks like one.
  // Acceptable false-positive rate for security purposes.
  { tag: "email", re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g },
  // US phone: 555-555-5555, (555) 555-5555, 555.555.5555, 5555555555
  { tag: "us-phone", re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // SSN: 555-55-5555
  { tag: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit-card-ish 16-digit groups (Luhn not checked — false-positive prone)
  { tag: "cc-like", re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
];

/**
 * Business-sensitive identifiers — customizable per-deployment.
 * OpenClaw hardcoded "Margarita | Murashkina | Solaria Bio | Probioferm |
 * Crossfire Logistics" for the FlexHaul context. Prism keeps the same
 * config-as-code approach: edit this list when new sensitive names
 * matter. Word-boundary matches only (case-insensitive).
 *
 * The tradeoff: aggressive name-redaction makes vault notes harder to
 * read. We keep this list intentionally small. A future v0.1.x might
 * make it user-configurable via a Settings input.
 */
const BUSINESS_RULES: Rule[] = [
  // Customers / prospects whose names should not appear in any
  // long-lived log or vault export.
  {
    tag: "biz-id",
    re: /\b(Margarita\s+Murashkina|Solaria\s+Bio|Probioferm|Crossfire\s+Logistics|Wakool|Wolflink)\b/gi,
  },
];

const ALL_RULES: Rule[] = [...SECRET_RULES, ...PII_RULES, ...BUSINESS_RULES];

/**
 * Apply every rule to `text`. Returns the redacted string + a count of
 * substitutions per tag (useful for telemetry: "this turn redacted 3
 * emails and 1 anthropic-key" without revealing what was redacted).
 */
export function redact(text: string): {
  text: string;
  counts: Record<string, number>;
} {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", counts: {} };
  }
  let out = text;
  const counts: Record<string, number> = {};
  for (const { tag, re } of ALL_RULES) {
    let n = 0;
    out = out.replace(re, () => {
      n += 1;
      return `⟨REDACTED:${tag}⟩`;
    });
    if (n > 0) counts[tag] = n;
  }
  return { text: out, counts };
}

/**
 * Convenience: just the string output, drop the counts. For places
 * where the caller doesn't need telemetry.
 */
export function redactString(text: string): string {
  return redact(text).text;
}

/**
 * Recursively redact a JSON-serializable object's string leaves.
 * Used for log payloads (claude-init event, tool inputs, etc.) where
 * we want to scrub anywhere a secret might be embedded without
 * having to enumerate every field shape.
 *
 * Non-string leaves pass through unchanged. Arrays + objects recursed.
 * Cycle detection NOT included — assumes JSON-compatible input.
 */
export function redactDeep<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
