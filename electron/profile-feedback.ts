/**
 * v0.1.62 — EvolveMem-inspired adaptive thresholds for profile injection.
 *
 * Background (v0.1.36): renderForInjection in profile-store.ts uses
 * static SURE-RAG sufficiency gates: cosine ≥ 0.22, lexical ≥ 0.5.
 * Those numbers were picked once, by hand, and never moved. If a user's
 * vocabulary or model drifts, the thresholds rot. EvolveMem treats
 * thresholds as a learnable surface.
 *
 * The signal: after each turn, embed the assistant's response, then for
 * each profile entry that WAS injected as relevance context, compute
 * cosine(claim_embedding, response_embedding). If ≥ USED_THRESHOLD,
 * we say the injection "showed up" in the response — it was load-bearing.
 * Otherwise it was noise.
 *
 * Update rule (Robbins-Monro on a binary signal):
 *   observed_usage_rate = mean(was_used) over a sliding window
 *   delta = LR * (observed - target)
 *   new_threshold = clamp(old_threshold - delta, MIN, MAX)
 *
 *   - observed > target → injections are landing → lower threshold (include more)
 *   - observed < target → injections are noise → raise threshold (be picky)
 *
 * Why this is safe: thresholds are clamped to a sane band, and the LR
 * is small enough that one bad turn moves the needle by <0.001. The
 * adapted threshold supplements but never replaces the floor — even if
 * the optimizer pushes it down, we never go below MIN_COSINE.
 *
 * Persistence:
 *   - <userData>/profile-feedback.jsonl: append-only event log
 *   - <userData>/profile-config-adapted.json: current adapted thresholds
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import log from "electron-log";
import { embed, cosine } from "./embed";

const USED_THRESHOLD = 0.35; // cosine ≥ this = "the injection appeared in the response"
const TARGET_USAGE_RATE = 0.5; // half of injections should land = healthy
const LR = 0.01; // per-observation step
const WINDOW = 50; // sliding window for usage-rate estimate

// Threshold bounds — adapted values can't escape these.
const MIN_COSINE = 0.15;
const MAX_COSINE = 0.4;
const MIN_LEXICAL = 0.3;
const MAX_LEXICAL = 0.8;

type FeedbackEvent = {
  turnId: string;
  timestamp: string;
  injectedClaims: string[]; // claim text of each injected entry
  usedFlags: boolean[]; // parallel — whether each one appeared in the response
};

type AdaptedConfig = {
  cosineThreshold: number;
  lexicalThreshold: number;
  totalObservations: number;
  recentUsageRate: number;
  updatedAt: string;
};

function feedbackLogPath(): string {
  return path.join(app.getPath("userData"), "profile-feedback.jsonl");
}
function adaptedConfigPath(): string {
  return path.join(app.getPath("userData"), "profile-config-adapted.json");
}

function loadAdapted(): AdaptedConfig {
  try {
    const raw = fs.readFileSync(adaptedConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as AdaptedConfig;
    return {
      cosineThreshold: clamp(parsed.cosineThreshold, MIN_COSINE, MAX_COSINE),
      lexicalThreshold: clamp(parsed.lexicalThreshold, MIN_LEXICAL, MAX_LEXICAL),
      totalObservations: parsed.totalObservations | 0,
      recentUsageRate: parsed.recentUsageRate ?? 0.5,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return {
      cosineThreshold: 0.22,
      lexicalThreshold: 0.5,
      totalObservations: 0,
      recentUsageRate: 0.5,
      updatedAt: new Date().toISOString(),
    };
  }
}

function saveAdapted(cfg: AdaptedConfig): void {
  try {
    fs.writeFileSync(adaptedConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    log.warn("[profile-feedback] save failed", String(e).slice(0, 200));
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function appendEvent(ev: FeedbackEvent): void {
  try {
    fs.appendFileSync(feedbackLogPath(), JSON.stringify(ev) + "\n", "utf8");
  } catch (e) {
    log.warn("[profile-feedback] append failed", String(e).slice(0, 200));
  }
}

function recentUsageRateFromLog(): { rate: number; observations: number } {
  try {
    const raw = fs.readFileSync(feedbackLogPath(), "utf8");
    const lines = raw.trim().split("\n").slice(-WINDOW);
    let usedCount = 0;
    let total = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as FeedbackEvent;
        for (const flag of ev.usedFlags) {
          total++;
          if (flag) usedCount++;
        }
      } catch {
        continue;
      }
    }
    if (total === 0) return { rate: TARGET_USAGE_RATE, observations: 0 };
    return { rate: usedCount / total, observations: total };
  } catch {
    return { rate: TARGET_USAGE_RATE, observations: 0 };
  }
}

/**
 * Returns the current adapted thresholds. Cheap — reads cached JSON.
 * profile-store calls this in renderForInjection.
 */
export function getAdaptedThresholds(): {
  cosine: number;
  lexical: number;
} {
  const a = loadAdapted();
  return { cosine: a.cosineThreshold, lexical: a.lexicalThreshold };
}

/**
 * Record a turn's feedback signal + advance the adapted thresholds.
 * Called from claude-client after the assistant finishes a turn.
 *
 *   injectedClaims: the entry.claim strings for entries that were
 *                   actually included in the rendered prompt (i.e.
 *                   passed the existing threshold). If empty, we
 *                   skip — no observation to make.
 *   assistantResponse: the final assistant text from the turn.
 */
export async function recordTurnFeedback(params: {
  turnId: string;
  injectedClaims: string[];
  assistantResponse: string;
}): Promise<void> {
  if (params.injectedClaims.length === 0) return;
  if (!params.assistantResponse || params.assistantResponse.length < 20) return;
  let responseEmbedding: number[];
  try {
    responseEmbedding = await embed(params.assistantResponse.slice(0, 2000));
  } catch (e) {
    log.warn("[profile-feedback] embed failed", String(e).slice(0, 200));
    return;
  }
  const usedFlags: boolean[] = [];
  for (const claim of params.injectedClaims) {
    try {
      const claimEmbedding = await embed(claim);
      const sim = cosine(claimEmbedding, responseEmbedding);
      usedFlags.push(sim >= USED_THRESHOLD);
    } catch {
      usedFlags.push(false);
    }
  }
  appendEvent({
    turnId: params.turnId,
    timestamp: new Date().toISOString(),
    injectedClaims: params.injectedClaims,
    usedFlags,
  });

  // Update adapted thresholds via Robbins-Monro.
  const { rate, observations } = recentUsageRateFromLog();
  // Only adapt once we have at least 10 observations — the early
  // window has too much variance otherwise.
  if (observations < 10) return;
  const cfg = loadAdapted();
  const delta = LR * (rate - TARGET_USAGE_RATE);
  // observed > target → injections are useful → relax threshold (lower)
  // observed < target → injections are noise → tighten threshold (raise)
  cfg.cosineThreshold = clamp(
    cfg.cosineThreshold - delta,
    MIN_COSINE,
    MAX_COSINE,
  );
  cfg.lexicalThreshold = clamp(
    cfg.lexicalThreshold - delta * 1.5, // lexical band is wider, larger steps OK
    MIN_LEXICAL,
    MAX_LEXICAL,
  );
  cfg.totalObservations = (cfg.totalObservations | 0) + 1;
  cfg.recentUsageRate = rate;
  cfg.updatedAt = new Date().toISOString();
  saveAdapted(cfg);
  log.info(
    `[profile-feedback] obs=${observations} usage=${(rate * 100).toFixed(0)}% cos=${cfg.cosineThreshold.toFixed(3)} lex=${cfg.lexicalThreshold.toFixed(3)}`,
  );
}

/**
 * Read-only stats for the Settings → Memory tab to show "the system
 * is learning." Cheap to compute.
 */
export function getFeedbackStats(): {
  totalObservations: number;
  recentUsageRate: number;
  cosineThreshold: number;
  lexicalThreshold: number;
  defaultCosine: number;
  defaultLexical: number;
  updatedAt: string;
} {
  const cfg = loadAdapted();
  return {
    totalObservations: cfg.totalObservations,
    recentUsageRate: cfg.recentUsageRate,
    cosineThreshold: cfg.cosineThreshold,
    lexicalThreshold: cfg.lexicalThreshold,
    defaultCosine: 0.22,
    defaultLexical: 0.5,
    updatedAt: cfg.updatedAt,
  };
}
