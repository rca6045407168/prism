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

type Account = {
  version: 1;
  provider: "google";
  email: string;
  name: string;
  picture?: string;
  signedInAt: string;
};

type AccountStatus = {
  account: Account | null;
  providers: {
    google: { configured: boolean };
  };
};

type McpServerInfo = {
  name: string;
  status: "connected" | "failed";
  toolCount: number;
};

type McpStatus = {
  servers: McpServerInfo[];
  totalTools: number;
  mcpTools: number;
  capturedAt: number;
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

type ProvenanceVaultHit = {
  relPath: string;
  title: string;
  score: number;
  source: "embed" | "graph-walk";
  pathFromQuery: string[];
  snippet: string;
  why: string;
};

type ProvenanceMemoryHit = {
  file: string;
  title: string;
  type: "user" | "feedback" | "project" | "reference" | "unknown";
  why: string;
};

type Commitment = {
  id: string;
  text: string;
  verb: string;
  deadline?: string;
  deadlineIso?: string;
  counterparty?: string;
  capturedAt: number;
  chatId?: string;
  turnId?: string;
  resolved?: boolean;
  outcome?: string;
  resolvedAt?: number;
  vaultRelPath?: string;
};

type ProvenanceCommitmentHit = {
  id: string;
  verb: string;
  text: string;
  capturedAt: number;
  resolved: boolean;
  outcome?: string;
  counterparty?: string;
  deadlineIso?: string;
  vaultRelPath?: string;
  score: number;
  why: string;
};

type ProvenanceTrace = {
  turnId: string;
  queryText: string;
  generatedAtMs: number;
  durationMs: number;
  vaultHits: ProvenanceVaultHit[];
  memoryHits: ProvenanceMemoryHit[];
  commitmentHits?: ProvenanceCommitmentHit[];
  notes: string[];
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
      installUpdate: () => Promise<{ ok: boolean; error?: string }>;
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
          projectInstructions?: string | null;
          permissionMode?: "ask" | "preview" | "bypass";
        }) => Promise<{ turnId: string } | { error: string }>;
        abort: (turnId: string) => Promise<{ ok: boolean }>;
        generateTitle: (params: {
          userMessage: string;
          assistantPreview: string;
        }) => Promise<{ title: string }>;
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
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            model?: string | null;
            previewSnapshot?: {
              id: string;
              fullName: string;
              createdAt: number;
            };
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
            startedAt?: number;
          }) => void,
        ) => () => void;
        // v0.1.30: true parallel batch
        sendBatch: (params: {
          prompts: string[];
          model?: string;
          projectInstructions?: string | null;
          permissionMode?: "ask" | "preview" | "bypass";
        }) => Promise<{ batchId: string } | { error: string }>;
        abortBatch: (batchId: string) => Promise<{ ok: boolean }>;
        sendThink: (params: {
          prompt: string;
          attempts?: number;
          model?: string;
          projectInstructions?: string | null;
          permissionMode?: "ask" | "preview" | "bypass";
        }) => Promise<{ batchId: string } | { error: string }>;
        onBatchStart: (cb: (ev: { batchId: string; promptCount: number; prompts: string[] }) => void) => () => void;
        onBatchAgentStart: (cb: (ev: { batchId: string; index: number; prompt: string; tier: string }) => void) => () => void;
        onBatchAgentDelta: (cb: (ev: { batchId: string; index: number; text: string }) => void) => () => void;
        onBatchAgentEnd: (cb: (ev: { batchId: string; index: number; finalText: string }) => void) => () => void;
        onBatchAgentError: (cb: (ev: { batchId: string; index: number; error: string }) => void) => () => void;
        onBatchReconcileStart: (cb: (ev: { batchId: string }) => void) => () => void;
        onBatchReconcileDelta: (cb: (ev: { batchId: string; text: string }) => void) => () => void;
        onBatchEnd: (cb: (ev: { batchId: string; reconciled: string; skippedReason?: string }) => void) => () => void;
      };
      profile: {
        get: () => Promise<ProfileData>;
        setPaused: (paused: boolean) => Promise<ProfileData>;
        removeEntry: (id: string) => Promise<ProfileData>;
        clearAll: () => Promise<ProfileData>;
        onPending: (cb: (ev: { turnId: string }) => void) => () => void;
        extractWithFeedback?: (params: {
          userMessage: string;
          assistantText: string;
          feedback: "up" | "down";
        }) => Promise<{ ok: boolean; error?: string }>;
      };
      mcp: {
        status: () => Promise<McpStatus | null>;
        onStatus: (cb: (s: McpStatus) => void) => () => void;
      };
      preview: {
        listChanged: (snapshotId: string, scope?: string) => Promise<
          | { files: Array<{ path: string; mtime: number; size: number; likelyNew: boolean }> }
          | { error: string }
        >;
        revertFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      };
      session: {
        record: (params: {
          chatId: string;
          title: string;
          userMessages: string[];
          assistantMessages: string[];
          projectId: string | null;
        }) => Promise<
          | {
              ok: true;
              record: {
                chatId: string;
                title: string;
                summary: string;
                projectId: string | null;
                createdAt: number;
                updatedAt: number;
              };
            }
          | { ok: false; error: string }
        >;
        recall: (params: {
          queryText: string;
          excludeChatId?: string;
          projectId?: string | null;
          limit?: number;
        }) => Promise<{
          hits: Array<{
            chatId: string;
            title: string;
            summary: string;
            score: number;
            projectId: string | null;
            updatedAt: number;
          }>;
          error?: string;
        }>;
      };
      vault: {
        list: () => Promise<
          | {
              ok: true;
              vaultRoot: string;
              notes: Array<{
                title: string;
                relPath: string;
                absPath: string;
                mtimeMs: number;
              }>;
            }
          | { ok: false; error: string }
        >;
        readNote: (params: { relPath: string }) => Promise<
          | { ok: true; text: string; absPath: string }
          | { ok: false; error: string }
        >;
        saveTurn: (params: {
          chatId: string;
          chatTitle: string;
          userText: string;
          assistantText: string;
          model?: string | null;
          redact?: boolean;
        }) => Promise<
          | { ok: true; absPath: string; relPath: string; vaultRoot: string }
          | { ok: false; error: string }
        >;
        openInObsidian: (params: { relPath: string }) => Promise<
          { ok: true; uri: string } | { ok: false; error: string }
        >;
        getRoot: () => Promise<{
          path: string;
          exists: boolean;
          hasObsidianFolder: boolean;
          noteCount: number;
        }>;
        setRoot: (
          path: string,
        ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
        pickFolder: () => Promise<
          | {
              ok: true;
              path: string;
              exists: boolean;
              hasObsidianFolder: boolean;
              noteCount: number;
            }
          | { ok: false; canceled?: boolean; error?: string }
        >;
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
      providers: {
        detectOllama: () => Promise<
          | {
              installed: true;
              running: boolean;
              version?: string;
              models?: Array<{ name: string; size?: number; family?: string }>;
              endpoint?: string;
            }
          | { installed: false; reason: string; hint?: string }
        >;
      };
      clipboard: {
        write: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      };
      scheduled: {
        list: () => Promise<{
          jobs: Array<{
            label: string;
            plistPath: string;
            program?: string;
            programArguments?: string[];
            scheduleSummary: string;
            loaded: boolean;
            enabled: boolean;
          }>;
          dir: string;
        }>;
      };
      provenance: {
        gather: (params: { turnId: string; queryText: string }) => Promise<ProvenanceTrace>;
        onTrace: (
          cb: (ev: { turnId: string; trace: ProvenanceTrace }) => void,
        ) => () => void;
      };
      commitments: {
        extract: (params: { text: string; chatId?: string; turnId?: string }) => Promise<Commitment[]>;
        persist: (
          commitment: Commitment,
        ) => Promise<
          { ok: true; absPath: string; relPath: string } | { ok: false; error: string }
        >;
        list: () => Promise<Commitment[]>;
        resolve: (params: {
          id: string;
          outcome: string;
        }) => Promise<{ ok: true; commitment: Commitment } | { ok: false; error: string }>;
      };
      account: {
        status: () => Promise<AccountStatus>;
        signIn: (
          provider: "google",
        ) => Promise<{ ok: true; account: Account } | { ok: false; error: string }>;
        signOut: () => Promise<{ ok: boolean }>;
      };
      window: {
        setAlwaysOnTop: (pinned: boolean) => Promise<{ ok: boolean; pinned: boolean }>;
        isAlwaysOnTop: () => Promise<{ pinned: boolean }>;
        isFocused: () => Promise<{ focused: boolean }>;
      };
      files: {
        save: (args: {
          chatId: string;
          fileName: string;
          dataBase64: string;
        }) => Promise<
          | { ok: true; path: string; sizeBytes: number }
          | { ok: false; error: string }
        >;
      };
    };
  }
}

export {};
