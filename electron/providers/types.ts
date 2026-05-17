/**
 * v0.1.50 — Multi-provider scaffolding.
 *
 * Today Prism delegates every chat turn to the Claude CLI subprocess
 * (electron/claude-client.ts). That's been the only provider since
 * v0.1.9 and it's worked well — Anthropic ships features there before
 * the raw API gets them (skills, MCP discovery, plan-mode, etc.).
 *
 * BUT — Ollama on the user's laptop is a real alternative for cheap,
 * private, fast prompts (summarization, autocomplete, embeddings).
 * Self-hosted models keep getting good enough for the easy half of
 * Prism's traffic. Routing trivial calls to Ollama saves money + keeps
 * those prompts off Anthropic's wire.
 *
 * This file is the scaffolding only. The interface lets a future Prism
 * release plug Ollama or any other provider behind a unified surface
 * without rewriting App.tsx. v0.1.50 ships the SHAPE + the Ollama
 * detector; v0.1.5x will wire actual routing.
 *
 * Provider contract (when fully implemented):
 *   - `id`: "claude" | "ollama" | …
 *   - `detect()` returns availability + model list
 *   - `stream(prompt, opts)` returns an async iterator of text deltas
 *
 * The Claude CLI is intentionally still the only real implementation
 * for now. Premature multi-provider abstractions are how OpenClaw-style
 * forks bloat — we keep it narrow until Ollama has earned its slot.
 */

export type ProviderId = "claude" | "ollama";

export type ProviderDetectResult =
  | {
      installed: true;
      running: boolean;
      version?: string;
      models?: Array<{ name: string; size?: number; family?: string }>;
      endpoint?: string;
    }
  | {
      installed: false;
      reason: string;
      hint?: string;
    };

export interface Provider {
  id: ProviderId;
  label: string;
  detect(): Promise<ProviderDetectResult>;
}
