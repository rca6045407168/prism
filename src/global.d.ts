/**
 * Global type augmentations visible to the renderer's tsconfig.
 *
 * The actual `flexhaul` API is created by electron/preload.ts at runtime;
 * we only need TypeScript to know its shape here.
 */

type SetupStepStatus = "pending" | "running" | "ok" | "error" | "needs-action";

declare global {
  interface Window {
    flexhaul: {
      getGatewayConfig: () => Promise<{
        url: string;
        token: string | null;
        error?: string;
      }>;
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
          daemonReachable: boolean;
        }>;
        initialSteps: () => Promise<
          Array<{ id: string; label: string; status: SetupStepStatus }>
        >;
        run: () => Promise<{ ok: boolean; error?: string }>;
        onStep: (
          cb: (ev: {
            id: string;
            label: string;
            status: SetupStepStatus;
            detail?: string;
            actionUrl?: string;
          }) => void,
        ) => () => void;
      };
    };
  }
}

export {};
