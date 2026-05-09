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

/** Lowercase tokenize, drop short noise words. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/\W+/)) {
    if (raw.length >= 3) out.add(raw);
  }
  return out;
}

/** Cheap lexical relevance: |query ∩ entry| / log(|entry|+2). */
function relevance(entryText: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const entryTokens = tokenize(entryText);
  if (entryTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (entryTokens.has(t)) overlap += 1;
  // Normalize so a 200-char entry doesn't dominate a 50-char one purely
  // by token-count.
  return overlap / Math.log(entryTokens.size + 2);
}

export function renderForInjection(userMessage?: string): string {
  const p = loadProfile();
  if (p.entries.length === 0) return "";

  const filtered = typeof userMessage === "string" && userMessage.trim().length > 0;
  const lines: string[] = [];

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
      }
    }

    // Relevance-filtered dimensions: rank globally across remaining
    // entries by (relevance, confidence), keep only those with
    // non-zero relevance, fit within the remaining line budget.
    const remaining = RELEVANCE_LINE_BUDGET - lines.length;
    if (remaining > 0) {
      type Scored = { entry: ProfileEntry; score: number };
      const candidates: Scored[] = p.entries
        .filter((e) => RELEVANCE_DIM_ORDER.includes(e.dimension))
        .map((entry) => ({
          entry,
          score: relevance(entry.claim + " " + (entry.evidence ?? ""), queryTokens),
        }))
        .filter((c) => c.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.entry.confidence - a.entry.confidence ||
            b.entry.added_at.localeCompare(a.entry.added_at),
        );

      // Group surviving candidates back by dimension to render under
      // headers, preserving the ranking inside each group.
      const byDim = new Map<Dimension, ProfileEntry[]>();
      let kept = 0;
      for (const { entry } of candidates) {
        if (kept >= remaining) break;
        const list = byDim.get(entry.dimension) ?? [];
        list.push(entry);
        byDim.set(entry.dimension, list);
        kept += 1;
      }
      for (const d of RELEVANCE_DIM_ORDER) {
        const items = byDim.get(d);
        if (!items || items.length === 0) continue;
        lines.push(`**${dimensionLabel(d)}**`);
        for (const it of items) {
          const claim = it.claim.length > 140 ? it.claim.slice(0, 137) + "…" : it.claim;
          lines.push(`- ${claim}`);
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
