/**
 * Profile extractor — runs after each chat turn to mine stable preferences
 * from the (user, assistant) exchange. Spawns a fresh `claude --print`
 * with --model haiku and a strict extraction system prompt that returns
 * JSON. Fire-and-forget from the caller's POV; latency hidden behind the
 * normal turn flow.
 *
 * Failure mode: any error returns silently. Profile is best-effort —
 * nothing in the chat path depends on extraction succeeding.
 *
 * Concurrency: at most one extraction runs at a time. New turns enqueue;
 * if the queue exceeds 1 pending we drop oldest (only the most recent
 * turn matters for profile drift).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import log from "electron-log";
import {
  applyUpdates,
  bumpTurnsSeen,
  embedUnembedded,
  loadProfile,
  type Dimension,
} from "./profile-store";

const CLAUDE_BIN_CANDIDATES = [
  "/Users/richardchen/.openclaw/bin/claude",
  "/Users/richardchen/.local/bin/claude-arm64-orig",
  "/Users/richardchen/.local/bin/claude",
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
];

function findClaudeBin(): string | null {
  for (const p of CLAUDE_BIN_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const SYSTEM_PROMPT = `You are a profile extractor for a personal AI assistant called Prism.

Read the (user, assistant) exchange below and identify any STABLE facts or preferences about the USER that would help Prism behave better in future, unrelated conversations.

STRICT RULES:
- Extract only things likely to be true across many future chats. Skip ephemeral context (what the user is currently asking about, one-time tasks).
- Skip if the exchange reveals nothing notable. An empty array is the right answer most of the time.
- Each claim must be a single short sentence about the user (e.g. "Prefers terse responses" not "User said 'be brief'").
- Output JSON ONLY, no prose, no code fences.

SCHEMA:
{"updates": [
  {
    "dimension": "<one of: communication_style | role_context | tooling | naming | decision_style | project_focus | anti_patterns | knowledge>",
    "claim": "<single sentence about the user>",
    "confidence": <0.0..1.0>,
    "evidence": "<short verbatim quote from the user, max 100 chars>"
  }
]}

DIMENSION GUIDE:
- communication_style: terse vs verbose, formal vs casual, code-first vs prose-first
- role_context: what they do, who they are, their domain
- tooling: languages, frameworks, OSes, editors, services they use
- naming: how they refer to things, vocabulary, abbreviations
- decision_style: decisive vs exploratory, autonomous vs check-in
- project_focus: current projects, initiatives, recurring topics
- anti_patterns: things they have told the assistant NOT to do
- knowledge: their domain expertise or gaps

If nothing notable, output exactly: {"updates": []}`;

type Job = {
  userMessage: string;
  assistantText: string;
  turnId: string;
};

let inFlight: Job | null = null;
let queued: Job | null = null;

export function enqueueExtraction(job: Job): void {
  const profile = loadProfile();
  if (profile.learning_paused) return;
  if (!job.userMessage || !job.assistantText) return;
  if (job.userMessage.length + job.assistantText.length < 80) return;

  if (inFlight) {
    queued = job; // overwrite; only the latest matters
    return;
  }
  runJob(job);
}

function runJob(job: Job): void {
  inFlight = job;
  doExtract(job)
    .catch((e) => log.warn("[extractor] failed", e?.message ?? e))
    .finally(() => {
      inFlight = null;
      if (queued) {
        const next = queued;
        queued = null;
        runJob(next);
      }
    });
}

async function doExtract(job: Job): Promise<void> {
  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    log.info("[extractor] claude binary not found, skipping");
    return;
  }

  const HOME = process.env.HOME ?? "";
  const augmentedPath = [
    `${HOME}/.openclaw/bin`,
    `${HOME}/.local/bin`,
    `${HOME}/.npm-global/bin`,
    `${HOME}/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/opt/node/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    process.env.PATH ?? "",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":");

  // Trim long messages — extractor only needs enough signal.
  const userTrimmed = job.userMessage.slice(0, 2000);
  const assistantTrimmed = job.assistantText.slice(0, 2000);
  const prompt = `USER:\n${userTrimmed}\n\nASSISTANT:\n${assistantTrimmed}`;

  const args = [
    "--print",
    "--output-format", "json",
    "--model", "haiku",
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--append-system-prompt", SYSTEM_PROMPT,
    prompt,
  ];

  const stdout: string = await new Promise((resolve, reject) => {
    const proc = spawn(claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: HOME || undefined,
      env: { ...process.env, PATH: augmentedPath },
    });
    let buf = "";
    let errBuf = "";
    proc.stdout?.on("data", (c: Buffer) => (buf += c.toString()));
    proc.stderr?.on("data", (c: Buffer) => (errBuf += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`extractor exit ${code}: ${errBuf.slice(0, 200)}`));
      } else {
        resolve(buf);
      }
    });

    // Hard timeout — if extraction doesn't finish in 30s, give up.
    setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error("extractor timeout"));
    }, 30_000);
  });

  // claude --output-format json emits a single JSON object whose `result`
  // field contains the model's text response. We need the model's text
  // to itself be JSON.
  let outerResult: string;
  try {
    const outer = JSON.parse(stdout.trim());
    if (outer.is_error) {
      log.info("[extractor] claude reported error", outer.errors ?? outer.result);
      return;
    }
    outerResult = String(outer.result ?? "");
  } catch (e) {
    log.warn("[extractor] outer JSON parse failed", String(e).slice(0, 120));
    return;
  }

  const updates = parseExtractionResult(outerResult);
  if (updates.length === 0) {
    bumpTurnsSeen();
    return;
  }

  const stamped = updates.map((u) => ({ ...u, source_turn: job.turnId }));
  const { added, total } = applyUpdates(stamped);
  bumpTurnsSeen();
  log.info("[extractor]", JSON.stringify({ turnId: job.turnId, added, total }));

  // v0.1.23: schedule semantic-embedding compute for any unembedded
  // entries (the ones we just added, plus any pre-v0.1.23 backfill).
  // Fire-and-forget — embed failures are silent and the render path
  // falls back to lexical scoring. Stays out of the chat-turn critical
  // path because doExtract() is itself already fire-and-forget.
  embedUnembedded().catch(() => {
    /* never blocks; lexical path is fine */
  });
}

const VALID_DIMENSIONS = new Set<Dimension>([
  "communication_style",
  "role_context",
  "tooling",
  "naming",
  "decision_style",
  "project_focus",
  "anti_patterns",
  "knowledge",
]);

function parseExtractionResult(text: string): Array<{
  dimension: Dimension;
  claim: string;
  confidence: number;
  evidence?: string;
}> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON object in the response (model may have added
    // preamble despite the strict prompt).
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }

  const arr = Array.isArray(parsed?.updates) ? parsed.updates : [];
  const out: Array<{
    dimension: Dimension;
    claim: string;
    confidence: number;
    evidence?: string;
  }> = [];
  for (const u of arr) {
    if (!u || typeof u !== "object") continue;
    const dim = String(u.dimension ?? "");
    if (!VALID_DIMENSIONS.has(dim as Dimension)) continue;
    const claim = String(u.claim ?? "").trim();
    if (claim.length < 5) continue;
    const conf = Number(u.confidence ?? 0);
    if (Number.isNaN(conf)) continue;
    out.push({
      dimension: dim as Dimension,
      claim,
      confidence: conf,
      evidence: u.evidence ? String(u.evidence).slice(0, 240) : undefined,
    });
  }
  return out;
}
