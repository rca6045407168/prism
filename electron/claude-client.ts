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
import { renderForInjection } from "./profile-store";
import { enqueueExtraction } from "./profile-extractor";

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
  /** Set true when WE called abort(). Prevents the close handler from
   *  surfacing a "claude exited with code null" system message that's
   *  noise from our own SIGTERM. (v0.1.11) */
  aborted: boolean;
  /** Echoed back to the extractor on success so it can mine stable
   *  preferences from the (user, assistant) exchange. v0.1.17. */
  userMessage: string;
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
    // v0.1.15: log the init event so we can diagnose MCP availability +
    // tool count + cwd from inside the running app.
    try {
      const log = require("electron-log");
      const mcpServers: any[] = parsed.mcp_servers ?? [];
      const tools: string[] = parsed.tools ?? [];
      log.info(
        "[claude-init]",
        JSON.stringify({
          turnId: turn.turnId,
          model: parsed.model,
          cwd: parsed.cwd,
          mcpCount: mcpServers.length,
          mcpConnected: mcpServers
            .filter((s: any) => s?.status === "connected")
            .map((s: any) => s?.name),
          mcpFailed: mcpServers
            .filter((s: any) => s?.status !== "connected")
            .map((s: any) => `${s?.name}=${s?.status}`),
          toolCount: tools.length,
          mcpToolCount: tools.filter((t) => t.startsWith("mcp__")).length,
        }),
      );
    } catch {
      /* logging is best-effort */
    }
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
      // v0.1.15: claude emits a top-level `errors` array on result messages
      // when something failed (e.g. "No conversation found with session ID:
      // …" when --resume hits a stale UUID). Prefer that array over `result`.
      const errorsArray: unknown = parsed.errors;
      const errorTexts: string[] = Array.isArray(errorsArray)
        ? errorsArray.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [];
      const fromResult = typeof parsed.result === "string" ? parsed.result : "";
      const errText =
        errorTexts.join("; ") || fromResult || "Claude CLI returned an error.";

      // Detect stale --resume target → trigger a transparent retry without
      // --resume on the next turn by clearing this chat's claudeSessionId.
      const isSessionExpired =
        /no conversation found|session not found|conversation not found/i.test(
          errText,
        );

      turn.errored = true;
      emit(turn.window, "prism:chat:error", {
        turnId: turn.turnId,
        error: errText,
        sessionExpired: isSessionExpired,
      });
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

      // v0.1.17: kick off background profile extraction. Fire-and-forget
      // — never blocks the chat path, never surfaces errors.
      try {
        enqueueExtraction({
          turnId: turn.turnId,
          userMessage: turn.userMessage,
          assistantText: turn.finalText,
        });
      } catch {
        /* ignore */
      }
      // Notify renderer that a profile update may be pending — the gear
      // icon shows a tiny dot until the user opens Memory.
      emit(turn.window, "prism:profile:pending", { turnId: turn.turnId });
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
    // v0.1.13: don't pass --setting-sources at all. The previous "user"
    // restriction excluded project-level MCP configs and broke claude.ai
    // cloud MCPs (Gmail, Calendar, Drive, etc.) that come from default
    // settings. Letting claude use its default config-discovery makes the
    // spawned process inherit the same MCP servers as the terminal does.
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
  ];
  if (params.model && params.model !== "auto") {
    args.push("--model", params.model);
  }
  if (params.sessionId) {
    args.push("--resume", params.sessionId);
  }

  // v0.1.17: inject the auto-profile as a system-prompt prefix when
  // the user has any learned preferences. Empty string means no profile
  // yet → no flag → no overhead.
  const profileBlock = renderForInjection();
  if (profileBlock) {
    args.push("--append-system-prompt", profileBlock);
  }

  // Write the message via stdin? No — claude --print takes the prompt as
  // a positional arg. Pass directly.
  args.push(params.message);

  // v0.1.12: Electron apps launched from Finder inherit a minimal PATH
  // ("/usr/bin:/bin:/usr/sbin:/sbin") that excludes Homebrew + per-user
  // node installations. This breaks MCP plugins (e.g. WozCode requires
  // node >= 20.10 which lives at /opt/homebrew/bin/node or
  // /usr/local/bin/node). Force-augment PATH so claude's spawned plugins
  // and MCP servers find the binaries they need.
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
    "/usr/sbin",
    "/sbin",
  ]
    .filter(Boolean)
    .join(":");

  let proc: ChildProcess;
  try {
    proc = spawn(claudeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // v0.1.13: set cwd to HOME. Electron's default cwd is "/" which makes
      // claude's project-level config discovery fail (it looks for .claude/
      // or CLAUDE.md walking up from cwd). HOME mirrors what a fresh terminal
      // would have on first launch.
      cwd: HOME || undefined,
      env: {
        ...process.env,
        PATH: augmentedPath,
      },
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
    aborted: false,
    userMessage: params.message,
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
    // Suppress the close-as-error if WE aborted (SIGTERM gives code=null,
    // which is correct termination, not a failure). v0.1.11 fix.
    if (turn.aborted) {
      return;
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
  turn.aborted = true; // mark BEFORE killing so close handler suppresses error
  try {
    turn.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  activeTurns.delete(turnId);
  emit(turn.window, "prism:chat:end", {
    turnId,
    finalText: turn.finalText,
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
