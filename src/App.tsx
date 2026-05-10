import { useEffect, useState, useRef, useCallback, useMemo } from "react";
// gateway.ts (WS-based) is deprecated as of v0.1.9 — kept only for the
// ChatMessage type. Chat now goes through IPC → claude CLI in main process.
import { ChatMessage } from "./gateway";
import { SetupWizard } from "./SetupWizard";
import { SettingsModal, loadSettings, saveSettings, MODEL_OPTIONS, Settings } from "./Settings";
import { Message } from "./Message";
import { Sidebar } from "./Sidebar";
import {
  SlashCommandMenu,
  filterCommands,
  commandAt,
  visibleCommandCount,
} from "./SlashCommandMenu";
import { ArtifactPane } from "./ArtifactPane";
import { Artifact, extractArtifacts } from "./artifacts";
import { downloadChatAsMarkdown } from "./export-chat";
import {
  AttachedFile,
  MAX_ATTACHMENTS_PER_TURN,
  saveAttachment,
  buildMessageWithAttachments,
  humanBytes,
} from "./attachments";
import {
  Chat,
  listChats,
  createChat,
  saveChat,
  renameChat,
  deleteChat,
  autoTitle,
  searchChats,
  loadActiveId,
  saveActiveId,
  migrateLegacyChat,
} from "./chats";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

const PRICING_URL = "https://prism.run/pricing";

/**
 * Token-count estimator. Two modes:
 *
 *   1. Synchronous fallback (chars/3.8 heuristic) — used for the very
 *      first render and when the BPE tokenizer hasn't loaded yet.
 *      Empirically within ~15% of cl100k_base / Claude's actual
 *      count for normal input.
 *
 *   2. BPE-accurate (gpt-tokenizer/cl100k_base) — lazy-loaded on first
 *      composer keystroke. Closest public BPE to Claude's (Claude's
 *      exact tokenizer isn't published, but Anthropic has confirmed
 *      it's within ~5% of cl100k_base for English prose + code).
 *      Lazy-load avoids the ~1MB bundle hit for users who never type.
 *
 * The composer badge keeps the `~` prefix even with BPE because no
 * public tokenizer is exact for Claude — it's still an estimate, just
 * a much closer one.
 */

// Lazy-loaded BPE encoder. `null` = not loaded yet, falls back to
// heuristic. Initialized inside `loadBpeTokenizer()` on first input.
let _bpeEncode: ((s: string) => number[]) | null = null;
let _bpeLoadStarted = false;

function loadBpeTokenizer(): void {
  if (_bpeLoadStarted) return;
  _bpeLoadStarted = true;
  // Dynamic import so the ~1MB tokenizer bundle isn't pulled into
  // the critical-path JS. Falls through silently on error — the
  // heuristic is fine and we don't want a tokenizer load failure to
  // block typing.
  import("gpt-tokenizer/encoding/cl100k_base")
    .then((mod) => {
      _bpeEncode = mod.encode;
    })
    .catch(() => {
      /* keep heuristic */
    });
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  // Kick off the lazy load on first call. Idempotent.
  if (!_bpeLoadStarted) loadBpeTokenizer();
  if (_bpeEncode) {
    try {
      return _bpeEncode(text).length;
    } catch {
      /* fall through to heuristic */
    }
  }
  return Math.max(1, Math.ceil(text.length / 3.8));
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function App() {
  // v0.1.9: chat backend is now child_process spawning the `claude` CLI.
  // `claudeReady` reflects whether we found the binary; if false, show a
  // setup error (the Setup wizard handles brew install if appropriate).
  const [claudeReady, setClaudeReady] = useState<boolean | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryPending, setMemoryPending] = useState(false);

  // Slash commands (v0.1.18)
  const [commands, setCommands] = useState<DiscoveredCommand[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Active artifact preview (v0.1.18)
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);

  // Window pin + file attachments (v0.1.25)
  const [pinned, setPinned] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dropOverlay, setDropOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Multi-chat state (v0.1.5)
  const [chats, setChats] = useState<Chat[]>(() => {
    migrateLegacyChat();
    return listChats();
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = loadActiveId();
    if (stored) return stored;
    const all = listChats();
    return all[0]?.id ?? null;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [input, setInput] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeId) ?? null,
    [chats, activeId],
  );
  const messages: ChatMessage[] = activeChat?.messages ?? [];

  // Apply theme override
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  // Read current pin state on boot (in case the user already pinned
  // before quitting last session — main.ts could remember + restore,
  // but for now this just reads the current Electron state).
  useEffect(() => {
    window.flexhaul.window
      .isAlwaysOnTop()
      .then(({ pinned }) => setPinned(!!pinned))
      .catch(() => {});
  }, []);

  // Pin / unpin the window. Always-on-top is per-Electron-window, not
  // per-screen.
  const togglePinned = useCallback(async () => {
    const next = !pinned;
    await window.flexhaul.window.setAlwaysOnTop(next);
    setPinned(next);
  }, [pinned]);

  // Export the active chat as markdown via browser download.
  const handleExportChat = useCallback(
    (id: string) => {
      const chat = chats.find((c) => c.id === id);
      if (chat) downloadChatAsMarkdown(chat);
    },
    [chats],
  );

  // Handle a batch of dropped/picked files. Saves each via IPC, then
  // appends to attachedFiles. Capped at MAX_ATTACHMENTS_PER_TURN.
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!activeId) return;
      const arr = Array.from(files);
      const remaining = MAX_ATTACHMENTS_PER_TURN - attachedFiles.length;
      if (remaining <= 0) {
        setError(`Max ${MAX_ATTACHMENTS_PER_TURN} attachments per turn`);
        return;
      }
      const toSave = arr.slice(0, remaining);
      const saved: AttachedFile[] = [];
      for (const f of toSave) {
        const att = await saveAttachment(activeId, f);
        if (att) saved.push(att);
      }
      if (saved.length > 0) {
        setAttachedFiles((prev) => [...prev, ...saved]);
      }
      if (saved.length < toSave.length) {
        setError(
          `Skipped ${toSave.length - saved.length} file(s) — too large or save failed`,
        );
      }
    },
    [activeId, attachedFiles.length],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachedFiles((prev) => {
      const dropped = prev.find((a) => a.id === id);
      if (dropped?.previewUrl) {
        try {
          URL.revokeObjectURL(dropped.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Load slash commands once at startup; refresh on focus to pick up
  // newly-added skills without restarting the app.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await window.flexhaul.commands.list();
        if (!cancelled) setCommands(list);
      } catch {
        /* ignore — empty list is fine */
      }
    };
    load();
    const onFocus = () => {
      window.flexhaul.commands.refresh().then((l) => {
        if (!cancelled) setCommands(l);
      }).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Parse the current input to decide whether the slash menu should
  // be visible. It opens when the input STARTS with `/` and the user
  // is still typing the command name (no space yet).
  useEffect(() => {
    if (input.startsWith("/")) {
      const m = input.match(/^\/([a-zA-Z0-9_-]*)$/);
      if (m) {
        setSlashOpen(true);
        setSlashQuery(m[1]);
        return;
      }
    }
    setSlashOpen(false);
    setSlashQuery("");
    setSlashIndex(0);
  }, [input]);

  // Clamp the selected index when the visible list shrinks
  useEffect(() => {
    if (!slashOpen) return;
    const visible = visibleCommandCount(slashQuery, commands);
    if (slashIndex >= visible && visible > 0) setSlashIndex(visible - 1);
  }, [slashOpen, slashQuery, commands, slashIndex]);

  const acceptSlash = useCallback(
    (cmd: DiscoveredCommand) => {
      setInput(`/${cmd.name} `);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashIndex(0);
      // Defer focus until React has flushed the new value, so the
      // textarea's caret lands at the end.
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    },
    [],
  );

  // Persist active chat id
  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  // Pre-boot setup check
  useEffect(() => {
    let cancelled = false;
    const fallbackTimer = setTimeout(() => {
      if (!cancelled) setSetupNeeded(true);
    }, 4000);

    (async () => {
      try {
        const v = await window.flexhaul.getAppVersion();
        if (!cancelled) setVersion(v);
        const status = await window.flexhaul.setup.status();
        if (cancelled) return;
        const reachable = !!status.daemonReachable;
        clearTimeout(fallbackTimer);
        setSetupNeeded(!status.runtimeInstalled || !status.paired || !reachable);
      } catch {
        clearTimeout(fallbackTimer);
        if (!cancelled) setSetupNeeded(true);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, []);

  // Mutate the active chat's messages — saves and updates state
  const updateActiveMessages = useCallback(
    (mutator: (prev: ChatMessage[]) => ChatMessage[]) => {
      setChats((prev) => {
        let id = activeId;
        let target = prev.find((c) => c.id === id);
        // Create on demand if no active chat
        if (!target) {
          const fresh = createChat();
          id = fresh.id;
          target = fresh;
          setActiveId(id);
          prev = [fresh, ...prev];
        }
        const newMessages = mutator(target.messages);
        const updated: Chat = {
          ...target,
          messages: newMessages,
          title: autoTitle(newMessages, target.title),
          updatedAt: Date.now(),
        };
        saveChat(updated);
        return prev.map((c) => (c.id === id ? updated : c));
      });
    },
    [activeId],
  );

  // Probe for claude CLI on boot. If missing, surface an error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const probe = await window.flexhaul.chat.probe();
        if (!cancelled) setClaudeReady(probe.found);
        if (!probe.found && !cancelled) {
          setError(
            "Claude CLI not found. Install Claude Code from claude.ai/code (or: brew install anthropic-ai/tap/claude-code), then relaunch Prism.",
          );
        }
      } catch (e: any) {
        if (!cancelled) {
          setClaudeReady(false);
          setError(`Failed to probe claude CLI: ${e.message ?? String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to chat IPC events — append/mutate the current chat's messages
  useEffect(() => {
    const offStart = window.flexhaul.chat.onStart((ev) => {
      // Stash session id back to the active chat so future turns can --resume
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeId && !c.claudeSessionId
            ? { ...c, claudeSessionId: ev.sessionId }
            : c,
        ),
      );
      updateActiveMessages((prev) => [...prev, { role: "assistant", text: "" }]);
      setActiveTurnId(ev.turnId);
      setStreaming(true);
    });

    const offDelta = window.flexhaul.chat.onDelta((ev) => {
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role === "assistant") {
          next[next.length - 1] = { ...last, text: last.text + ev.text };
        }
        return next;
      });
    });

    const offEnd = window.flexhaul.chat.onEnd((ev) => {
      setStreaming(false);
      setActiveTurnId(null);
      // Persist the session id for --resume on next turn (in case onStart
      // didn't capture it — defensive)
      if (ev.sessionId) {
        setChats((prev) =>
          prev.map((c) =>
            c.id === activeId ? { ...c, claudeSessionId: ev.sessionId } : c,
          ),
        );
      }
      // Backfill if assistant bubble is empty (defensive — shouldn't happen)
      if (ev.finalText) {
        updateActiveMessages((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role === "assistant" && last.text === "") {
            const next = [...prev];
            next[next.length - 1] = { ...last, text: ev.finalText };
            return next;
          }
          return prev;
        });
      }
      // v0.1.25: surface a Mac notification if user has switched away from
      // Prism mid-turn. Click → focus the window. We don't notify when
      // the user is still looking at Prism — that'd be obnoxious.
      try {
        if (
          ev.finalText &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          document.visibilityState !== "visible"
        ) {
          const preview =
            ev.finalText.replace(/\s+/g, " ").slice(0, 140) +
            (ev.finalText.length > 140 ? "…" : "");
          const n = new Notification("Prism — reply ready", { body: preview });
          n.onclick = () => {
            try {
              window.focus();
              n.close();
            } catch {
              /* ignore */
            }
          };
        }
      } catch {
        /* ignore */
      }
    });

    const offError = window.flexhaul.chat.onError((ev) => {
      setStreaming(false);
      setActiveTurnId(null);
      // v0.1.15: when the runtime reports a session-expired error,
      // clear the active chat's claudeSessionId so the next turn starts
      // fresh instead of repeatedly --resume'ing a dead UUID.
      if (ev.sessionExpired) {
        setChats((prev) =>
          prev.map((c) =>
            c.id === activeId ? { ...c, claudeSessionId: null } : c,
          ),
        );
        updateActiveMessages((prev) => [
          ...prev,
          {
            role: "system",
            text: "Session expired — next prompt will start a fresh conversation.",
          },
        ]);
      } else {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `Error: ${ev.error}` },
        ]);
      }
    });

    const offPending = window.flexhaul.profile.onPending(() => {
      setMemoryPending(true);
    });

    // v0.1.18: live tool-progress events. We attach them to the most
    // recent assistant message (the one currently being streamed).
    const offTool = window.flexhaul.chat.onTool((ev) => {
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        if (last.role !== "assistant") return prev;

        const tools = last.tools ? [...last.tools] : [];
        if (ev.phase === "use") {
          tools.push({
            toolUseId: ev.toolUseId,
            name: ev.name ?? "tool",
            inputPreview: ev.inputPreview,
            status: "running",
          });
        } else if (ev.phase === "result") {
          const idx = tools.findIndex((t) => t.toolUseId === ev.toolUseId);
          if (idx >= 0) {
            tools[idx] = {
              ...tools[idx],
              resultPreview: ev.resultPreview,
              isError: !!ev.isError,
              status: ev.isError ? "error" : "done",
            };
          }
        }
        const next = [...prev];
        next[lastIdx] = { ...last, tools };
        return next;
      });
    });

    return () => {
      offStart();
      offDelta();
      offEnd();
      offError();
      offPending();
      offTool();
    };
  }, [activeId, updateActiveMessages]);

  // Update events
  useEffect(() => {
    const off = [
      window.flexhaul.onUpdateEvent("checking", () => setUpdateState({ kind: "checking" })),
      window.flexhaul.onUpdateEvent("available", (info: any) =>
        setUpdateState({ kind: "available", version: info?.version ?? "?" }),
      ),
      window.flexhaul.onUpdateEvent("downloaded", (info: any) =>
        setUpdateState({ kind: "downloaded", version: info?.version ?? "?" }),
      ),
      window.flexhaul.onUpdateEvent("error", (msg: any) =>
        setUpdateState({ kind: "error", message: String(msg) }),
      ),
      window.flexhaul.onUpdateEvent("not-available", () => setUpdateState({ kind: "idle" })),
    ];
    return () => off.forEach((fn) => fn());
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages.length]);

  // Chat management
  const handleNewChat = useCallback(() => {
    const fresh = createChat();
    setChats((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
  }, []);

  const handleSelectChat = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const handleRenameChat = useCallback((id: string, title: string) => {
    const updated = renameChat(id, title);
    if (updated) {
      setChats((prev) => prev.map((c) => (c.id === id ? updated : c)));
    }
  }, []);

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id);
      setChats((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        const remaining = listChats();
        setActiveId(remaining[0]?.id ?? null);
      }
    },
    [activeId],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setBatchMode((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewChat]);

  const send = useCallback(async () => {
    const hasInput = input.trim().length > 0;
    const hasAttachments = attachedFiles.length > 0;
    if (!claudeReady || (!hasInput && !hasAttachments) || sending || streaming) return;
    const text = input.trim();
    const filesAtSend = attachedFiles; // snapshot before clearing
    setInput("");
    setAttachedFiles([]);
    setSending(true);

    // v0.1.25: request OS notification permission lazily on first send.
    // The actual notification is fired in the onEnd handler when the
    // window is unfocused. Default state → ask once; granted/denied
    // → no-op. We don't block on the user's answer.
    try {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    let toSend: string;
    let userBubble: ChatMessage;
    if (batchMode) {
      const prompts = text
        .split("\n")
        .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
        .filter((l) => l && !l.startsWith("#"));
      if (prompts.length === 0) {
        setSending(false);
        return;
      }
      toSend = `/batch\n${prompts.join("\n")}`;
      userBubble = { role: "user", text, batch: true, batchCount: prompts.length };
    } else {
      toSend = buildMessageWithAttachments(text, filesAtSend);
      const displayText =
        filesAtSend.length > 0
          ? `${text}\n\n[+${filesAtSend.length} attachment${filesAtSend.length === 1 ? "" : "s"}: ${filesAtSend
              .map((f) => f.name)
              .join(", ")}]`
          : text;
      userBubble = { role: "user", text: displayText };
    }
    updateActiveMessages((prev) => [...prev, userBubble]);

    // Send via IPC. Resume the chat's claude session if we have one.
    const sessionId = activeChat?.claudeSessionId ?? null;
    const result = await window.flexhaul.chat.send({
      message: toSend,
      model: settings.model,
      sessionId,
    });
    if ("error" in result) {
      updateActiveMessages((prev) => [
        ...prev,
        { role: "system", text: `Send failed: ${result.error}` },
      ]);
    }
    // The actual reply arrives via onStart/onDelta/onEnd — no further work here
    setSending(false);
  }, [
    claudeReady,
    input,
    attachedFiles,
    batchMode,
    sending,
    streaming,
    settings.model,
    activeChat,
    updateActiveMessages,
  ]);

  const abortTurn = useCallback(() => {
    if (activeTurnId) {
      window.flexhaul.chat.abort(activeTurnId);
    }
  }, [activeTurnId]);

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command navigation has highest priority when the menu is open.
    if (slashOpen) {
      const visible = visibleCommandCount(slashQuery, commands);
      if (visible > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % visible);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + visible) % visible);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const c = commandAt(slashQuery, commands, slashIndex);
          if (c) acceptSlash(c);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !batchMode) {
      e.preventDefault();
      send();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && batchMode) {
      e.preventDefault();
      send();
    }
  };

  // v0.1.9: chat now uses claude CLI directly. SetupWizard's old "install
  // OpenClaw runtime" path is moot for chat; we still show it if the wizard
  // would be helpful (e.g. user explicitly requested it). For now skip it
  // entirely — chat readiness is gated on claudeReady, not the OpenClaw
  // daemon being up.
  if (claudeReady === null) {
    return (
      <div
        className="app"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ink-mute)",
        }}
      >
        Looking for Claude CLI…
      </div>
    );
  }

  const visibleChats = searchQuery ? searchChats(searchQuery) : chats;

  return (
    <div className="app app-with-sidebar">
      <Sidebar
        chats={visibleChats}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onSelect={handleSelectChat}
        onNewChat={handleNewChat}
        onRename={handleRenameChat}
        onDelete={handleDeleteChat}
        onExport={handleExportChat}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className={`main-pane${activeArtifact ? " has-artifact" : ""}`}>
        <div className="titlebar">
          <span className="brand">PRISM</span>
          <span className="brand-version">v{version}</span>
          <span style={{ flex: 1 }} />
          <button
            className={`titlebar-button${pinned ? " active" : ""}`}
            onClick={togglePinned}
            title={pinned ? "Unpin window (currently always-on-top)" : "Pin window (always-on-top)"}
          >
            {pinned ? "📌" : "📍"}
          </button>
          <button
            className="titlebar-button"
            onClick={() => {
              setSettingsOpen(true);
              setMemoryPending(false);
            }}
            title={
              memoryPending
                ? "Settings — new memory learned"
                : "Settings (⌘,)"
            }
          >
            ⚙
            {memoryPending ? <span className="titlebar-button-dot" /> : null}
          </button>
        </div>

        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onChange={setSettings}
          current={settings}
        />

        {(updateState.kind === "available" || updateState.kind === "downloaded") && (
          <div className="update-banner">
            <span>
              {updateState.kind === "downloaded"
                ? `Update v${updateState.version} downloaded — restart to apply`
                : `Update v${updateState.version} available — downloading…`}
            </span>
            {updateState.kind === "downloaded" && (
              <button onClick={() => location.reload()}>Restart</button>
            )}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div
          className={`chat${dropOverlay ? " drop-active" : ""}`}
          ref={chatRef}
          onDragEnter={(e) => {
            // Show overlay only when actual files are being dragged.
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              setDropOverlay(true);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
            }
          }}
          onDragLeave={(e) => {
            // Only clear if we're leaving the chat container, not just
            // crossing between its children.
            if (e.currentTarget === e.target) setDropOverlay(false);
          }}
          onDrop={(e) => {
            if (e.dataTransfer?.files?.length) {
              e.preventDefault();
              setDropOverlay(false);
              void handleFiles(e.dataTransfer.files);
            }
          }}
        >
          {messages.length === 0 && !error && (
            <div className="empty-state">
              <div className="prism-mark" />
              <h2>Prism</h2>
              <div className="tagline">
                Type N prompts. Get N parallel agents. Reconciled into one answer. Routes across
                any model — Anthropic, OSS, local. Runs on your machine.
              </div>
              <div className="hint">
                <kbd>Enter</kbd> send · <kbd>⌘</kbd>+<kbd>B</kbd> batch ·{" "}
                <kbd>⌘</kbd>+<kbd>N</kbd> new chat · <kbd>⌘</kbd>+<kbd>1</kbd> sidebar
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const isStreaming = streaming && isLast && m.role === "assistant";
            const onEdit =
              m.role === "user"
                ? async (newText: string) => {
                    if (!claudeReady || streaming) return;
                    // Truncate everything from this user message onward,
                    // replace it with the new text, then re-send.
                    updateActiveMessages((prev) => {
                      const next = prev.slice(0, i);
                      return [...next, { ...m, text: newText }];
                    });
                    const sessionId = activeChat?.claudeSessionId ?? null;
                    const result = await window.flexhaul.chat.send({
                      message: m.batch ? `/batch\n${newText}` : newText,
                      model: settings.model,
                      sessionId,
                    });
                    if ("error" in result) {
                      updateActiveMessages((prev) => [
                        ...prev,
                        { role: "system", text: `Send failed: ${result.error}` },
                      ]);
                    }
                  }
                : undefined;
            const messageArtifacts =
              m.role === "assistant" ? extractArtifacts(m.text, `m-${i}`) : [];
            return (
              <Message
                key={i}
                message={m}
                streaming={isStreaming}
                onEdit={onEdit}
                artifacts={messageArtifacts}
                onOpenArtifact={setActiveArtifact}
                activeArtifactId={activeArtifact?.id ?? null}
              />
            );
          })}
        </div>

        <div className={`composer ${batchMode ? "batch-active" : ""}`}>
          <SlashCommandMenu
            open={slashOpen}
            query={slashQuery}
            commands={commands}
            selectedIndex={slashIndex}
            onSelect={acceptSlash}
            onHoverIndex={setSlashIndex}
          />
          <div className="composer-hint">
            <span>
              {batchMode
                ? "Batch · one prompt per line · ⌘+Enter to send"
                : "Enter to send · Shift+Enter for new line · ⌘B to batch"}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {input.length > 0 ? (
                <span
                  className="composer-tokens"
                  title="Approximate token count for the current input"
                >
                  ~{formatTokenCount(estimateTokens(input))}
                </span>
              ) : null}
              <select
                className="model-picker"
                value={settings.model}
                onChange={(e) => {
                  const next = { ...settings, model: e.target.value };
                  setSettings(next);
                  saveSettings(next);
                }}
                title="Model — change in Settings for full options"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === "auto" ? "Auto" : m.id}
                  </option>
                ))}
              </select>
              <a
                href={PRICING_URL}
                onClick={(e) => {
                  e.preventDefault();
                  window.open(PRICING_URL, "_blank");
                }}
                style={{ color: "inherit", textDecoration: "underline dotted" }}
              >
                Beta
              </a>
            </span>
          </div>
          {attachedFiles.length > 0 ? (
            <div className="composer-attachments">
              {attachedFiles.map((f) => (
                <div key={f.id} className="composer-attachment">
                  {f.previewUrl ? (
                    <img
                      className="composer-attachment-thumb"
                      src={f.previewUrl}
                      alt={f.name}
                    />
                  ) : (
                    <div className="composer-attachment-icon">
                      {f.mimeType.startsWith("text/")
                        ? "📄"
                        : f.mimeType === "application/pdf"
                        ? "📕"
                        : "📎"}
                    </div>
                  )}
                  <div className="composer-attachment-meta">
                    <div className="composer-attachment-name">{f.name}</div>
                    <div className="composer-attachment-size">
                      {humanBytes(f.sizeBytes)}
                    </div>
                  </div>
                  <button
                    className="composer-attachment-remove"
                    onClick={() => removeAttachment(f.id)}
                    title="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) {
                void handleFiles(e.target.files);
                e.target.value = ""; // allow re-selecting the same file
              }
            }}
          />
          <div className="composer-row">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onTextareaKey}
              placeholder={
                batchMode
                  ? "first prompt\nsecond prompt\nthird prompt"
                  : claudeReady
                  ? "Ask anything…"
                  : claudeReady === null
                  ? "Looking for Claude CLI…"
                  : "Claude CLI not found — install from claude.ai/code"
              }
              rows={batchMode ? 5 : 1}
            />
            <div className="composer-actions">
              <button
                className="composer-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={attachedFiles.length >= MAX_ATTACHMENTS_PER_TURN}
                title={
                  attachedFiles.length >= MAX_ATTACHMENTS_PER_TURN
                    ? `Max ${MAX_ATTACHMENTS_PER_TURN} attachments`
                    : "Attach file or image (drag-drop also works)"
                }
              >
                📎
              </button>
              <button
                className={`batch-toggle ${batchMode ? "active" : ""}`}
                onClick={() => setBatchMode((v) => !v)}
                title="Toggle batch mode (⌘B)"
              >
                {batchMode ? "▲ BATCH" : "BATCH"}
              </button>
              {streaming ? (
                <button
                  onClick={abortTurn}
                  className="composer-stop"
                  title="Stop generating"
                >
                  ■ Stop
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={
                    !claudeReady ||
                    (!input.trim() && attachedFiles.length === 0) ||
                    sending
                  }
                >
                  {sending ? "…" : "Send"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeArtifact ? (
        <ArtifactPane
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
        />
      ) : null}
    </div>
  );
}
