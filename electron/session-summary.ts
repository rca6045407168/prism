/**
 * v0.1.47 — Cross-session context retrieval (claude-mem-inspired).
 *
 * The pattern (stolen from thedotmack/claude-mem, 76k stars):
 *   - On chat end, generate a tight 60-100 word summary of the
 *     conversation via Haiku (fast, cheap).
 *   - Persist alongside the chat: {chat_id, title, summary, embedding,
 *     project_id, updated_at}.
 *   - On the start of a NEW chat, embed the user's first message and
 *     run cosine similarity against the summary corpus. Inject the
 *     top-1 match (if cosine ≥ 0.30) as context for the new turn —
 *     "in a previous conversation X, you decided Y."
 *
 * Compressed from claude-mem's 5-hook + SQLite + Chroma model into
 * Prism's existing infra: we already have the embed module (MiniLM)
 * and the haiku call pattern (from chat-title generation). One JSON
 * file at <userData>/session-summaries.json keeps the catalog.
 *
 * Tradeoff vs claude-mem: we do NOT capture per-tool observations or
 * progressive disclosure; we do NOT mount a web viewer on port 37777.
 * v1 is just summary + cosine retrieval. Token-cost-visibility and
 * `<private>` tag exclusion are v0.1.48+ scope.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type SessionSummary = {
  chatId: string;
  title: string;
  summary: string;
  embedding: number[]; // 384-dim, MiniLM-L6-v2
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
};

const STORE_FILENAME = "session-summaries.json";

function storeFile(): string {
  return path.join(app.getPath("userData"), STORE_FILENAME);
}

function readStore(): SessionSummary[] {
  try {
    const raw = fs.readFileSync(storeFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(summaries: SessionSummary[]): void {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(summaries, null, 2), "utf-8");
  } catch (e: any) {
    try {
      require("electron-log").warn("[session-summary] write failed", e?.message);
    } catch {
      /* logging best-effort */
    }
  }
}

/**
 * Spawn a one-shot Haiku call to summarize a chat. Mirrors the title-
 * generation pattern from claude-client.ts — non-interactive `--print`,
 * 15s timeout, no tool access. Returns the summary text or empty
 * string on failure.
 */
async function summarizeViaHaiku(
  claudeBin: string,
  chatTitle: string,
  userMessages: string[],
  assistantMessages: string[],
): Promise<string> {
  const transcript = userMessages
    .map((u, i) => `USER: ${u.slice(0, 800)}\nASSISTANT: ${(assistantMessages[i] ?? "").slice(0, 800)}`)
    .join("\n\n---\n\n")
    .slice(0, 12000);

  const prompt = [
    `Summarize the following chat conversation in 60-100 words.`,
    `Focus on: the user's intent, the decisions/conclusions reached, any commitments or follow-ups.`,
    `Do NOT include API keys, file paths, or PII verbatim — describe them generically.`,
    `Output ONLY the summary paragraph, no preamble.`,
    ``,
    `Title: ${chatTitle}`,
    ``,
    transcript,
  ].join("\n");

  const HOME = process.env.HOME ?? "";
  const augmentedPath = [
    `${HOME}/.openclaw/bin`,
    `${HOME}/.local/bin`,
    `${HOME}/.npm-global/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH ?? "",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":");

  return new Promise<string>((resolve) => {
    let settled = false;
    let proc: ChildProcess;
    try {
      proc = spawn(
        claudeBin,
        ["--print", "--model", "haiku", "--permission-mode", "plan", prompt],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: HOME || undefined,
          env: { ...process.env, PATH: augmentedPath },
        },
      );
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      resolve("");
    }, 15_000);

    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleaned = out
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .slice(0, 2000);
      resolve(cleaned);
    });
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("");
    });
  });
}

/**
 * Public API: persist a session summary for a chat. The renderer
 * calls this on chat:end when the chat is "substantive" (≥2 user
 * turns, ≥1 assistant response). We compute the summary + embedding
 * here in the main process, then persist.
 *
 * Idempotent: calling with the same chatId UPDATES the existing
 * record rather than duplicating.
 */
export async function recordSessionSummary(params: {
  chatId: string;
  title: string;
  userMessages: string[];
  assistantMessages: string[];
  projectId: string | null;
  claudeBin: string;
}): Promise<SessionSummary | null> {
  const { chatId, title, userMessages, assistantMessages, projectId, claudeBin } = params;
  if (userMessages.length < 1 || assistantMessages.length < 1) return null;

  const summary = await summarizeViaHaiku(
    claudeBin,
    title,
    userMessages,
    assistantMessages,
  );
  if (!summary || summary.length < 20) return null;

  // Embed the summary via existing MiniLM module.
  let embedding: number[] = [];
  try {
    const embedMod = require("./embed");
    embedding = await embedMod.embedWithTimeout(summary, 2000);
  } catch {
    /* fall through with empty embedding — retrieval just won't match this chat */
  }
  if (!embedding || embedding.length === 0) return null;

  const now = Date.now();
  const existing = readStore();
  const idx = existing.findIndex((s) => s.chatId === chatId);
  const record: SessionSummary = {
    chatId,
    title,
    summary,
    embedding,
    projectId,
    createdAt: idx >= 0 ? existing[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) {
    existing[idx] = record;
  } else {
    existing.push(record);
  }
  // Cap at 500 most-recent summaries to keep file size + retrieval cost
  // bounded. 500 × 384 × 8 bytes ≈ 1.5 MB on disk.
  existing.sort((a, b) => b.updatedAt - a.updatedAt);
  writeStore(existing.slice(0, 500));
  return record;
}

/**
 * Public API: find the top-k past sessions most similar to a query
 * (typically the user's first message of a new chat). Filtered by:
 *   - excludes the current chat (so a resumed chat doesn't recall itself)
 *   - optionally scoped to a single projectId
 *   - cosine ≥ 0.30 threshold (genuine relevance, not noise)
 */
export async function recallSimilarSessions(params: {
  queryText: string;
  excludeChatId?: string;
  projectId?: string | null;
  limit?: number;
}): Promise<Array<SessionSummary & { score: number }>> {
  const { queryText, excludeChatId, projectId, limit = 1 } = params;
  if (!queryText || queryText.trim().length < 4) return [];

  let queryVec: number[] = [];
  try {
    const embedMod = require("./embed");
    queryVec = await embedMod.embedWithTimeout(queryText, 800);
  } catch {
    return [];
  }
  if (!queryVec || queryVec.length === 0) return [];

  const cosine: (a: number[], b: number[]) => number = require("./embed").cosine;

  const all = readStore();
  const candidates = all
    .filter((s) => s.chatId !== excludeChatId)
    .filter((s) =>
      projectId === undefined ? true : s.projectId === projectId,
    )
    .map((s) => ({ ...s, score: cosine(queryVec, s.embedding) }))
    .filter((s) => s.score >= 0.30)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return candidates;
}

/**
 * Register IPC handlers — called from main.ts on app ready.
 */
export function registerSessionSummary(_getWindow: () => BrowserWindow | null) {
  ipcMain.handle(
    "prism:session:record",
    async (
      _e,
      params: {
        chatId: string;
        title: string;
        userMessages: string[];
        assistantMessages: string[];
        projectId: string | null;
      },
    ) => {
      const HOME = process.env.HOME ?? "";
      const CANDIDATES = [
        `${HOME}/.openclaw/bin/claude`,
        `${HOME}/.local/bin/claude-arm64-orig`,
        `${HOME}/.local/bin/claude`,
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];
      const claudeBin = CANDIDATES.find((p) => fs.existsSync(p)) ?? "";
      if (!claudeBin) return { ok: false, error: "claude CLI not found" };
      try {
        const record = await recordSessionSummary({ ...params, claudeBin });
        return record ? { ok: true, record } : { ok: false, error: "summary skipped" };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );

  ipcMain.handle(
    "prism:session:recall",
    async (
      _e,
      params: {
        queryText: string;
        excludeChatId?: string;
        projectId?: string | null;
        limit?: number;
      },
    ) => {
      try {
        const hits = await recallSimilarSessions(params);
        return { hits };
      } catch (e: any) {
        return { hits: [], error: e?.message ?? String(e) };
      }
    },
  );
}
