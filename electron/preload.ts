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
