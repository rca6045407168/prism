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
    };
  }
}
