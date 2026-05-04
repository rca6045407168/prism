/**
 * First-launch runtime installer.
 *
 * Detects whether the agent runtime is present and reachable. If not,
 * walks through automated install steps and reports progress to the
 * renderer via IPC events.
 *
 * Steps:
 *   1. detect-brew      → ensure /opt/homebrew/bin/brew or /usr/local/bin/brew exists
 *   2. install-runtime  → brew install openclaw  (skip if already installed)
 *   3. start-daemon     → load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
 *                         (created by `openclaw configure` — see step 4)
 *   4. pair-device      → open the pair URL in the user's browser; user clicks
 *                         Approve once; setup completes when paired.json exists
 *
 * Each step emits prism:setup:step events. The UI is purely a viewer.
 */
import { ipcMain, BrowserWindow, shell } from "electron";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";

type StepStatus = "pending" | "running" | "ok" | "error" | "needs-action";

export type SetupStepEvent = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  actionUrl?: string; // if needs-action, where to send the user
};

const STEPS = [
  { id: "detect-brew", label: "Checking for Homebrew" },
  { id: "install-runtime", label: "Installing Prism runtime" },
  { id: "start-daemon", label: "Starting Prism runtime" },
  { id: "pair-device", label: "Approving this device" },
] as const;

const PAIR_FILE = path.join(os.homedir(), ".openclaw", "devices", "paired.json");
const GATEWAY_PORT = 18789;
const GATEWAY_HOST = "127.0.0.1";

function brewPath(): string | null {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runtimeInstalled(): boolean {
  // Either brew package present, or the binary exists somewhere on PATH
  const possible = [
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/Users/" + os.userInfo().username + "/.npm-global/bin/openclaw",
  ];
  return possible.some((p) => fs.existsSync(p));
}

async function portReachable(port: number, host: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}

function pairFileExists(): boolean {
  if (!fs.existsSync(PAIR_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(PAIR_FILE, "utf-8"));
    return Object.values(data).some(
      (d: any) => d?.role === "operator" && d?.tokens?.operator?.token,
    );
  } catch {
    return false;
  }
}

function emit(window: BrowserWindow, ev: SetupStepEvent) {
  window.webContents.send("prism:setup:step", ev);
}

function runCmd(
  cmd: string,
  args: string[],
  onChunk?: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const pipe = (stream: NodeJS.ReadableStream) => {
      stream.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        output += s;
        if (onChunk) onChunk(s);
      });
    };
    pipe(child.stdout!);
    pipe(child.stderr!);
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
    child.on("error", () => resolve({ code: -1, output }));
  });
}

async function waitForPort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portReachable(port, host)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForPairFile(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pairFileExists()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Public entry — register IPC handlers and run setup if needed.
 * Called once from main.ts at app-ready.
 */
export function registerSetup(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("prism:setup:status", () => ({
    runtimeInstalled: runtimeInstalled(),
    paired: pairFileExists(),
    daemonReachable: portReachable(GATEWAY_PORT, GATEWAY_HOST),
  }));

  ipcMain.handle("prism:setup:run", async () => {
    const window = getWindow();
    if (!window) return { ok: false, error: "no window" };

    // Step 1: detect brew
    emit(window, { id: "detect-brew", label: STEPS[0].label, status: "running" });
    const brew = brewPath();
    if (!brew) {
      emit(window, {
        id: "detect-brew",
        label: STEPS[0].label,
        status: "error",
        detail:
          "Homebrew not found. Install it from https://brew.sh first, then restart Prism.",
        actionUrl: "https://brew.sh",
      });
      return { ok: false, error: "no brew" };
    }
    emit(window, {
      id: "detect-brew",
      label: STEPS[0].label,
      status: "ok",
      detail: brew,
    });

    // Step 2: install runtime (skip if already there)
    emit(window, { id: "install-runtime", label: STEPS[1].label, status: "running" });
    if (runtimeInstalled()) {
      emit(window, {
        id: "install-runtime",
        label: STEPS[1].label,
        status: "ok",
        detail: "Already installed.",
      });
    } else {
      const inst = await runCmd(
        brew,
        ["install", "openclaw"],
        (chunk) => {
          // Stream tail of brew output as a 'detail' to the UI for transparency
          const tail = chunk.split("\n").filter(Boolean).slice(-1)[0];
          if (tail) {
            emit(window, {
              id: "install-runtime",
              label: STEPS[1].label,
              status: "running",
              detail: tail.slice(0, 100),
            });
          }
        },
      );
      if (inst.code !== 0) {
        emit(window, {
          id: "install-runtime",
          label: STEPS[1].label,
          status: "error",
          detail: `brew install failed (exit ${inst.code}). Check Console for details.`,
        });
        return { ok: false, error: "brew install failed", output: inst.output };
      }
      emit(window, {
        id: "install-runtime",
        label: STEPS[1].label,
        status: "ok",
      });
    }

    // Step 3: ensure daemon is running. Try the launchd plist first; fall back
    // to a direct spawn (without launchd persistence — fine for first launch).
    emit(window, { id: "start-daemon", label: STEPS[2].label, status: "running" });
    if (await portReachable(GATEWAY_PORT, GATEWAY_HOST)) {
      emit(window, {
        id: "start-daemon",
        label: STEPS[2].label,
        status: "ok",
        detail: "Already running.",
      });
    } else {
      // First-time setup: invoke openclaw configure once. This is interactive
      // in upstream — we can't skip user click on browser pair page. We just
      // start the gateway directly and surface the pair URL in step 4.
      const openclawBin = ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"].find(
        (p) => fs.existsSync(p),
      )!;
      // Spawn daemon detached so it survives this app's lifetime
      const daemon = spawn(openclawBin, ["gateway", "--port", String(GATEWAY_PORT)], {
        detached: true,
        stdio: "ignore",
      });
      daemon.unref();
      const ok = await waitForPort(GATEWAY_PORT, GATEWAY_HOST, 30_000);
      if (!ok) {
        emit(window, {
          id: "start-daemon",
          label: STEPS[2].label,
          status: "error",
          detail: "Daemon did not start within 30s.",
        });
        return { ok: false, error: "daemon timeout" };
      }
      emit(window, { id: "start-daemon", label: STEPS[2].label, status: "ok" });
    }

    // Step 4: pair device. If already paired, done. Otherwise direct user.
    if (pairFileExists()) {
      emit(window, {
        id: "pair-device",
        label: STEPS[3].label,
        status: "ok",
        detail: "Device already paired.",
      });
      return { ok: true };
    }
    const pairUrl = `http://${GATEWAY_HOST}:${GATEWAY_PORT}/__openclaw__/control-ui/`;
    emit(window, {
      id: "pair-device",
      label: STEPS[3].label,
      status: "needs-action",
      detail: "Click 'Approve' in the browser window that just opened.",
      actionUrl: pairUrl,
    });
    shell.openExternal(pairUrl);

    const paired = await waitForPairFile(120_000);
    if (!paired) {
      emit(window, {
        id: "pair-device",
        label: STEPS[3].label,
        status: "error",
        detail:
          "Timed out waiting for device approval. Re-open the browser and click Approve, then restart Prism.",
        actionUrl: pairUrl,
      });
      return { ok: false, error: "pair timeout" };
    }
    emit(window, { id: "pair-device", label: STEPS[3].label, status: "ok" });
    return { ok: true };
  });

  ipcMain.handle("prism:setup:steps", () =>
    STEPS.map((s) => ({ id: s.id, label: s.label, status: "pending" as StepStatus })),
  );
}
