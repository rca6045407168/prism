/**
 * Claude CLI client — runs `claude` as a child process for each chat turn.
 *
 * Why this exists (v0.1.9): the prior WS-based gateway client made up the
 * protocol from source-reading and was wrong end-to-end. Spawning the CLI
 * binary uses the official, tested protocol path.
 *
 * Each turn opens a fresh `claude --print --output-format stream-json …`
 * process. We stream its stdout line-by-line, parse JSON events, and emit
 * IPC pushes to the renderer.
 *
 * Multi-chat: each chat has a session UUID. We pass `--resume <uuid>` so
 * claude resumes that conversation; first turn of a new chat omits --resume,
 * captures the new session_id from the init event, and saves it back.
 *
 * Abort: spawned process gets SIGTERM, claude shuts down cleanly.
 */
import { spawn, type ChildProcess } from "child_process";
import { ipcMain, BrowserWindow } from "electron";
import * as fs from "fs";

const CLAUDE_BIN_CANDIDATES = [
  "/Users/richardchen/.openclaw/bin/claude",      // arm64 wrapper (preferred)
  "/Users/richardchen/.local/bin/claude-arm64-orig", // wrapper target
  "/Users/richardchen/.local/bin/claude",
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
];

function findClaudeBin(): string | null {
  for (const p of CLAUDE_BIN_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

type Turn = {
  turnId: string;
  proc: ChildProcess;
  window: BrowserWindow;
  buffer: string;
  finalText: string;
  sessionId: string | null;
  errored: boolean;
};

const activeTurns = new Map<string, Turn>();

function emit(window: BrowserWindow, channel: string, payload: unknown) {
  if (!window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

/**
 * Parse the stream-json line. Returns `null` if not a JSON object we care
 * about. Otherwise classifies into UI events.
 */
function processLine(turn: Turn, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const type = parsed.type;

  if (type === "system" && parsed.subtype === "init") {
    turn.sessionId = parsed.session_id ?? null;
    emit(turn.window, "prism:chat:start", {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      model: parsed.model,
    });
    return;
  }

  if (type === "assistant" && parsed.message?.content) {
    // The assistant message's content is an array of {type:"text",text:"..."}
    // We treat the FULL text (we don't get per-token deltas from stream-json
    // directly for non-thinking output — only the full assistant message
    // arrives). For visual streaming we synthesize deltas by diffing
    // current text vs accumulated finalText.
    const blocks = parsed.message.content;
    let combined = "";
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        combined += b.text;
      }
    }
    if (combined.length > turn.finalText.length) {
      const delta = combined.slice(turn.finalText.length);
      turn.finalText = combined;
      emit(turn.window, "prism:chat:delta", { turnId: turn.turnId, text: delta });
    }
    return;
  }

  if (type === "result") {
    if (parsed.is_error) {
      turn.errored = true;
      const errText = parsed.result || "Claude CLI returned an error.";
      emit(turn.window, "prism:chat:error", { turnId: turn.turnId, error: errText });
    } else {
      // Backfill finalText if assistant blocks didn't arrive (shouldn't happen
      // but defensive)
      if (typeof parsed.result === "string" && parsed.result.length > turn.finalText.length) {
        const delta = parsed.result.slice(turn.finalText.length);
        turn.finalText = parsed.result;
        emit(turn.window, "prism:chat:delta", { turnId: turn.turnId, text: delta });
      }
      emit(turn.window, "prism:chat:end", {
        turnId: turn.turnId,
        finalText: turn.finalText,
        sessionId: turn.sessionId,
        durationMs: parsed.duration_ms,
        cost: parsed.total_cost_usd,
      });
    }
    return;
  }
}

function send(params: {
  message: string;
  model?: string;
  sessionId?: string | null;
  window: BrowserWindow;
}): { turnId: string } | { error: string } {
  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    return {
      error:
        "Claude CLI not found. Install Claude Code (claude.ai/code) or run: brew install anthropic-ai/tap/claude-code",
    };
  }

  const turnId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "user",
  ];
  if (params.model && params.model !== "auto") {
    args.push("--model", params.model);
  }
  if (params.sessionId) {
    args.push("--resume", params.sessionId);
  }

  // Write the message via stdin? No — claude --print takes the prompt as
  // a positional arg. Pass directly.
  args.push(params.message);

  let proc: ChildProcess;
  try {
    proc = spawn(claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (e: any) {
    return { error: `Failed to spawn claude: ${e.message ?? String(e)}` };
  }

  const turn: Turn = {
    turnId,
    proc,
    window: params.window,
    buffer: "",
    finalText: "",
    sessionId: params.sessionId ?? null,
    errored: false,
  };
  activeTurns.set(turnId, turn);

  proc.stdout?.on("data", (chunk: Buffer) => {
    turn.buffer += chunk.toString();
    let i: number;
    while ((i = turn.buffer.indexOf("\n")) >= 0) {
      const line = turn.buffer.slice(0, i);
      turn.buffer = turn.buffer.slice(i + 1);
      processLine(turn, line);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    // claude writes occasional stderr; only surface when it's an error
    const text = chunk.toString();
    if (/error/i.test(text) && !turn.errored) {
      // suppress duplicate noise
    }
  });

  proc.on("close", (code) => {
    activeTurns.delete(turnId);
    if (turn.buffer.trim()) {
      processLine(turn, turn.buffer);
      turn.buffer = "";
    }
    if (code !== 0 && !turn.errored) {
      emit(params.window, "prism:chat:error", {
        turnId,
        error: `claude exited with code ${code}`,
      });
    }
  });

  proc.on("error", (e) => {
    activeTurns.delete(turnId);
    emit(params.window, "prism:chat:error", {
      turnId,
      error: `claude spawn error: ${e.message}`,
    });
  });

  return { turnId };
}

function abort(turnId: string): { ok: boolean } {
  const turn = activeTurns.get(turnId);
  if (!turn) return { ok: false };
  try {
    turn.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  activeTurns.delete(turnId);
  emit(turn.window, "prism:chat:end", {
    turnId,
    finalText: turn.finalText + " [aborted]",
    sessionId: turn.sessionId,
  });
  return { ok: true };
}

export function registerClaudeClient(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("prism:chat:send", (_e, params: {
    message: string;
    model?: string;
    sessionId?: string | null;
  }) => {
    const window = getWindow();
    if (!window) return { error: "no window" };
    return send({ ...params, window });
  });

  ipcMain.handle("prism:chat:abort", (_e, params: { turnId: string }) => {
    return abort(params.turnId);
  });

  ipcMain.handle("prism:chat:probe", () => {
    const bin = findClaudeBin();
    return { found: !!bin, path: bin };
  });
}
