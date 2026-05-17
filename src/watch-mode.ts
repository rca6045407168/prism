/**
 * v0.1.53 — Watch mode (calibrated escalation).
 *
 * A fourth permission mode. The pitch: senior employees don't ask
 * permission for every task — they JUST DO things, EXCEPT when the
 * task has irreversible / high-blast-radius / cross-boundary
 * characteristics. Then they pause and confirm.
 *
 * "Watch" mode replicates that: a Bypass turn that does a 5ms regex
 * preflight on the user message. Most messages pass straight through
 * (Bypass-fast). The ones that match a trigger pause and surface a
 * banner: "I noticed X — want to proceed, or downgrade to Ask?"
 *
 * Pure renderer-side. The IPC layer never sees "watch" — we either
 * forward as "bypass" (clean) or pause inline and let the user pick
 * "Proceed" (→ bypass) or "Switch to Ask" (→ ask).
 *
 * Triggers (in order of severity):
 *   1. Filesystem destruction — rm -rf, drop table, git reset --hard,
 *      force-push, delete branch, rmdir, mkfs, dd.
 *   2. External egress — send / email / post / publish / push.
 *   3. Money — $ + digit, "wire", "transfer N USD", "buy", "sell".
 *   4. Named counterparties — Richard's known business contacts +
 *      employer brands surfaced from memory.
 *   5. Production indicators — "prod", "production", "main", "master".
 *
 * Each trigger adds severity points. Level thresholds:
 *   - 0 = ok (no pause)
 *   - 1-2 = caution (pause; user re-confirms)
 *   - 3+ = high (pause + emphasized banner)
 *
 * Out of scope for v0.1.53: ML-based scoring, per-trigger user
 * overrides, learning from past Proceed/Switch decisions. Keep the
 * heuristics legible — that's the whole point.
 */

export type WatchTrigger = {
  category:
    | "destructive"
    | "egress"
    | "money"
    | "counterparty"
    | "production";
  severity: number; // 1-3
  match: string; // the matching text snippet
  why: string; // human-readable reason
};

export type WatchEvaluation = {
  level: "ok" | "caution" | "high";
  totalSeverity: number;
  triggers: WatchTrigger[];
};

// Hard destructive patterns — irreversible without a backup.
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string; severity: number }> =
  [
    {
      re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf)\b/i,
      why: "rm -rf invocation — irreversible file deletion",
      severity: 3,
    },
    {
      re: /\bdrop\s+(table|database|schema|index)\b/i,
      why: "SQL DROP — schema destruction",
      severity: 3,
    },
    {
      re: /\bgit\s+reset\s+--hard\b/i,
      why: "git reset --hard — discards uncommitted work",
      severity: 3,
    },
    {
      re: /\bgit\s+push\s+(--force|-f)\b/i,
      why: "force-push — overwrites remote history",
      severity: 3,
    },
    {
      re: /\b(rmdir|rd)\s+\/s\b/i,
      why: "rmdir /s — recursive directory removal",
      severity: 3,
    },
    {
      re: /\b(mkfs|format|dd\s+if=)/i,
      why: "filesystem format / dd — wipes disks",
      severity: 3,
    },
    {
      re: /\bgit\s+branch\s+-D\b/i,
      why: "git branch -D — force-delete branch",
      severity: 2,
    },
    {
      re: /\btruncate\s+(table)?\b/i,
      why: "TRUNCATE — wipes table rows",
      severity: 2,
    },
    {
      re: /\bdelete\s+from\b/i,
      why: "DELETE FROM — destructive SQL",
      severity: 2,
    },
    {
      re: /\bunlink\b/i,
      why: "unlink — removes a file",
      severity: 1,
    },
  ];

const EGRESS_PATTERNS: Array<{ re: RegExp; why: string; severity: number }> = [
  {
    re: /\b(send|email|reply\s+to)\b[^.\n]{0,40}\b(to|@)\b/i,
    why: "outbound mail — once sent, not retractable",
    severity: 2,
  },
  {
    re: /\b(post|publish|broadcast)\b/i,
    why: "public publishing — visible to others",
    severity: 1,
  },
  {
    re: /\bgit\s+push\b/i,
    why: "git push — broadcasts to remote",
    severity: 1,
  },
  {
    re: /\b(deploy|ship)\s+(to|prod|production)\b/i,
    why: "deployment — affects live system",
    severity: 2,
  },
];

const MONEY_PATTERNS: Array<{ re: RegExp; why: string; severity: number }> = [
  {
    re: /\$\s?\d/,
    why: "dollar amount mentioned — review before action",
    severity: 1,
  },
  {
    re: /\b\d{2,}\s?(USD|EUR|GBP|JPY|CAD)\b/i,
    why: "explicit currency amount",
    severity: 1,
  },
  {
    re: /\b(wire|transfer|pay|purchase|buy|sell)\b[^.\n]{0,30}\$?\d/i,
    why: "money-movement verb adjacent to a number",
    severity: 2,
  },
  {
    re: /\b(invoice|payment|refund)\b/i,
    why: "financial document mentioned",
    severity: 1,
  },
];

// Richard's known counterparties (from MEMORY.md + project context).
// These names surfacing in a Bypass turn is a signal to pause —
// they're the people who care if Prism gets it wrong.
const COUNTERPARTY_NAMES = [
  "xinwen",
  "tyson",
  "ryan",
  "tammy",
  "caitlin",
  "plume",
  "also",
  "iterative ventures",
  "flexhaul",
  "saia",
  "estes",
  "arcbest",
  "odfl",
  "tql",
  "loadsmart",
  "mercury",
  "stripe",
];

const PRODUCTION_PATTERNS: Array<{ re: RegExp; why: string; severity: number }> =
  [
    {
      re: /\b(prod|production|live)\b/i,
      why: "production environment referenced",
      severity: 2,
    },
    {
      re: /\b(main|master)\b/i,
      why: "main/master branch — protected by team policy",
      severity: 1,
    },
    {
      re: /\b(deploy|rollout|release)\b/i,
      why: "deployment verb",
      severity: 1,
    },
  ];

function scanPatterns(
  text: string,
  patterns: Array<{ re: RegExp; why: string; severity: number }>,
  category: WatchTrigger["category"],
): WatchTrigger[] {
  const out: WatchTrigger[] = [];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      out.push({
        category,
        severity: p.severity,
        match: m[0],
        why: p.why,
      });
    }
  }
  return out;
}

function scanCounterparties(text: string): WatchTrigger[] {
  const out: WatchTrigger[] = [];
  const lower = text.toLowerCase();
  for (const name of COUNTERPARTY_NAMES) {
    const re = new RegExp(`\\b${name}\\b`, "i");
    const m = lower.match(re);
    if (m) {
      out.push({
        category: "counterparty",
        severity: 1,
        match: m[0],
        why: `Named counterparty "${name}" — extra-deliberate territory.`,
      });
    }
  }
  return out;
}

export function evaluateRisk(text: string): WatchEvaluation {
  const triggers: WatchTrigger[] = [
    ...scanPatterns(text, DESTRUCTIVE_PATTERNS, "destructive"),
    ...scanPatterns(text, EGRESS_PATTERNS, "egress"),
    ...scanPatterns(text, MONEY_PATTERNS, "money"),
    ...scanCounterparties(text),
    ...scanPatterns(text, PRODUCTION_PATTERNS, "production"),
  ];
  // Dedupe by (category, match) — counterparty + destructive shouldn't both
  // hit on the same word.
  const seen = new Set<string>();
  const deduped: WatchTrigger[] = [];
  for (const t of triggers) {
    const k = `${t.category}::${t.match.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(t);
  }
  const totalSeverity = deduped.reduce((s, t) => s + t.severity, 0);
  let level: WatchEvaluation["level"] = "ok";
  if (totalSeverity >= 3) level = "high";
  else if (totalSeverity >= 1) level = "caution";
  return { level, totalSeverity, triggers: deduped };
}
