/**
 * Global type augmentations visible to the renderer's tsconfig.
 *
 * The actual `flexhaul` API is created by electron/preload.ts at runtime;
 * we only need TypeScript to know its shape here.
 */

type SetupStepStatus = "pending" | "running" | "ok" | "error" | "needs-action";

type ProfileDimension =
  | "communication_style"
  | "role_context"
  | "tooling"
  | "naming"
  | "decision_style"
  | "project_focus"
  | "anti_patterns"
  | "knowledge";

type ProfileEntry = {
  id: string;
  dimension: ProfileDimension;
  claim: string;
  confidence: number;
  evidence?: string;
  source_turn?: string;
  added_at: string;
};

type ProfileData = {
  version: 1;
  learning_paused: boolean;
  entries: ProfileEntry[];
  turns_seen: number;
  updated_at: string;
};

type DiscoveredCommand = {
  name: string;
  description: string;
  source: "command" | "skill";
  filePath: string;
};

type RtkStatus = {
  installed: boolean;
  hookEnabled: boolean;
  version: string | null;
  stats: {
    totalCommands: number;
    totalSavedTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgSavingsPct: number;
    avgTimeMs: number;
  } | null;
  hint?: string;
};

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
      chat: {
        probe: () => Promise<{ found: boolean; path: string | null }>;
        send: (params: {
          message: string;
          model?: string;
          sessionId?: string | null;
        }) => Promise<{ turnId: string } | { error: string }>;
        abort: (turnId: string) => Promise<{ ok: boolean }>;
        onStart: (
          cb: (ev: {
            turnId: string;
            sessionId: string | null;
            model?: string;
          }) => void,
        ) => () => void;
        onDelta: (cb: (ev: { turnId: string; text: string }) => void) => () => void;
        onEnd: (
          cb: (ev: {
            turnId: string;
            finalText: string;
            sessionId: string | null;
            durationMs?: number;
            cost?: number;
          }) => void,
        ) => () => void;
        onError: (
          cb: (ev: { turnId: string; error: string; sessionExpired?: boolean }) => void,
        ) => () => void;
        onTool: (
          cb: (ev: {
            turnId: string;
            phase: "use" | "result";
            toolUseId: string;
            name?: string;
            inputPreview?: string;
            isError?: boolean;
            resultPreview?: string;
          }) => void,
        ) => () => void;
      };
      profile: {
        get: () => Promise<ProfileData>;
        setPaused: (paused: boolean) => Promise<ProfileData>;
        removeEntry: (id: string) => Promise<ProfileData>;
        clearAll: () => Promise<ProfileData>;
        onPending: (cb: (ev: { turnId: string }) => void) => () => void;
      };
      commands: {
        list: () => Promise<DiscoveredCommand[]>;
        refresh: () => Promise<DiscoveredCommand[]>;
      };
      rtk: {
        status: () => Promise<RtkStatus>;
        enableHook: () => Promise<{
          ok: boolean;
          alreadyPresent?: boolean;
          backupPath?: string;
          error?: string;
        }>;
      };
    };
  }
}

export {};
