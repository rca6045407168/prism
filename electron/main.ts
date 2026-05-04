/**
 * FlexHaul Agent — Electron main process.
 *
 * Responsibilities:
 *  - Open the chat window (loads the Vite-built React UI).
 *  - Read OpenClaw gateway URL + operator token from local install
 *    (~/.openclaw/devices/paired.json + http://127.0.0.1:18789).
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

// ---------- logging ----------
log.transports.file.level = "info";
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// ---------- gateway secret discovery ----------

function gatewayConfig(): { url: string; token: string | null; error?: string } {
  const url = "ws://127.0.0.1:18789";
  const pairedPath = path.join(os.homedir(), ".openclaw", "devices", "paired.json");
  if (!fs.existsSync(pairedPath)) {
    return {
      url,
      token: null,
      error:
        "OpenClaw not installed (no ~/.openclaw/devices/paired.json). " +
        "Install OpenClaw first: brew install openclaw && openclaw configure",
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
    title: "FlexHaul Agent",
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
          label: "OpenClaw on GitHub",
          click: () => shell.openExternal("https://github.com/openclaw/openclaw"),
        },
        {
          label: "FlexHaul Agent on GitHub",
          click: () => shell.openExternal("https://github.com/rca6045407168/flexhaul-agent"),
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
