/**
 * Preload script — exposes a tiny safe API to the renderer.
 * No node access in the renderer; only what we explicitly expose here.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("flexhaul", {
  getGatewayConfig: () => ipcRenderer.invoke("flexhaul:getGatewayConfig"),
  getAppVersion: () => ipcRenderer.invoke("flexhaul:getAppVersion"),
  checkForUpdates: () => ipcRenderer.invoke("flexhaul:checkForUpdates"),
  installUpdate: () => ipcRenderer.invoke("flexhaul:installUpdate"),
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
    send: (params: {
      message: string;
      model?: string;
      sessionId?: string | null;
      projectInstructions?: string | null;
      permissionMode?: "ask" | "preview" | "bypass";
    }) => ipcRenderer.invoke("prism:chat:send", params),
    abort: (turnId: string) => ipcRenderer.invoke("prism:chat:abort", { turnId }),
    // v0.1.33: ask haiku for a short title summarizing this exchange
    generateTitle: (params: { userMessage: string; assistantPreview: string }) =>
      ipcRenderer.invoke("prism:chat:generateTitle", params),
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
    onEnd: (cb: (ev: { turnId: string; finalText: string; sessionId: string | null; durationMs?: number; cost?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; model?: string | null; previewSnapshot?: { id: string; fullName: string; createdAt: number } }) => void) => {
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
    // v0.1.30: true parallel batch
    sendBatch: (params: {
      prompts: string[];
      model?: string;
      projectInstructions?: string | null;
      permissionMode?: "ask" | "preview" | "bypass";
    }) => ipcRenderer.invoke("prism:chat:sendBatch", params),
    abortBatch: (batchId: string) =>
      ipcRenderer.invoke("prism:chat:abortBatch", { batchId }),
    // v0.1.36: /think — best-of-N at the same prompt + haiku reranker
    sendThink: (params: {
      prompt: string;
      attempts?: number;
      model?: string;
      projectInstructions?: string | null;
      permissionMode?: "ask" | "preview" | "bypass";
    }) => ipcRenderer.invoke("prism:chat:sendThink", params),
    onBatchStart: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:start", listener);
      return () => ipcRenderer.removeListener("prism:batch:start", listener);
    },
    onBatchAgentStart: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:agent:start", listener);
      return () => ipcRenderer.removeListener("prism:batch:agent:start", listener);
    },
    onBatchAgentDelta: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:agent:delta", listener);
      return () => ipcRenderer.removeListener("prism:batch:agent:delta", listener);
    },
    onBatchAgentEnd: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:agent:end", listener);
      return () => ipcRenderer.removeListener("prism:batch:agent:end", listener);
    },
    onBatchAgentError: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:agent:error", listener);
      return () => ipcRenderer.removeListener("prism:batch:agent:error", listener);
    },
    onBatchReconcileStart: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:reconcile:start", listener);
      return () =>
        ipcRenderer.removeListener("prism:batch:reconcile:start", listener);
    },
    onBatchReconcileDelta: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:reconcile:delta", listener);
      return () =>
        ipcRenderer.removeListener("prism:batch:reconcile:delta", listener);
    },
    onBatchEnd: (cb: (ev: any) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:batch:end", listener);
      return () => ipcRenderer.removeListener("prism:batch:end", listener);
    },
  },

  // v0.1.45: Preview-mode diff + revert. Lists files modified since
  // the last Preview-mode snapshot was taken; lets the user revert a
  // specific file back to its pre-turn state. Scoped to $HOME only.
  preview: {
    listChanged: (snapshotId: string, scope?: string) =>
      ipcRenderer.invoke("prism:preview:listChanged", { snapshotId, scope }),
    revertFile: (filePath: string) =>
      ipcRenderer.invoke("prism:preview:revertFile", { path: filePath }),
  },

  // MCP server inspection (v0.1.37) — surfaces what's connected to the
  // user's claude CLI so they can see + manage InsForge / other servers
  // without editing ~/.claude.json by hand.
  mcp: {
    status: () => ipcRenderer.invoke("prism:mcp:status"),
    onStatus: (cb: (s: any) => void) => {
      const listener = (_: unknown, s: any) => cb(s);
      ipcRenderer.on("prism:mcp:status", listener);
      return () => ipcRenderer.removeListener("prism:mcp:status", listener);
    },
  },

  // Obsidian vault integration (v0.1.40) — shared knowledge graph
  // between Prism and Obsidian. List/read for [[<title>]] autocomplete,
  // save-turn for ⌘⇧S, open-in-Obsidian for clickable wikilinks.
  vault: {
    list: () => ipcRenderer.invoke("prism:vault:list"),
    readNote: (params: { relPath: string }) =>
      ipcRenderer.invoke("prism:vault:readNote", params),
    saveTurn: (params: {
      chatId: string;
      chatTitle: string;
      userText: string;
      assistantText: string;
      model?: string | null;
      redact?: boolean;
    }) => ipcRenderer.invoke("prism:vault:saveTurn", params),
    openInObsidian: (params: { relPath: string }) =>
      ipcRenderer.invoke("prism:vault:openInObsidian", params),
    // v0.1.61: vault path picker + getter/setter
    getRoot: () => ipcRenderer.invoke("prism:vault:getRoot"),
    setRoot: (path: string) => ipcRenderer.invoke("prism:vault:setRoot", path),
    pickFolder: () => ipcRenderer.invoke("prism:vault:pickFolder"),
  },

  // v0.1.47: cross-session context (claude-mem inspired). On chat end,
  // generate + persist a haiku-summarized record. On new chat start,
  // recall similar past sessions via cosine similarity on the user's
  // first message.
  session: {
    record: (params: {
      chatId: string;
      title: string;
      userMessages: string[];
      assistantMessages: string[];
      projectId: string | null;
    }) => ipcRenderer.invoke("prism:session:record", params),
    recall: (params: {
      queryText: string;
      excludeChatId?: string;
      projectId?: string | null;
      limit?: number;
    }) => ipcRenderer.invoke("prism:session:recall", params),
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

  // Providers (v0.1.50) — multi-provider scaffolding. Today only
  // detection; future release will route turns through e.g. Ollama for
  // cheap traffic.
  providers: {
    detectOllama: () => ipcRenderer.invoke("prism:provider:detectOllama"),
  },

  // v0.1.59: main-process clipboard write — fallback for cases where
  // navigator.clipboard.writeText silently fails in Electron renderer.
  clipboard: {
    write: (text: string) => ipcRenderer.invoke("prism:clipboard:write", text),
  },

  // Scheduled jobs (v0.1.51) — read-only viewer over LaunchAgents.
  scheduled: {
    list: () => ipcRenderer.invoke("prism:scheduled:list"),
  },

  // Provenance (v0.1.52) — gather a "show your work" trace for a turn.
  // v0.1.57: traces now ride along with chat:send (grounded into the
  // LLM prompt) and arrive via onTrace. Direct gather() still exposed
  // for tooling / debugging.
  provenance: {
    gather: (params: { turnId: string; queryText: string }) =>
      ipcRenderer.invoke("prism:provenance:gather", params),
    onTrace: (cb: (ev: { turnId: string; trace: any }) => void) => {
      const listener = (_: unknown, ev: any) => cb(ev);
      ipcRenderer.on("prism:provenance:trace", listener);
      return () => ipcRenderer.removeListener("prism:provenance:trace", listener);
    },
  },

  // Commitments (v0.1.54) — extract "I will" pledges from assistant
  // outputs, persist to vault Commitments/ folder, mark resolved with
  // outcome.
  commitments: {
    extract: (params: { text: string; chatId?: string; turnId?: string }) =>
      ipcRenderer.invoke("prism:commitments:extract", params),
    persist: (commitment: any) =>
      ipcRenderer.invoke("prism:commitments:persist", commitment),
    list: () => ipcRenderer.invoke("prism:commitments:list"),
    resolve: (params: { id: string; outcome: string }) =>
      ipcRenderer.invoke("prism:commitments:resolve", params),
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
    // v0.1.38: thumbs-up/down feedback → re-extraction with anti-pattern
    // or reinforcement bias depending on the signal.
    extractWithFeedback: (params: {
      userMessage: string;
      assistantText: string;
      feedback: "up" | "down";
    }) => ipcRenderer.invoke("prism:profile:extractWithFeedback", params),
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
