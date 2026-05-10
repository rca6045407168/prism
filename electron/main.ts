/**
 * Prism — Electron main process.
 *
 * Responsibilities:
 *  - Open the chat window (loads the Vite-built React UI).
 *  - Discover the local Prism runtime (the agent daemon) — currently
 *    looks at the legacy ~/.openclaw/ pair file (the runtime is forked
 *    from OpenClaw upstream; we will rename the on-disk paths to
 *    ~/.prism/ in v0.2 once the auto-installer is in place).
 *  - Bridge those secrets to the renderer via ipcMain so the UI never
 *    has to read filesystem.
 *  - Run electron-updater on launch — checks GitHub Releases, prompts on
 *    update available, downloads in background, restarts to apply.
 */
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { registerSetup } from "./setup";
import { registerClaudeClient } from "./claude-client";
import {
  loadProfile,
  setLearningPaused,
  removeEntry,
  clearAll,
} from "./profile-store";
import { listCommands, refreshCommandsCache } from "./commands";
import { getStatus as getRtkStatus, enableHook as enableRtkHook } from "./rtk";
import { signIn as oauthSignIn, isProviderConfigured } from "./oauth";
import {
  loadAccount,
  saveAccount,
  clear as clearAccount,
  type Account,
} from "./account-store";

// ---------- logging ----------
log.transports.file.level = "info";
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// ---------- gateway secret discovery ----------

function gatewayConfig(): { url: string; token: string | null; error?: string } {
  const url = "ws://127.0.0.1:18789";
  // Runtime pair file is currently still at the legacy ~/.openclaw/ path.
  // v0.2 auto-installer will move it to ~/.prism/.
  const pairedPath = path.join(os.homedir(), ".openclaw", "devices", "paired.json");
  if (!fs.existsSync(pairedPath)) {
    return {
      url,
      token: null,
      error:
        "Prism runtime not yet installed. The first-launch installer will set it up automatically in v0.1.1 — for v0.1, please reach out for manual setup steps.",
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(pairedPath, "utf-8"));
    for (const dev of Object.values(data) as Array<Record<string, any>>) {
      if (dev?.role === "operator" && dev?.tokens?.operator?.token) {
        return { url, token: String(dev.tokens.operator.token) };
      }
    }
    return {
      url,
      token: null,
      error: "Paired device file present but no operator token found.",
    };
  } catch (e: any) {
    return { url, token: null, error: `Failed to read paired.json: ${e.message ?? e}` };
  }
}

// ---------- window ----------

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    title: "Prism",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Open external links in user's browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------- ipc bridge ----------

ipcMain.handle("flexhaul:getGatewayConfig", () => gatewayConfig());
ipcMain.handle("flexhaul:getAppVersion", () => app.getVersion());

// ---------- profile (auto-memory, v0.1.17) ----------
ipcMain.handle("prism:profile:get", () => loadProfile());
ipcMain.handle("prism:profile:setPaused", (_e, paused: boolean) => {
  setLearningPaused(!!paused);
  return loadProfile();
});
ipcMain.handle("prism:profile:removeEntry", (_e, id: string) => {
  removeEntry(String(id));
  return loadProfile();
});
ipcMain.handle("prism:profile:clearAll", () => {
  clearAll();
  return loadProfile();
});

// ---------- slash commands / skills (v0.1.18) ----------
ipcMain.handle("prism:commands:list", () => listCommands());
ipcMain.handle("prism:commands:refresh", () => {
  refreshCommandsCache();
  return listCommands();
});

// ---------- RTK token saver (v0.1.19) ----------
ipcMain.handle("prism:rtk:status", () => getRtkStatus());
ipcMain.handle("prism:rtk:enableHook", () => enableRtkHook());

// ---------- Window controls (v0.1.25) ----------
ipcMain.handle("prism:window:setAlwaysOnTop", (_e, pinned: boolean) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!pinned, "floating");
  return { ok: true, pinned: !!pinned };
});
ipcMain.handle("prism:window:isAlwaysOnTop", () => {
  return { pinned: mainWindow?.isAlwaysOnTop() ?? false };
});
ipcMain.handle("prism:window:isFocused", () => {
  return { focused: mainWindow?.isFocused() ?? false };
});

// ---------- File uploads (v0.1.25) ----------
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB hard cap
ipcMain.handle(
  "prism:files:save",
  (
    _e,
    args: {
      chatId: string;
      fileName: string;
      dataBase64: string;
    },
  ): { ok: true; path: string; sizeBytes: number } | { ok: false; error: string } => {
    try {
      const buf = Buffer.from(args.dataBase64, "base64");
      if (buf.byteLength > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          error: `File too large: ${Math.round(buf.byteLength / 1024 / 1024)}MB > 10MB cap`,
        };
      }
      const safeChatId = args.chatId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      const safeName = args.fileName
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-100); // keep extension at the tail
      const dir = path.join(app.getPath("userData"), "uploads", safeChatId);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-${safeName}`);
      fs.writeFileSync(dest, buf);
      return { ok: true, path: dest, sizeBytes: buf.byteLength };
    } catch (e: any) {
      log.warn("[files] save failed", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
);

// ---------- Account / OAuth (v0.1.24) ----------
ipcMain.handle("prism:account:status", () => {
  const account = loadAccount();
  return {
    account,
    providers: {
      google: { configured: isProviderConfigured("google") },
    },
  };
});
ipcMain.handle("prism:account:signIn", async (_e, provider: "google") => {
  try {
    const result = await oauthSignIn(provider);
    const account: Account = {
      version: 1,
      provider: result.provider,
      email: result.email,
      name: result.name,
      picture: result.picture,
      signedInAt: result.signedInAt,
    };
    saveAccount(account);
    return { ok: true, account };
  } catch (e: any) {
    log.warn("[account] sign-in failed", e?.message ?? e);
    return { ok: false, error: e?.message ?? String(e) };
  }
});
ipcMain.handle("prism:account:signOut", () => {
  clearAccount();
  return { ok: true };
});
ipcMain.handle("flexhaul:checkForUpdates", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      currentVersion: app.getVersion(),
      updateAvailable: !!result?.updateInfo && result.updateInfo.version !== app.getVersion(),
      latestVersion: result?.updateInfo?.version ?? null,
    };
  } catch (e: any) {
    return { error: e.message ?? String(e) };
  }
});

// ---------- auto-update events relayed to UI ----------

function emitUpdate(event: string, payload?: unknown) {
  log.info(`[updater] ${event}`, payload ?? "");
  mainWindow?.webContents.send(`flexhaul:update:${event}`, payload);
}

autoUpdater.on("checking-for-update", () => emitUpdate("checking"));
autoUpdater.on("update-available", (info) => emitUpdate("available", info));
autoUpdater.on("update-not-available", (info) => emitUpdate("not-available", info));
autoUpdater.on("download-progress", (p) => emitUpdate("progress", p));
autoUpdater.on("update-downloaded", (info) => emitUpdate("downloaded", info));
autoUpdater.on("error", (err) => emitUpdate("error", String(err)));

// ---------- menu ----------

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Check for Updates…",
                click: () => autoUpdater.checkForUpdatesAndNotify(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? ([{ type: "separator" }, { role: "front" }] as Electron.MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Prism on GitHub",
          click: () => shell.openExternal("https://github.com/rca6045407168/prism"),
        },
        {
          label: "Report an Issue",
          click: () =>
            shell.openExternal("https://github.com/rca6045407168/prism/issues/new"),
        },
        {
          label: "Credits",
          click: () =>
            shell.openExternal(
              "https://github.com/rca6045407168/prism/blob/main/ATTRIBUTION.md",
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  registerSetup(() => mainWindow);
  registerClaudeClient(() => mainWindow);

  // Kick off update check 5s after launch (non-blocking)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn("update check failed", e));
  }, 5000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
