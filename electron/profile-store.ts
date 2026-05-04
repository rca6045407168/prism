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
 * to a chat turn's system prompt. Capped at ~250 tokens by line count +
 * per-line trim. Returns empty string when profile has no entries.
 */
export function renderForInjection(): string {
  const p = loadProfile();
  if (p.entries.length === 0) return "";

  // Order: by dimension priority (anti_patterns first — they're load-bearing),
  // then highest-confidence within each dimension.
  const dimOrder: Dimension[] = [
    "anti_patterns",
    "communication_style",
    "role_context",
    "decision_style",
    "tooling",
    "project_focus",
    "naming",
    "knowledge",
  ];

  const lines: string[] = [];
  for (const d of dimOrder) {
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
  if (lines.length === 0) return "";

  return [
    "<!-- Prism auto-profile: stable preferences and facts about the user, ",
    "auto-extracted from prior conversations. Bias responses to fit, but ",
    "don't repeat or reference these unless the user asks. -->",
    "",
    ...lines,
  ].join("\n");
}
