/**
 * Local semantic embedding via @xenova/transformers running MiniLM-L6.
 *
 * Inspired by LatentRAG (arxiv 2605.06285): we can't joint-train the
 * model+retriever (claude is frozen), but we CAN move the auto-profile
 * relevance signal from lexical to semantic. "Maersk" should match
 * "ocean carriers" without word overlap; this module makes that work.
 *
 * Architecture:
 *  - Model: Xenova/all-MiniLM-L6-v2 (~22MB ONNX, 384-dim sentence embeddings)
 *  - First call downloads + caches the model to <userData>/transformers-cache/
 *  - Subsequent calls are warm: ~30-80ms per short text on M-series
 *  - Lazy: never loads until the first embed() call
 *  - On any failure (offline first-run, ONNX error, etc.) embed() throws;
 *    callers fall back to lexical relevance
 *
 * This stays in the main process. The model runs via ONNX wasm so no
 * native bindings; Electron-rebuild not required.
 */
import * as path from "path";
import { app } from "electron";
import log from "electron-log";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let pipelinePromise: Promise<any> | null = null;
let cacheDirSet = false;

/** Configure transformers.js to cache models under <userData>. */
function configureCacheDir(transformers: any): void {
  if (cacheDirSet) return;
  try {
    const cacheDir = path.join(app.getPath("userData"), "transformers-cache");
    // env is available on the imported module as `env` (v2 API)
    if (transformers.env) {
      transformers.env.cacheDir = cacheDir;
      // Don't allow the lib to write to the bundled location
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = false;
    }
    cacheDirSet = true;
    log.info("[embed] cache dir set to", cacheDir);
  } catch (e) {
    log.warn("[embed] could not configure cache dir", e);
  }
}

function loadPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // require() is fine here — @xenova/transformers v2 ships CJS bindings.
    const transformers = require("@xenova/transformers");
    configureCacheDir(transformers);
    const t0 = Date.now();
    const pipe = await transformers.pipeline("feature-extraction", MODEL_ID, {
      quantized: true,
    });
    log.info(
      "[embed] model loaded in",
      Date.now() - t0,
      "ms (first call may have included download)",
    );
    return pipe;
  })().catch((e) => {
    pipelinePromise = null;
    throw e;
  });
  return pipelinePromise;
}

/**
 * Embed a single short text to a 384-dim L2-normalized vector. Mean-
 * pooled across tokens. Throws on any error; callers should catch and
 * fall back. Empty / whitespace-only input returns a zero vector.
 */
export async function embed(text: string): Promise<number[]> {
  const clean = (text ?? "").trim();
  if (!clean) return new Array(384).fill(0);
  const pipe = await loadPipeline();
  const output = await pipe(clean, { pooling: "mean", normalize: true });
  // output is a Tensor; data is a Float32Array
  const arr = Array.from(output.data as Float32Array);
  return arr;
}

/** Cosine similarity over L2-normalized vectors == dot product. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Try embed(text) with a hard timeout. Resolves with `null` if the
 * embedding doesn't return in time — caller falls back to lexical.
 * This keeps the chat path bounded; cold-start model load is ~3-5s
 * but the timeout caps chat latency at the budget.
 */
export async function embedWithTimeout(
  text: string,
  timeoutMs: number,
): Promise<number[] | null> {
  return Promise.race([
    embed(text).catch((e) => {
      log.warn("[embed] embed failed", String(e).slice(0, 200));
      return null;
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/** Best-effort prefetch — call once at app boot so the first chat
 *  turn doesn't pay the cold-start cost. Failure is silent. */
export function prefetch(): void {
  loadPipeline().catch(() => {
    /* offline / no-network — caller is fine, lexical fallback works */
  });
}
