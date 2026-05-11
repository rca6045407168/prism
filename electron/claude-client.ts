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

function stringifyToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 200);
  try {
    const json = JSON.stringify(input);
    return json.length > 200 ? json.slice(0, 197) + "…" : json;
  } catch {
    return "";
  }
}

function stringifyToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content.slice(0, 600);
  if (Array.isArray(content)) {
    // claude returns content as [{type:"text",text:"..."}] sometimes
    const text = content
      .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    return text.slice(0, 600);
  }
  try {
    return JSON.stringify(content).slice(0, 600);
  } catch {
    return "";
  }
}

/**
 * Heuristic auto-router. Picks a model tier when the user has "Auto"
 * selected in the model picker.
 *
 * Why a heuristic and not a Haiku classifier call: a pre-flight LLM
 * call doubles latency on every turn and the cost saving over a static
 * heuristic is small. This is good enough — it gets the easy 30% of
 * turns onto haiku (trivia, acks, lookups) and pushes obvious reasoning
 * work onto opus, with sonnet as the safe default.
 *
 * The user's selection of "auto" is honored here; explicit model picks
 * (haiku/sonnet/opus/etc.) bypass this function.
 *
 * Verbal-precision note: claude CLI accepts the alias names directly
 * (haiku → claude-haiku-4-5, sonnet → claude-sonnet-4-6, opus →
 * claude-opus-4-7 as of 2026-05). We pass aliases.
 */
export function routeModel(message: string): "haiku" | "sonnet" | "opus" {
  const text = (message ?? "").toLowerCase();
  const len = message.length;

  // Trivial / acknowledgement: haiku
  if (len < 30) return "haiku";

  // Strong reasoning / architecture / debugging signals: opus
  const opusSignals = [
    /\bimplement\b/,
    /\barchitect/,
    /\bdesign\b.{0,40}\b(system|api|schema|database|protocol)\b/,
    /\brefactor\b/,
    /\bdebug\b/,
    /\bdiagnose\b/,
    /\boptimi[sz]e\b/,
    /\breview\b.{0,40}\b(code|pr|patch|design|architecture)\b/,
    /\banalyze\b.{0,40}\b(architecture|design|tradeoff|root.?cause)\b/,
    /\bplan\b.{0,40}\b(migration|rollout|release|cutover)\b/,
    /```/, // user pasted code
  ];
  if (opusSignals.some((re) => re.test(text))) return "opus";

  // Long prompts probably want reasoning depth
  if (len > 1500) return "opus";
  if (len > 600) return "sonnet";

  // Short factual question: haiku
  if (text.trim().endsWith("?") && len < 140) return "haiku";

  // Default
  return "sonnet";
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
    const blocks = parsed.message.content;
    let combined = "";
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        combined += b.text;
      } else if (b.type === "tool_use") {
        // v0.1.18: surface tool calls to the UI so the user can see what
        // claude is doing while a turn is in flight (Manus-style live
        // progress). Friendly-name + truncated input preview.
        emit(turn.window, "prism:chat:tool", {
          turnId: turn.turnId,
          phase: "use",
          toolUseId: String(b.id ?? ""),
          name: String(b.name ?? "tool"),
          inputPreview: stringifyToolInput(b.input),
        });
      }
    }
    if (combined.length > turn.finalText.length) {
      const delta = combined.slice(turn.finalText.length);
      turn.finalText = combined;
      emit(turn.window, "prism:chat:delta", { turnId: turn.turnId, text: delta });
    }
    return;
  }

  // v0.1.18: tool results arrive as `user` messages with content blocks
  // of type `tool_result`. We mirror them up to the UI so the inline
  // pill can flip from "running" → "done" with a result snippet.
  if (type === "user" && parsed.message?.content) {
    const blocks = parsed.message.content;
    for (const b of blocks) {
      if (b.type === "tool_result") {
        emit(turn.window, "prism:chat:tool", {
          turnId: turn.turnId,
          phase: "result",
          toolUseId: String(b.tool_use_id ?? ""),
          isError: !!b.is_error,
          resultPreview: stringifyToolResult(b.content),
        });
      }
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

async function send(params: {
  message: string;
  model?: string;
  sessionId?: string | null;
  /** Project-level instructions injected as a system-prompt prefix,
   *  ahead of the auto-profile. v0.1.29. */
  projectInstructions?: string | null;
  window: BrowserWindow;
}): Promise<{ turnId: string } | { error: string }> {
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
  // v0.1.21: real auto-routing. "Auto" goes through the heuristic
  // router; explicit picks pass through unchanged. We log which tier
  // was chosen for auto turns so [claude-init] shows it alongside the
  // actual model claude reports back.
  let routedModel: string | null = null;
  if (params.model === "auto") {
    routedModel = routeModel(params.message);
    args.push("--model", routedModel);
    try {
      require("electron-log").info(
        "[auto-route]",
        JSON.stringify({
          turnId,
          tier: routedModel,
          messageLen: params.message.length,
          messagePreview: params.message.slice(0, 80),
        }),
      );
    } catch {
      /* logging best-effort */
    }
  } else if (params.model && params.model !== "auto") {
    args.push("--model", params.model);
  }
  if (params.sessionId) {
    args.push("--resume", params.sessionId);
  }

  // v0.1.17: inject the auto-profile as a system-prompt prefix when
  // the user has any learned preferences. Empty string means no profile
  // yet → no flag → no overhead.
  //
  // v0.1.22: pass the user's message into renderForInjection so the
  // profile is relevance-filtered for THIS turn — load-bearing dimensions
  // (anti_patterns, communication_style) stay in scope; everything else
  // is ranked by lexical overlap and trimmed to a 12-line budget.
  // This is the Prism-shaped echo of LatentRAG's "don't pay for
  // context that isn't relevant to this query" — we can't joint-train
  // the LLM+retriever (claude is frozen on Anthropic's side), but we
  // can stop dumping irrelevant profile entries into every turn.
  // v0.1.29: project-level instructions (if the chat belongs to a
  // project) inject FIRST, ahead of the auto-profile. The user's
  // explicit project preferences take priority over learned ones.
  const projectInstructions = (params.projectInstructions ?? "").trim();
  if (projectInstructions.length > 0) {
    const wrapped = [
      "<!-- Prism project instructions: the user has set these for ",
      "all chats in this project. Treat them as authoritative for ",
      "this conversation. -->",
      "",
      projectInstructions,
    ].join("\n");
    args.push("--append-system-prompt", wrapped);
  }

  // v0.1.23: renderForInjection is now async so it can race the user-
  // message embedding against a 200ms timeout. Worst case (cold-start
  // model load) it falls back to lexical scoring — same path as
  // v0.1.22. Profile injection is the only thing that's awaited; the
  // rest of the spawn flow stays sync.
  const profileBlock = await renderForInjection(params.message);
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

/**
 * True parallel batch (v0.1.30) — finally honors Prism's tagline.
 *
 * Before this: `/batch` was a SKILL inside a single claude turn.
 * claude pretended to fan out via the Task tool, all from one
 * process. Not actually parallel; just a claude-side orchestrator.
 *
 * Now: Prism owns the orchestration. For N prompts, spawn N
 * independent `claude --print` processes concurrently, each with
 * its own auto-routed model. Stream their output back tagged by
 * agent index so the renderer can paint live progress per agent.
 * After all N return (or error / timeout), spawn ONE reconciler
 * with `--model haiku` that takes the N answers and synthesizes
 * a final coherent response — the reduce step that v0.2 backlog's
 * "Prism-side batch orchestrator" predicted.
 *
 * Failure modes:
 *  - Any agent erroring doesn't abort the batch. We render the
 *    error in that agent's card and continue.
 *  - Reconciler is skipped if 0 agents succeeded.
 *  - User can abort the whole batch with abortBatch(batchId).
 */
type BatchAgent = {
  index: number;
  prompt: string;
  proc: ChildProcess | null;
  buffer: string;
  finalText: string;
  errored: boolean;
  done: boolean;
  errorMsg?: string;
};

type Batch = {
  batchId: string;
  window: BrowserWindow;
  agents: BatchAgent[];
  reconcilerProc: ChildProcess | null;
  aborted: boolean;
};

const activeBatches = new Map<string, Batch>();

function buildBaseArgs(model: string | null): string[] {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  return args;
}

function augmentedEnvPath(): string {
  const HOME = process.env.HOME ?? "";
  return [
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
  ]
    .filter(Boolean)
    .join(":");
}

function spawnAgentProcess(
  claudeBin: string,
  args: string[],
  prompt: string,
): ChildProcess {
  const HOME = process.env.HOME ?? "";
  return spawn(claudeBin, [...args, prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: HOME || undefined,
    env: { ...process.env, PATH: augmentedEnvPath() },
  });
}

function sendBatch(params: {
  prompts: string[];
  model?: string;
  projectInstructions?: string | null;
  window: BrowserWindow;
}): { batchId: string } | { error: string } {
  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    return { error: "Claude CLI not found." };
  }
  const cleanPrompts = params.prompts
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (cleanPrompts.length === 0) {
    return { error: "No prompts in batch." };
  }
  const batchId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const agents: BatchAgent[] = cleanPrompts.map((prompt, index) => ({
    index,
    prompt,
    proc: null,
    buffer: "",
    finalText: "",
    errored: false,
    done: false,
  }));

  const batch: Batch = {
    batchId,
    window: params.window,
    agents,
    reconcilerProc: null,
    aborted: false,
  };
  activeBatches.set(batchId, batch);

  emit(params.window, "prism:batch:start", {
    batchId,
    promptCount: cleanPrompts.length,
    prompts: cleanPrompts,
  });

  const projectBlock = (params.projectInstructions ?? "").trim();
  // Spawn all agents in parallel
  for (const agent of agents) {
    // Per-agent auto-routing
    const tier =
      params.model && params.model !== "auto"
        ? params.model
        : routeModel(agent.prompt);
    const baseArgs = buildBaseArgs(tier);
    if (projectBlock) {
      baseArgs.push(
        "--append-system-prompt",
        [
          "<!-- Prism project instructions: authoritative for this conversation. -->",
          "",
          projectBlock,
        ].join("\n"),
      );
    }

    let proc: ChildProcess;
    try {
      proc = spawnAgentProcess(claudeBin, baseArgs, agent.prompt);
    } catch (e: any) {
      agent.errored = true;
      agent.errorMsg = `spawn failed: ${e?.message ?? String(e)}`;
      agent.done = true;
      emit(params.window, "prism:batch:agent:error", {
        batchId,
        index: agent.index,
        error: agent.errorMsg,
      });
      maybeStartReconciler(batch, claudeBin, params.projectInstructions ?? null);
      continue;
    }
    agent.proc = proc;
    emit(params.window, "prism:batch:agent:start", {
      batchId,
      index: agent.index,
      prompt: agent.prompt,
      tier,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (batch.aborted) return;
      agent.buffer += chunk.toString();
      let i: number;
      while ((i = agent.buffer.indexOf("\n")) >= 0) {
        const line = agent.buffer.slice(0, i);
        agent.buffer = agent.buffer.slice(i + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed.type === "assistant" && parsed.message?.content) {
          let combined = "";
          for (const b of parsed.message.content) {
            if (b.type === "text" && typeof b.text === "string") combined += b.text;
          }
          if (combined.length > agent.finalText.length) {
            const delta = combined.slice(agent.finalText.length);
            agent.finalText = combined;
            emit(params.window, "prism:batch:agent:delta", {
              batchId,
              index: agent.index,
              text: delta,
            });
          }
        }
        if (parsed.type === "result" && parsed.is_error) {
          const errs = Array.isArray(parsed.errors)
            ? parsed.errors.filter((e: unknown) => typeof e === "string").join("; ")
            : "";
          agent.errored = true;
          agent.errorMsg = errs || parsed.result || "claude error";
        }
      }
    });

    proc.on("close", (code) => {
      agent.done = true;
      if (!agent.errored && code !== 0) {
        agent.errored = true;
        agent.errorMsg = `claude exited with code ${code}`;
      }
      if (agent.errored) {
        emit(params.window, "prism:batch:agent:error", {
          batchId,
          index: agent.index,
          error: agent.errorMsg,
        });
      } else {
        emit(params.window, "prism:batch:agent:end", {
          batchId,
          index: agent.index,
          finalText: agent.finalText,
        });
      }
      maybeStartReconciler(batch, claudeBin, params.projectInstructions ?? null);
    });

    proc.on("error", (e) => {
      agent.errored = true;
      agent.errorMsg = `spawn error: ${e.message}`;
      agent.done = true;
      emit(params.window, "prism:batch:agent:error", {
        batchId,
        index: agent.index,
        error: agent.errorMsg,
      });
      maybeStartReconciler(batch, claudeBin, params.projectInstructions ?? null);
    });
  }

  return { batchId };
}

function maybeStartReconciler(
  batch: Batch,
  claudeBin: string,
  projectInstructions: string | null,
): void {
  if (batch.aborted) return;
  if (batch.reconcilerProc) return; // already started
  // Wait for ALL agents to finish (success or error)
  if (batch.agents.some((a) => !a.done)) return;

  const successful = batch.agents.filter((a) => !a.errored && a.finalText.trim().length > 0);
  if (successful.length === 0) {
    // Nothing to reconcile
    emit(batch.window, "prism:batch:end", {
      batchId: batch.batchId,
      reconciled: "",
      skippedReason: "all agents errored",
    });
    activeBatches.delete(batch.batchId);
    return;
  }

  // Build the reconciler prompt
  const sections = successful
    .map(
      (a) =>
        `### Prompt ${a.index + 1}: ${a.prompt}\n\nAgent ${a.index + 1} answered:\n${a.finalText.trim()}`,
    )
    .join("\n\n---\n\n");

  const reconcilerPrompt = `You are a reconciler. ${successful.length} parallel agents each answered a different prompt. Summarize their answers into a single coherent reply that addresses every prompt in order. Format with ## headings per prompt. Be concise — assume the agent answers are already correct; your job is presentation, not re-reasoning.

${sections}

Render the unified response now. No preamble.`;

  emit(batch.window, "prism:batch:reconcile:start", { batchId: batch.batchId });

  const args = buildBaseArgs("haiku");
  if (projectInstructions && projectInstructions.trim()) {
    args.push(
      "--append-system-prompt",
      [
        "<!-- Prism project instructions: authoritative for this conversation. -->",
        "",
        projectInstructions.trim(),
      ].join("\n"),
    );
  }

  let proc: ChildProcess;
  try {
    proc = spawnAgentProcess(claudeBin, args, reconcilerPrompt);
  } catch (e: any) {
    emit(batch.window, "prism:batch:end", {
      batchId: batch.batchId,
      reconciled: "",
      skippedReason: `reconciler spawn failed: ${e?.message ?? String(e)}`,
    });
    activeBatches.delete(batch.batchId);
    return;
  }
  batch.reconcilerProc = proc;

  let buffer = "";
  let finalText = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (batch.aborted) return;
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.type === "assistant" && parsed.message?.content) {
        let combined = "";
        for (const b of parsed.message.content) {
          if (b.type === "text" && typeof b.text === "string") combined += b.text;
        }
        if (combined.length > finalText.length) {
          const delta = combined.slice(finalText.length);
          finalText = combined;
          emit(batch.window, "prism:batch:reconcile:delta", {
            batchId: batch.batchId,
            text: delta,
          });
        }
      }
    }
  });

  proc.on("close", () => {
    emit(batch.window, "prism:batch:end", {
      batchId: batch.batchId,
      reconciled: finalText,
    });
    activeBatches.delete(batch.batchId);
  });
}

function abortBatch(batchId: string): { ok: boolean } {
  const batch = activeBatches.get(batchId);
  if (!batch) return { ok: false };
  batch.aborted = true;
  for (const agent of batch.agents) {
    try {
      agent.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  try {
    batch.reconcilerProc?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  activeBatches.delete(batchId);
  emit(batch.window, "prism:batch:end", {
    batchId,
    reconciled: "",
    skippedReason: "aborted",
  });
  return { ok: true };
}

export function registerClaudeClient(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("prism:chat:send", (_e, params: {
    message: string;
    model?: string;
    sessionId?: string | null;
    projectInstructions?: string | null;
  }) => {
    const window = getWindow();
    if (!window) return { error: "no window" };
    return send({ ...params, window });
  });

  ipcMain.handle("prism:chat:abort", (_e, params: { turnId: string }) => {
    return abort(params.turnId);
  });

  // v0.1.30: real parallel batch — N concurrent claude processes
  // + Haiku reconciler.
  ipcMain.handle(
    "prism:chat:sendBatch",
    (_e, params: {
      prompts: string[];
      model?: string;
      projectInstructions?: string | null;
    }) => {
      const window = getWindow();
      if (!window) return { error: "no window" };
      return sendBatch({ ...params, window });
    },
  );
  ipcMain.handle("prism:chat:abortBatch", (_e, params: { batchId: string }) => {
    return abortBatch(params.batchId);
  });

  ipcMain.handle("prism:chat:probe", () => {
    const bin = findClaudeBin();
    return { found: !!bin, path: bin };
  });
}
