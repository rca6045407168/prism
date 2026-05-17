/**
 * Auto-profile store — Prism's local-only memory of the user.
 *
 * Inspired by FlexHaul's behavioral-profile dimensions, stripped to a
 * shape that makes sense for a horizontal chat product. Stored as JSON
 * at <userData>/profile.json. Never leaves the device except as part of
 * the user's own prompts to Claude (where it's injected as a system
 * prompt prefix to bias responses toward learned preferences).
 *
 * UX contract: silent by default. The user can open Settings → Memory
 * to inspect / forget any entry, pause learning, or wipe the whole
 * profile. Listing the file in <userData> means it's user-inspectable.
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import log from "electron-log";

export type Dimension =
  | "communication_style"   // terse vs verbose, code-first vs explanation-first
  | "role_context"          // what they do / who they are
  | "tooling"               // languages, frameworks, OS, editors they use
  | "naming"                // how they refer to things, vocabulary
  | "decision_style"        // decisive vs exploratory, autonomous vs check-in
  | "project_focus"         // current projects + initiatives
  | "anti_patterns"         // things they've told Prism NOT to do
  | "knowledge";            // domain expertise, gaps

export type ProfileEntry = {
  id: string;
  dimension: Dimension;
  claim: string;            // single-sentence preference / fact
  confidence: number;       // 0..1
  evidence?: string;        // short quote from user, optional
  source_turn?: string;     // turnId that created this entry
  added_at: string;         // ISO
  /** L2-normalized 384-dim MiniLM embedding of `claim + " " + evidence`.
   *  Computed in background by `embedUnembedded()` after the entry lands;
   *  used by `renderForInjection()` for semantic relevance ranking. Absent
   *  means "not yet computed" or "embed failed" — callers fall back to
   *  lexical scoring. v0.1.23. */
  embedding?: number[];
};

export type Profile = {
  version: 1;
  learning_paused: boolean;
  entries: ProfileEntry[];
  turns_seen: number;       // total chat turns we've extracted from
  updated_at: string;
};

function emptyProfile(): Profile {
  return {
    version: 1,
    learning_paused: false,
    entries: [],
    turns_seen: 0,
    updated_at: new Date(0).toISOString(),
  };
}

const MAX_ENTRIES_PER_DIMENSION = 6;
const MAX_TOTAL_ENTRIES = 40;

function profilePath(): string {
  return path.join(app.getPath("userData"), "profile.json");
}

let cached: Profile | null = null;

export function loadProfile(): Profile {
  if (cached) return cached;
  const p = profilePath();
  try {
    if (!fs.existsSync(p)) {
      cached = emptyProfile();
      return cached;
    }
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data?.version !== 1 || !Array.isArray(data?.entries)) {
      cached = emptyProfile();
      return cached;
    }
    cached = {
      version: 1,
      learning_paused: !!data.learning_paused,
      entries: data.entries.filter((e: any) => e?.id && e?.claim && e?.dimension),
      turns_seen: Number(data.turns_seen ?? 0),
      updated_at: data.updated_at ?? new Date().toISOString(),
    };
    return cached;
  } catch (e) {
    log.warn("[profile] load failed", e);
    cached = emptyProfile();
    return cached;
  }
}

export function saveProfile(p: Profile): void {
  cached = p;
  try {
    fs.writeFileSync(profilePath(), JSON.stringify(p, null, 2), "utf-8");
  } catch (e) {
    log.warn("[profile] save failed", e);
  }
}

/** Strip whitespace + lowercase for naive duplicate detection. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merge a batch of newly-extracted entries into the profile.
 *
 *  - drops near-duplicates (same dimension + same claim)
 *  - per-dimension cap prevents one dimension hogging context
 *  - if we exceed the global cap, evict lowest-confidence-and-oldest entries
 */
export function applyUpdates(
  updates: Array<{
    dimension: Dimension;
    claim: string;
    confidence: number;
    evidence?: string;
    source_turn?: string;
  }>,
): { added: number; total: number } {
  const profile = loadProfile();
  const now = new Date().toISOString();
  let added = 0;

  for (const u of updates) {
    if (!u.claim || !u.dimension) continue;
    const claim = u.claim.trim();
    const conf = Math.max(0, Math.min(1, u.confidence ?? 0.5));
    if (claim.length < 5 || conf < 0.4) continue;

    // Dedupe: same dimension + similar claim
    const dup = profile.entries.find(
      (e) => e.dimension === u.dimension && norm(e.claim) === norm(claim),
    );
    if (dup) {
      dup.confidence = Math.max(dup.confidence, conf);
      dup.added_at = now;
      continue;
    }

    profile.entries.push({
      id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      dimension: u.dimension,
      claim,
      confidence: conf,
      evidence: u.evidence ? u.evidence.trim().slice(0, 240) : undefined,
      source_turn: u.source_turn,
      added_at: now,
    });
    added += 1;
  }

  // Per-dimension cap: keep top-N by (confidence DESC, added_at DESC)
  const byDim = new Map<Dimension, ProfileEntry[]>();
  for (const e of profile.entries) {
    if (!byDim.has(e.dimension)) byDim.set(e.dimension, []);
    byDim.get(e.dimension)!.push(e);
  }
  const survivors: ProfileEntry[] = [];
  for (const [, list] of byDim) {
    list.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.added_at.localeCompare(a.added_at),
    );
    survivors.push(...list.slice(0, MAX_ENTRIES_PER_DIMENSION));
  }

  // Global cap: same scoring
  survivors.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.added_at.localeCompare(a.added_at),
  );
  profile.entries = survivors.slice(0, MAX_TOTAL_ENTRIES);
  profile.updated_at = now;
  saveProfile(profile);

  return { added, total: profile.entries.length };
}

export function bumpTurnsSeen(): void {
  const p = loadProfile();
  p.turns_seen += 1;
  saveProfile(p);
}

export function setLearningPaused(paused: boolean): void {
  const p = loadProfile();
  p.learning_paused = paused;
  saveProfile(p);
}

export function removeEntry(id: string): void {
  const p = loadProfile();
  p.entries = p.entries.filter((e) => e.id !== id);
  p.updated_at = new Date().toISOString();
  saveProfile(p);
}

export function clearAll(): void {
  const fresh = emptyProfile();
  fresh.learning_paused = loadProfile().learning_paused; // preserve pause pref
  fresh.updated_at = new Date().toISOString();
  saveProfile(fresh);
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  communication_style: "Communication",
  role_context: "Role",
  tooling: "Tooling",
  naming: "Vocabulary",
  decision_style: "Decision style",
  project_focus: "Current focus",
  anti_patterns: "Avoid",
  knowledge: "Domain knowledge",
};

export function dimensionLabel(d: Dimension): string {
  return DIMENSION_LABELS[d] ?? d;
}

/**
 * Render the profile as a compact markdown block suitable for prepending
 * to a chat turn's system prompt. Returns empty string when profile has
 * no entries.
 *
 * Two modes:
 *
 *  1. **Static (no `userMessage`)** — dumps the full profile, bounded by
 *     `MAX_ENTRIES_PER_DIMENSION` per dimension (~250 tokens at the cap).
 *     Used by callers that don't have the user message in scope or that
 *     explicitly want everything (legacy behavior).
 *
 *  2. **Relevance-filtered (`userMessage` provided)** — keeps load-bearing
 *     dimensions in full (anti_patterns + communication_style; the user
 *     told Prism explicit don'ts and tone, so these MUST always be in
 *     scope) and ranks every other dimension's entries by lexical overlap
 *     with the message. Hard cap ~12 lines total. The Prism-shaped echo
 *     of LatentRAG's "don't pay for context that's not relevant to this
 *     query" — we can't joint-train an LLM+retriever (the model is
 *     frozen, we wrap claude CLI), but we can stop dumping
 *     "knowledge: prefers Mandarin" into a turn that's about TypeScript.
 */
const ALWAYS_INCLUDE_DIMENSIONS: Dimension[] = [
  "anti_patterns",
  "communication_style",
];

const RELEVANCE_DIM_ORDER: Dimension[] = [
  "role_context",
  "decision_style",
  "tooling",
  "project_focus",
  "naming",
  "knowledge",
];

const FULL_DIM_ORDER: Dimension[] = [
  "anti_patterns",
  "communication_style",
  "role_context",
  "decision_style",
  "tooling",
  "project_focus",
  "naming",
  "knowledge",
];

const RELEVANCE_LINE_BUDGET = 12;

/**
 * v0.1.36: SURE-RAG-inspired sufficiency gates. If the BEST relevance
 * candidate scores below these thresholds, we abstain — render only
 * always-on dimensions, no relevance block. Better silence than noise.
 *
 * Calibration:
 *  - cosine 0.18-0.22 is "borderline" on MiniLM-L6-v2; below 0.22 is
 *    statistically indistinguishable from unrelated documents.
 *  - lexical > 0 means at least one stem-shared token; require > 0.5
 *    so we have real overlap, not a single accidental word match.
 */
const SUFFICIENCY_THRESHOLD_COSINE = 0.22;
const SUFFICIENCY_THRESHOLD_LEXICAL = 0.5;

// v0.1.62: EvolveMem — pull adapted thresholds from feedback module.
// Falls back to the defaults above if the module errors. Bounds are
// enforced inside profile-feedback so we never escape sanity.
import { getAdaptedThresholds } from "./profile-feedback";
function effectiveCosineThreshold(): number {
  try {
    return getAdaptedThresholds().cosine;
  } catch {
    return SUFFICIENCY_THRESHOLD_COSINE;
  }
}
function effectiveLexicalThreshold(): number {
  try {
    return getAdaptedThresholds().lexical;
  } catch {
    return SUFFICIENCY_THRESHOLD_LEXICAL;
  }
}

/** Lowercase tokenize, drop short noise words. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/\W+/)) {
    if (raw.length >= 3) out.add(raw);
  }
  return out;
}

/** Cheap lexical relevance: |query ∩ entry| / log(|entry|+2).
 *  Used as fallback when embeddings aren't ready or embedding fails. */
function lexicalRelevance(entryText: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const entryTokens = tokenize(entryText);
  if (entryTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (entryTokens.has(t)) overlap += 1;
  return overlap / Math.log(entryTokens.size + 2);
}

/** Cosine over L2-normalized 384-dim MiniLM embeddings == dot product. */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Text we embed for each entry — claim plus optional evidence. */
function entryEmbedText(e: ProfileEntry): string {
  return e.evidence ? `${e.claim} ${e.evidence}` : e.claim;
}

/**
 * Background embed-on-update. Walks the profile, embeds any entry
 * that doesn't have an `embedding` yet, persists. Fire-and-forget
 * from the caller's POV — never blocks chat. If the model fails to
 * load (offline first run), the entries just stay unembedded and
 * `renderForInjection()` falls back to lexical scoring.
 *
 * Called from `profile-extractor.ts` after every applyUpdates(), and
 * once at app boot to backfill entries created before v0.1.23.
 */
export async function embedUnembedded(): Promise<{ embedded: number }> {
  const profile = loadProfile();
  const pending = profile.entries.filter(
    (e) => !Array.isArray(e.embedding) || e.embedding.length === 0,
  );
  if (pending.length === 0) return { embedded: 0 };

  // Lazy-import embed.ts so this module stays loadable even when the
  // transformers package can't initialize (e.g. headless smoke tests).
  let embed: (text: string) => Promise<number[]>;
  try {
    ({ embed } = require("./embed"));
  } catch (e) {
    log.info("[profile] embed module unavailable; skipping background embed");
    return { embedded: 0 };
  }

  let embedded = 0;
  for (const e of pending) {
    try {
      const v = await embed(entryEmbedText(e));
      if (v && v.length > 0) {
        e.embedding = v;
        embedded += 1;
      }
    } catch (err) {
      // First-call download failure or any embed error — stop the batch
      // and try again next applyUpdates(). Don't loop on errors.
      log.warn("[profile] embed failed mid-batch", String(err).slice(0, 200));
      break;
    }
  }
  if (embedded > 0) saveProfile(profile);
  return { embedded };
}

/** How many entries have a usable embedding right now. Used by the
 *  renderer's relevance path to decide whether to ask for an embedding
 *  query or fall straight to lexical. */
function embeddingCoverage(profile: Profile): {
  total: number;
  embedded: number;
} {
  let embedded = 0;
  for (const e of profile.entries) {
    if (Array.isArray(e.embedding) && e.embedding.length > 0) embedded += 1;
  }
  return { total: profile.entries.length, embedded };
}

/** Timeout budget (ms) for embedding the user message inline on a chat
 *  turn. After this, we ship the lexical-filtered profile and keep the
 *  chat path snappy. Warm calls are ~30-80ms on M-series so 200ms gives
 *  3-5x headroom; cold-start (first ever turn) usually exceeds this and
 *  silently uses lexical, which is correct. */
const EMBED_QUERY_TIMEOUT_MS = 200;

export async function renderForInjection(
  userMessage?: string,
  // v0.1.62: optional out-array — caller pushes injected claim text into it
  // for the EvolveMem feedback loop. Untouched if omitted (backwards-compat).
  injectedOut?: string[],
): Promise<string> {
  const p = loadProfile();
  if (p.entries.length === 0) return "";

  const filtered = typeof userMessage === "string" && userMessage.trim().length > 0;
  const lines: string[] = [];
  const recordClaim = (text: string) => {
    if (injectedOut) injectedOut.push(text);
  };

  if (!filtered) {
    // Static mode — keep legacy behavior.
    for (const d of FULL_DIM_ORDER) {
      const items = p.entries
        .filter((e) => e.dimension === d)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 4);
      if (items.length === 0) continue;
      lines.push(`**${dimensionLabel(d)}**`);
      for (const it of items) {
        const claim = it.claim.length > 140 ? it.claim.slice(0, 137) + "…" : it.claim;
        lines.push(`- ${claim}`);
        recordClaim(it.claim);
      }
    }
  } else {
    const queryTokens = tokenize(userMessage as string);

    // Always-on dimensions: top-3 by confidence, no relevance filtering.
    for (const d of ALWAYS_INCLUDE_DIMENSIONS) {
      const items = p.entries
        .filter((e) => e.dimension === d)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      if (items.length === 0) continue;
      lines.push(`**${dimensionLabel(d)}**`);
      for (const it of items) {
        const claim = it.claim.length > 140 ? it.claim.slice(0, 137) + "…" : it.claim;
        lines.push(`- ${claim}`);
        recordClaim(it.claim);
      }
    }

    // Relevance-filtered dimensions: rank by (embedding cosine if
    // available, else lexical), keep only those with non-zero score,
    // fit within the remaining line budget.
    const remaining = RELEVANCE_LINE_BUDGET - lines.length;
    if (remaining > 0) {
      // Try the embedding path. Conditions for it to fire:
      //   (a) Every relevance-pool entry has a cached embedding
      //   (b) We can embed the user message within the timeout budget
      // If either fails, fall back to lexical. Failures stay silent —
      // the embedder logs its own warnings.
      const relevancePool = p.entries.filter((e) =>
        RELEVANCE_DIM_ORDER.includes(e.dimension),
      );
      const allEmbedded =
        relevancePool.length > 0 &&
        relevancePool.every(
          (e) => Array.isArray(e.embedding) && e.embedding!.length > 0,
        );

      let queryVec: number[] | null = null;
      if (allEmbedded) {
        try {
          const embedMod = require("./embed");
          queryVec = await embedMod.embedWithTimeout(
            userMessage as string,
            EMBED_QUERY_TIMEOUT_MS,
          );
        } catch {
          queryVec = null;
        }
      }

      const scoringMode: "embedding" | "lexical" =
        queryVec && allEmbedded ? "embedding" : "lexical";

      type Scored = { entry: ProfileEntry; score: number };
      const candidates: Scored[] = relevancePool
        .map((entry) => {
          let score = 0;
          if (scoringMode === "embedding" && queryVec) {
            score = cosine(queryVec, entry.embedding!);
          } else {
            score = lexicalRelevance(
              entry.claim + " " + (entry.evidence ?? ""),
              queryTokens,
            );
          }
          return { entry, score };
        })
        // Threshold: cosine > 0.18 catches genuinely-related items
        // (the MiniLM L6-v2 baseline for "unrelated" is around 0.05-
        // 0.15). For lexical, > 0 is the right bar.
        .filter((c) =>
          scoringMode === "embedding" ? c.score > 0.18 : c.score > 0,
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.entry.confidence - a.entry.confidence ||
            b.entry.added_at.localeCompare(a.entry.added_at),
        );

      // v0.1.36: SURE-RAG-inspired sufficiency gate. If even the BEST
      // relevance candidate has a weak score, the joint evidence is
      // unlikely to cover the question — abstain from injecting the
      // relevance block entirely. The always-on dimensions
      // (anti_patterns + communication_style) stay in scope.
      const topScore = candidates[0]?.score ?? 0;
      // v0.1.62: use adapted threshold from EvolveMem feedback loop.
      const sufficiencyThreshold =
        scoringMode === "embedding"
          ? effectiveCosineThreshold()
          : effectiveLexicalThreshold();
      const sufficiencyPassed = topScore >= sufficiencyThreshold;

      // v0.1.36: BRIGHT-Pro-inspired evidence portfolio. The naive
      // top-k-by-score loop the previous version used can fill the
      // entire budget with 4 entries from the same dimension when the
      // user's question lexically overlaps one cluster — exactly the
      // failure mode BRIGHT-Pro flagged ("retrievers trained for top-k
      // similarity fail in agentic loops where each step needs
      // complementary evidence, not more of the same"). Replace with
      // a two-pass selection:
      //   PASS 1 (portfolio): top-1 per dimension by score
      //   PASS 2 (fill):       remaining budget by score, allowing
      //                        seconds/thirds from already-covered dims
      // Guarantees coverage when ≥2 dimensions have a viable candidate.
      const byDim = new Map<Dimension, ProfileEntry[]>();
      let kept = 0;
      let portfolioDimsCovered = 0;
      if (sufficiencyPassed) {
        const claimed = new Set<string>();
        // PASS 1: one per dimension
        const dimSeen = new Set<Dimension>();
        for (const { entry } of candidates) {
          if (kept >= remaining) break;
          if (dimSeen.has(entry.dimension)) continue;
          dimSeen.add(entry.dimension);
          claimed.add(entry.id);
          const list = byDim.get(entry.dimension) ?? [];
          list.push(entry);
          byDim.set(entry.dimension, list);
          kept += 1;
          portfolioDimsCovered += 1;
        }
        // PASS 2: fill remaining budget by score, skipping already-picked
        for (const { entry } of candidates) {
          if (kept >= remaining) break;
          if (claimed.has(entry.id)) continue;
          claimed.add(entry.id);
          const list = byDim.get(entry.dimension) ?? [];
          list.push(entry);
          byDim.set(entry.dimension, list);
          kept += 1;
        }
      }

      try {
        log.info(
          "[profile-render]",
          JSON.stringify({
            mode: scoringMode,
            pool: relevancePool.length,
            kept,
            topScore,
            sufficiencyPassed,
            sufficiencyThreshold,
            portfolioDimsCovered,
          }),
        );
      } catch {
        /* logging is best-effort */
      }
      for (const d of RELEVANCE_DIM_ORDER) {
        const items = byDim.get(d);
        if (!items || items.length === 0) continue;
        lines.push(`**${dimensionLabel(d)}**`);
        for (const it of items) {
          const claim = it.claim.length > 140 ? it.claim.slice(0, 137) + "…" : it.claim;
          lines.push(`- ${claim}`);
          recordClaim(it.claim);
        }
      }
    }
  }

  if (lines.length === 0) return "";

  return [
    "<!-- Prism auto-profile: stable preferences and facts about the user, ",
    "auto-extracted from prior conversations. Bias responses to fit, but ",
    "don't repeat or reference these unless the user asks. -->",
    "",
    ...lines,
  ].join("\n");
}
