/**
 * RTK (Rust Token Killer) integration — https://github.com/rtk-ai/rtk
 *
 * RTK is a CLI proxy that compresses verbose command output (git, find,
 * read, gcloud, etc.) before it reaches the LLM context, typically
 * saving 60–90% of tokens on dev operations. It works through a
 * Claude Code PreToolUse hook (matcher: "Bash") that rewrites the
 * Bash command on the fly. The hook lives in ~/.claude/settings.json.
 *
 * Prism's spawned claude inherits the same ~/.claude/ config that
 * powers MCPs and slash commands, so once the hook is in place RTK
 * works transparently in every Prism turn — no per-app wiring needed.
 *
 * This module surfaces three things to the renderer:
 *   1. Whether the rtk binary is on PATH
 *   2. Whether the Claude hook is enabled in settings.json
 *   3. Live token-savings stats from `rtk gain --format json`
 *
 * Plus a one-click "Enable hook" flow that patches settings.json in
 * place (with a timestamped backup), so users with rtk installed but
 * unhooked can light it up without touching JSON by hand.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import log from "electron-log";

const RTK_PATH_CANDIDATES = [
  "/usr/local/bin/rtk",
  "/opt/homebrew/bin/rtk",
  `${os.homedir()}/.cargo/bin/rtk`,
  `${os.homedir()}/.local/bin/rtk`,
];

function findRtkBin(): string | null {
  for (const p of RTK_PATH_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  // Fall back to PATH lookup via `which` — synchronous best-effort
  return null;
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

type ClaudeSettings = {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
  [key: string]: unknown;
};

function readSettings(): ClaudeSettings | null {
  const p = settingsPath();
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    log.warn("[rtk] failed to read settings.json", e);
    return null;
  }
}

/** Recognize an RTK Bash hook entry (any shape that calls `rtk hook`). */
function entryIsRtk(entry: { matcher?: string; hooks?: Array<{ command?: string }> }): boolean {
  if (entry.matcher !== "Bash") return false;
  for (const h of entry.hooks ?? []) {
    if (typeof h.command === "string" && /^\s*rtk\s+hook\b/.test(h.command)) {
      return true;
    }
  }
  return false;
}

export type RtkStatus = {
  /** rtk binary found on disk */
  installed: boolean;
  /** PreToolUse Bash hook calling `rtk hook claude` is in settings.json */
  hookEnabled: boolean;
  /** rtk --version, when available */
  version: string | null;
  /** rtk gain --format json (when installed) */
  stats: {
    totalCommands: number;
    totalSavedTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgSavingsPct: number;
    avgTimeMs: number;
  } | null;
  /** Human-readable error / install hint when not installed */
  hint?: string;
};

function spawnText(
  bin: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => (stdout += c.toString()));
    proc.stderr?.on("data", (c) => (stderr += c.toString()));
    proc.on("error", () => resolve({ code: -1, stdout, stderr }));
    proc.on("close", (code) =>
      resolve({ code: typeof code === "number" ? code : -1, stdout, stderr }),
    );
    setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  });
}

export async function getStatus(): Promise<RtkStatus> {
  const bin = findRtkBin();
  if (!bin) {
    return {
      installed: false,
      hookEnabled: false,
      version: null,
      stats: null,
      hint:
        "RTK isn't installed yet. Install instructions: https://github.com/rtk-ai/rtk — typically `cargo install rtk` or via Homebrew.",
    };
  }

  // Version
  const ver = await spawnText(bin, ["--version"]);
  const version = ver.code === 0 ? ver.stdout.trim() || null : null;

  // Hook detection
  const settings = readSettings();
  const entries = settings?.hooks?.PreToolUse ?? [];
  const hookEnabled = entries.some(entryIsRtk);

  // Stats — best-effort. JSON format added in recent rtk; fall back gracefully.
  let stats: RtkStatus["stats"] = null;
  const gainResult = await spawnText(bin, ["gain", "--format", "json"]);
  if (gainResult.code === 0) {
    try {
      const parsed = JSON.parse(gainResult.stdout);
      const s = parsed?.summary ?? {};
      stats = {
        totalCommands: Number(s.total_commands ?? 0),
        totalSavedTokens: Number(s.total_saved ?? 0),
        totalInputTokens: Number(s.total_input ?? 0),
        totalOutputTokens: Number(s.total_output ?? 0),
        avgSavingsPct: Number(s.avg_savings_pct ?? 0),
        avgTimeMs: Number(s.avg_time_ms ?? 0),
      };
    } catch (e) {
      log.info("[rtk] could not parse gain JSON", e);
    }
  }

  return {
    installed: true,
    hookEnabled,
    version,
    stats,
  };
}

/**
 * Patch ~/.claude/settings.json to add the PreToolUse → Bash → rtk hook.
 * Backs up the old file as settings.json.bak.<epoch> before writing.
 * Idempotent: returns ok:true with already_present:true when the hook
 * is already there.
 */
export function enableHook(): {
  ok: boolean;
  alreadyPresent?: boolean;
  backupPath?: string;
  error?: string;
} {
  const sp = settingsPath();
  let raw: string;
  let parsed: ClaudeSettings;
  try {
    if (!fs.existsSync(sp)) {
      // Create dir + empty settings.json
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      raw = "{}";
      parsed = {};
    } else {
      raw = fs.readFileSync(sp, "utf-8");
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") parsed = {};
    }
  } catch (e: any) {
    return { ok: false, error: `Failed to read settings.json: ${e?.message ?? e}` };
  }

  const existing = parsed.hooks?.PreToolUse ?? [];
  if (existing.some(entryIsRtk)) {
    return { ok: true, alreadyPresent: true };
  }

  // Backup BEFORE mutating
  let backupPath: string | undefined;
  try {
    if (fs.existsSync(sp)) {
      backupPath = `${sp}.bak.${Date.now()}`;
      fs.writeFileSync(backupPath, raw, "utf-8");
    }
  } catch (e: any) {
    return { ok: false, error: `Failed to back up settings.json: ${e?.message ?? e}` };
  }

  // Insert
  const newEntry = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "rtk hook claude" }],
  };
  parsed.hooks = parsed.hooks ?? {};
  parsed.hooks.PreToolUse = [...existing, newEntry];

  try {
    fs.writeFileSync(sp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  } catch (e: any) {
    return { ok: false, error: `Failed to write settings.json: ${e?.message ?? e}` };
  }

  return { ok: true, backupPath };
}
