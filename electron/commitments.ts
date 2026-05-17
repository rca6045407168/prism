/**
 * v0.1.54 — Commitment tracking.
 *
 * Senior employees remember "I told Xinwen Friday." Prism today
 * doesn't. After every assistant turn we mine the response for
 * first-person commitments ("I will…", "I'll…", "I'm going to…")
 * + an optional deadline, persist them to a vault `Commitments/`
 * folder, and surface a pill under the assistant message.
 *
 * Outcomes close the loop: each commitment can be marked resolved
 * with a free-text outcome that writes back to the same vault note.
 * A future "show your work" surface will read outcomes from
 * similar-past-commitments and let the agent learn from its own
 * track record.
 *
 * Mining is regex-based, deliberately conservative. We'd rather
 * miss a commitment than fabricate one. False-positives confuse
 * the trail; false-negatives just mean the user can flag it later.
 *
 * Out of scope for v0.1.54:
 *  - LLM-based extraction (regex is plenty)
 *  - Auto-reminders / notifications
 *  - Inferring deadlines from context
 *  - Multi-language matching (English only)
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ipcMain } from "electron";
import log from "electron-log";
import { getVaultRoot } from "./vault-config";

// v0.1.61: vault root now comes from shared config (Settings picker).
// Read lazily so a Settings change at runtime takes effect.
function vaultRoot(): string {
  return getVaultRoot();
}
function commitmentsDir(): string {
  return path.join(vaultRoot(), "Commitments");
}

export type Commitment = {
  id: string;
  text: string; // the matching sentence
  verb: string; // the committed action
  deadline?: string; // raw deadline text (e.g. "by Friday", "by 2026-05-20")
  deadlineIso?: string; // best-effort ISO date
  counterparty?: string; // named person/org if detected
  capturedAt: number;
  chatId?: string;
  turnId?: string;
  resolved?: boolean;
  outcome?: string;
  resolvedAt?: number;
  vaultRelPath?: string;
};

const COMMIT_VERBS = [
  "ship",
  "deploy",
  "send",
  "write",
  "draft",
  "build",
  "wire",
  "fix",
  "test",
  "review",
  "follow up",
  "follow-up",
  "call",
  "email",
  "check",
  "verify",
  "merge",
  "release",
  "investigate",
  "research",
  "schedule",
  "book",
  "publish",
  "post",
  "land",
  "deliver",
  "set up",
  "configure",
  "deploy",
];

const COUNTERPARTY_HINTS = [
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

function ensureDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    log.warn("[commitments] mkdir failed", String(e).slice(0, 200));
    return false;
  }
}

function findDeadline(sentence: string): { raw?: string; iso?: string } {
  // "by Friday" / "by tomorrow" / "by EOD" / "by 2026-05-20" / "next week"
  const m = sentence.match(
    /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|eod|end of day|end of week|eow|noon|next week|next month|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
  );
  if (m) {
    const raw = m[0];
    const target = m[1].toLowerCase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const days = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    if (days.includes(target)) {
      const targetDow = days.indexOf(target);
      const diff = (targetDow - dayOfWeek + 7) % 7 || 7;
      const d = new Date(today);
      d.setDate(d.getDate() + diff);
      return { raw, iso: d.toISOString().slice(0, 10) };
    }
    if (target === "today" || target === "tonight" || target === "eod" || target === "end of day") {
      return { raw, iso: today.toISOString().slice(0, 10) };
    }
    if (target === "tomorrow") {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return { raw, iso: d.toISOString().slice(0, 10) };
    }
    if (target === "next week" || target === "eow" || target === "end of week") {
      const d = new Date(today);
      const diff = (5 - dayOfWeek + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return { raw, iso: d.toISOString().slice(0, 10) };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      return { raw, iso: target };
    }
    return { raw };
  }
  return {};
}

// v0.1.63: words that look capitalized but aren't person/counterparty names.
// "send to Documents", "ask Settings" etc. should NOT register a counterparty.
const COUNTERPARTY_STOPWORDS = new Set([
  "documents",
  "downloads",
  "settings",
  "library",
  "applications",
  "desktop",
  "obsidian",
  "vault",
  "github",
  "gmail",
  "slack",
  "drive",
  "calendar",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "tomorrow",
  "today",
  "tonight",
  "everyone",
  "anyone",
  "someone",
  "no",
  "yes",
  "true",
  "false",
]);

function findCounterparty(sentence: string): string | undefined {
  const lower = sentence.toLowerCase();
  for (const name of COUNTERPARTY_HINTS) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return name;
  }
  // v0.1.63: generic "tell X" / "ask X" / "send to X" — tightened.
  // Require capitalized word that ISN'T a system noun / day / common
  // word. Also reject ALL-CAPS (likely an acronym, not a person).
  const generic = sentence.match(
    /\b(?:tell|ask|email|send to|notify|loop in|let know)\s+([A-Z][a-z]{2,})\b/,
  );
  if (generic) {
    const candidate = generic[1];
    const lc = candidate.toLowerCase();
    if (COUNTERPARTY_STOPWORDS.has(lc)) return undefined;
    if (candidate === candidate.toUpperCase()) return undefined;
    return candidate;
  }
  return undefined;
}

function extractFromSentence(
  sentence: string,
): Pick<Commitment, "text" | "verb" | "deadline" | "deadlineIso" | "counterparty"> | null {
  // Match "I will [adverb]? <verb>" / "I'll <verb>" / "I'm going to <verb>"
  // Verb must be from our allowlist to keep precision high.
  const verbAlt = COMMIT_VERBS.map((v) => v.replace(/\s+/g, "\\s+")).join("|");
  const re = new RegExp(
    `\\bI\\s*('?ll|\\s*will|\\s*shall|'?m\\s+going\\s+to|\\s*commit\\s+to|\\s*plan\\s+to)\\s+([a-z]+\\s+)?(${verbAlt})\\b`,
    "i",
  );
  const m = sentence.match(re);
  if (!m) return null;
  const verb = m[3].toLowerCase();
  const { raw: deadline, iso: deadlineIso } = findDeadline(sentence);
  const counterparty = findCounterparty(sentence);
  return {
    text: sentence.trim(),
    verb,
    deadline,
    deadlineIso,
    counterparty,
  };
}

// v0.1.56: segment splitter that handles
//   - normal sentence boundaries (. ! ?)
//   - markdown list items (- foo / * foo / 1. foo)
//   - newlines
// Bullets + numbers strip their leader so "- I will ship" → "I will ship".
function segmentForCommitments(text: string): string[] {
  const lines = text.split(/\n+/);
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^(?:[-*+•]|\d+[.)])\s+/, "");
    // Now split this (de-leadered) line by sentence punctuation.
    const sentences = line.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function extractCommitments(text: string): Commitment[] {
  if (!text) return [];
  const sentences = segmentForCommitments(text);
  const out: Commitment[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    if (s.length > 400 || s.length < 6) continue;
    const partial = extractFromSentence(s);
    if (!partial) continue;
    // v0.1.56: include text-prefix in dedupe key so two genuinely-different
    // commitments with the same verb ("I will ship X" vs "I will ship Y")
    // don't collapse.
    const textKey = partial.text.toLowerCase().slice(0, 60);
    const key =
      partial.verb +
      "|" +
      (partial.deadlineIso ?? "") +
      "|" +
      (partial.counterparty ?? "") +
      "|" +
      textKey;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `c_${Date.now()}_${out.length}_${Math.random().toString(36).slice(2, 8)}`,
      ...partial,
      capturedAt: Date.now(),
    });
  }
  return out;
}

function commitmentFilename(c: Commitment): string {
  const d = new Date(c.capturedAt);
  const dateStr = d.toISOString().slice(0, 10);
  const verbSafe = c.verb.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${dateStr}_${verbSafe}_${c.id.slice(2, 10)}.md`;
}

function commitmentToMarkdown(c: Commitment): string {
  const lines = [
    "---",
    `id: ${c.id}`,
    `captured_at: ${new Date(c.capturedAt).toISOString()}`,
    `verb: ${c.verb}`,
  ];
  if (c.deadline) lines.push(`deadline_raw: "${c.deadline}"`);
  if (c.deadlineIso) lines.push(`deadline: ${c.deadlineIso}`);
  if (c.counterparty) lines.push(`counterparty: ${c.counterparty}`);
  if (c.chatId) lines.push(`chat_id: ${c.chatId}`);
  if (c.turnId) lines.push(`turn_id: ${c.turnId}`);
  lines.push(`resolved: ${c.resolved ? "true" : "false"}`);
  if (c.resolved && c.resolvedAt) {
    lines.push(`resolved_at: ${new Date(c.resolvedAt).toISOString()}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${c.verb}${c.deadline ? ` (${c.deadline})` : ""}`);
  lines.push("");
  lines.push("**Commitment captured from Prism turn:**");
  lines.push("");
  lines.push(`> ${c.text}`);
  if (c.outcome) {
    lines.push("");
    lines.push("## Outcome");
    lines.push("");
    lines.push(c.outcome);
  }
  return lines.join("\n") + "\n";
}

function persistCommitment(c: Commitment): { ok: true; absPath: string; relPath: string } | { ok: false; error: string } {
  if (!fs.existsSync(vaultRoot())) {
    return { ok: false, error: "Vault not found" };
  }
  if (!ensureDir(commitmentsDir())) {
    return { ok: false, error: "Could not create Commitments/ directory" };
  }
  const fname = commitmentFilename(c);
  const absPath = path.join(commitmentsDir(), fname);
  try {
    fs.writeFileSync(absPath, commitmentToMarkdown(c), "utf8");
    return { ok: true, absPath, relPath: path.join("Commitments", fname) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function readCommitmentFile(absPath: string): Commitment | null {
  try {
    const text = fs.readFileSync(absPath, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm.id || !fm.verb) return null;
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    const blockquote = body.match(/^>\s*(.+)$/m);
    const outcomeMatch = body.match(/##\s+Outcome\n+([\s\S]*?)(?:\n##|$)/);
    return {
      id: fm.id,
      text: blockquote?.[1].trim() ?? "",
      verb: fm.verb,
      deadline: fm.deadline_raw || undefined,
      deadlineIso: fm.deadline || undefined,
      counterparty: fm.counterparty || undefined,
      chatId: fm.chat_id || undefined,
      turnId: fm.turn_id || undefined,
      capturedAt: fm.captured_at ? new Date(fm.captured_at).getTime() : 0,
      resolved: fm.resolved === "true",
      outcome: outcomeMatch?.[1].trim() || undefined,
      resolvedAt: fm.resolved_at ? new Date(fm.resolved_at).getTime() : undefined,
      vaultRelPath: path.relative(vaultRoot(), absPath),
    };
  } catch {
    return null;
  }
}

function listCommitments(): Commitment[] {
  if (!fs.existsSync(commitmentsDir())) return [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(commitmentsDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Commitment[] = [];
  for (const f of files) {
    const c = readCommitmentFile(path.join(commitmentsDir(), f));
    if (c) out.push(c);
  }
  out.sort((a, b) => b.capturedAt - a.capturedAt);
  return out;
}

function findCommitmentFile(id: string): string | null {
  if (!fs.existsSync(commitmentsDir())) return null;
  let files: string[] = [];
  try {
    files = fs.readdirSync(commitmentsDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  for (const f of files) {
    const abs = path.join(commitmentsDir(), f);
    try {
      const text = fs.readFileSync(abs, "utf8");
      if (text.includes(`id: ${id}`)) return abs;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveCommitment(
  id: string,
  outcome: string,
): { ok: true; commitment: Commitment } | { ok: false; error: string } {
  const file = findCommitmentFile(id);
  if (!file) return { ok: false, error: "Commitment not found" };
  const existing = readCommitmentFile(file);
  if (!existing) return { ok: false, error: "Could not parse existing commitment" };
  const updated: Commitment = {
    ...existing,
    resolved: true,
    outcome,
    resolvedAt: Date.now(),
  };
  try {
    fs.writeFileSync(file, commitmentToMarkdown(updated), "utf8");
    return { ok: true, commitment: updated };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function registerCommitments() {
  ipcMain.handle(
    "prism:commitments:extract",
    (
      _e,
      params: { text: string; chatId?: string; turnId?: string },
    ): Commitment[] => {
      const found = extractCommitments(params.text);
      return found.map((c) => ({
        ...c,
        chatId: params.chatId,
        turnId: params.turnId,
      }));
    },
  );

  ipcMain.handle(
    "prism:commitments:persist",
    (_e, c: Commitment) => persistCommitment(c),
  );

  ipcMain.handle("prism:commitments:list", () => listCommitments());

  ipcMain.handle(
    "prism:commitments:resolve",
    (_e, params: { id: string; outcome: string }) =>
      resolveCommitment(params.id, params.outcome),
  );
}
