/**
 * v0.1.50 — Detect a locally-running Ollama instance.
 *
 * Ollama exposes a stable HTTP API at 127.0.0.1:11434 by default.
 * `GET /api/tags` returns the list of pulled models. If the request
 * succeeds, Ollama is running. If it fails with ECONNREFUSED, Ollama
 * is either not installed or not running (we check the binary on PATH
 * to disambiguate).
 *
 * No SDK dependency — plain fetch() (Electron 33 has global fetch).
 * Network call is local-only so we don't worry about leakage.
 *
 * This is detection ONLY. v0.1.50 does not actually route any traffic
 * to Ollama. Future release will surface "use Ollama for this turn"
 * via the model picker once we have a streaming bridge.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { Provider, ProviderDetectResult } from "./types";

const execp = promisify(exec);
const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const FETCH_TIMEOUT_MS = 1200;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeBinary(): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await execp("/usr/bin/env ollama --version", {
      timeout: 1500,
    });
    const m = stdout.match(/version is ([\d.]+)/) ?? stdout.match(/([\d.]+)/);
    return { installed: true, version: m?.[1] };
  } catch {
    return { installed: false };
  }
}

export async function detectOllama(): Promise<ProviderDetectResult> {
  // Try the daemon first — that's the fast path.
  try {
    const res = await fetchWithTimeout(`${OLLAMA_ENDPOINT}/api/tags`, FETCH_TIMEOUT_MS);
    if (res.ok) {
      const body = (await res.json()) as {
        models?: Array<{
          name?: string;
          size?: number;
          details?: { family?: string };
        }>;
      };
      const models = (body.models ?? [])
        .filter((m) => typeof m.name === "string")
        .map((m) => ({
          name: m.name as string,
          size: m.size,
          family: m.details?.family,
        }));
      const bin = await probeBinary();
      return {
        installed: true,
        running: true,
        version: bin.version,
        models,
        endpoint: OLLAMA_ENDPOINT,
      };
    }
  } catch {
    // fall through — daemon not running
  }

  const bin = await probeBinary();
  if (bin.installed) {
    return {
      installed: true,
      running: false,
      version: bin.version,
      models: [],
      endpoint: OLLAMA_ENDPOINT,
    };
  }

  return {
    installed: false,
    reason: "Ollama binary not on PATH and no daemon at 127.0.0.1:11434.",
    hint: "Install from https://ollama.com — then `ollama pull llama3.2` for a starter model.",
  };
}

export const OllamaProvider: Provider = {
  id: "ollama",
  label: "Ollama (local)",
  detect: detectOllama,
};
