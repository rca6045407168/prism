/**
 * Preload script — exposes a tiny safe API to the renderer.
 * No node access in the renderer; only what we explicitly expose here.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("flexhaul", {
  getGatewayConfig: () => ipcRenderer.invoke("flexhaul:getGatewayConfig"),
  getAppVersion: () => ipcRenderer.invoke("flexhaul:getAppVersion"),
  checkForUpdates: () => ipcRenderer.invoke("flexhaul:checkForUpdates"),
  onUpdateEvent: (event: string, cb: (payload: unknown) => void) => {
    const channel = `flexhaul:update:${event}`;
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Setup wizard (v0.1.2)
  setup: {
    status: () => ipcRenderer.invoke("prism:setup:status"),
    initialSteps: () => ipcRenderer.invoke("prism:setup:steps"),
    run: () => ipcRenderer.invoke("prism:setup:run"),
    onStep: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:setup:step", listener);
      return () => ipcRenderer.removeListener("prism:setup:step", listener);
    },
  },

  // Chat — spawns `claude` CLI per turn (v0.1.9)
  chat: {
    probe: () => ipcRenderer.invoke("prism:chat:probe"),
    send: (params: { message: string; model?: string; sessionId?: string | null }) =>
      ipcRenderer.invoke("prism:chat:send", params),
    abort: (turnId: string) => ipcRenderer.invoke("prism:chat:abort", { turnId }),
    onStart: (cb: (ev: { turnId: string; sessionId: string | null; model?: string }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:chat:start", listener);
      return () => ipcRenderer.removeListener("prism:chat:start", listener);
    },
    onDelta: (cb: (ev: { turnId: string; text: string }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:chat:delta", listener);
      return () => ipcRenderer.removeListener("prism:chat:delta", listener);
    },
    onEnd: (cb: (ev: { turnId: string; finalText: string; sessionId: string | null; durationMs?: number; cost?: number }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:chat:end", listener);
      return () => ipcRenderer.removeListener("prism:chat:end", listener);
    },
    onError: (cb: (ev: { turnId: string; error: string; sessionExpired?: boolean }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:chat:error", listener);
      return () => ipcRenderer.removeListener("prism:chat:error", listener);
    },
    // v0.1.18: live tool-progress events
    onTool: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:chat:tool", listener);
      return () => ipcRenderer.removeListener("prism:chat:tool", listener);
    },
  },

  // Slash commands / skills discovery (v0.1.18)
  commands: {
    list: () => ipcRenderer.invoke("prism:commands:list"),
    refresh: () => ipcRenderer.invoke("prism:commands:refresh"),
  },

  // RTK token saver (v0.1.19) — surfaces savings + hook health
  rtk: {
    status: () => ipcRenderer.invoke("prism:rtk:status"),
    enableHook: () => ipcRenderer.invoke("prism:rtk:enableHook"),
  },

  // Account / OAuth (v0.1.24) — local-only identity for the upcoming
  // license-check flow. PKCE OAuth via browser; no client_secret.
  account: {
    status: () => ipcRenderer.invoke("prism:account:status"),
    signIn: (provider: "google") =>
      ipcRenderer.invoke("prism:account:signIn", provider),
    signOut: () => ipcRenderer.invoke("prism:account:signOut"),
  },

  // Window controls + file uploads (v0.1.25)
  window: {
    setAlwaysOnTop: (pinned: boolean) =>
      ipcRenderer.invoke("prism:window:setAlwaysOnTop", pinned),
    isAlwaysOnTop: () => ipcRenderer.invoke("prism:window:isAlwaysOnTop"),
    isFocused: () => ipcRenderer.invoke("prism:window:isFocused"),
  },
  files: {
    save: (args: { chatId: string; fileName: string; dataBase64: string }) =>
      ipcRenderer.invoke("prism:files:save", args),
  },

  // Auto-profile (v0.1.17) — local-only, silent learning of user
  // preferences for a more personalized chat over time.
  profile: {
    get: () => ipcRenderer.invoke("prism:profile:get"),
    setPaused: (paused: boolean) =>
      ipcRenderer.invoke("prism:profile:setPaused", paused),
    removeEntry: (id: string) =>
      ipcRenderer.invoke("prism:profile:removeEntry", id),
    clearAll: () => ipcRenderer.invoke("prism:profile:clearAll"),
    onPending: (cb: (ev: { turnId: string }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:profile:pending", listener);
      return () => ipcRenderer.removeListener("prism:profile:pending", listener);
    },
  },
});

// Type declaration for the renderer to import
declare global {
  interface Window {
    flexhaul: {
      getGatewayConfig: () => Promise<{ url: string; token: string | null; error?: string }>;
      getAppVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        currentVersion: string;
        updateAvailable: boolean;
        latestVersion: string | null;
        error?: string;
      }>;
      onUpdateEvent: (
        event: "checking" | "available" | "not-available" | "progress" | "downloaded" | "error",
        cb: (payload: unknown) => void,
      ) => () => void;
      setup: {
        status: () => Promise<{
          runtimeInstalled: boolean;
          paired: boolean;
          daemonReachable: Promise<boolean> | boolean;
        }>;
        initialSteps: () => Promise<
          Array<{ id: string; label: string; status: "pending" | "running" | "ok" | "error" | "needs-action" }>
        >;
        run: () => Promise<{ ok: boolean; error?: string }>;
        onStep: (
          cb: (ev: {
            id: string;
            label: string;
            status: "pending" | "running" | "ok" | "error" | "needs-action";
            detail?: string;
            actionUrl?: string;
          }) => void,
        ) => () => void;
      };
    };
  }
}
