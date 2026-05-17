import { useEffect, useState, useRef, useCallback, useMemo } from "react";
// gateway.ts (WS-based) is deprecated as of v0.1.9 — kept only for the
// ChatMessage type. Chat now goes through IPC → claude CLI in main process.
import { ChatMessage, BatchAgent } from "./gateway";
import { SetupWizard } from "./SetupWizard";
import { SettingsModal, loadSettings, saveSettings, MODEL_OPTIONS, Settings } from "./Settings";
import { Message, shortModelName } from "./Message";
import { EventStream } from "./EventStream";
import {
  VaultAutocomplete,
  rankVaultNotes,
  detectVaultTrigger,
} from "./VaultAutocomplete";
import { Sidebar } from "./Sidebar";
import {
  SlashCommandMenu,
  filterCommands,
  commandAt,
  visibleCommandCount,
} from "./SlashCommandMenu";
import { ArtifactPane } from "./ArtifactPane";
import { ProjectManager } from "./ProjectManager";
import { CommandPalette, buildCommandItems } from "./CommandPalette";
import {
  Paperclip,
  Mic,
  Square,
  Pin,
  PinOff,
  Settings as SettingsIcon,
  Plus,
  PanelLeft,
  X as XIcon,
} from "lucide-react";
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
  setChatProject,
  forkChatAtIndex,
} from "./chats";
import {
  Project,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  getProject,
} from "./projects";
import { unassignFromProject } from "./chats";
import { evaluateRisk, type WatchEvaluation, type WatchTrigger } from "./watch-mode";
import { TONE_PRESETS, applyTone } from "./tone-presets";

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

  // v0.1.40: vault autocomplete (`[[…`). Mirrors the slash-command model.
  // `vaultNotes` is loaded once on boot (refreshed on Settings open via
  // an effect we'll add later). The trigger detection runs inline on
  // every composer keystroke.
  const [vaultNotes, setVaultNotes] = useState<
    Array<{ title: string; relPath: string; absPath: string; mtimeMs: number }>
  >([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultQuery, setVaultQuery] = useState("");
  const [vaultIndex, setVaultIndex] = useState(0);
  const [vaultAttached, setVaultAttached] = useState<
    Array<{ title: string; relPath: string; body: string }>
  >([]);
  // Per-chat "saved to vault" state for the sidebar badge. Map of
  // chatId → relPath of the most recent save.
  const [savedToVault, setSavedToVault] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Active artifact preview (v0.1.18)
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);

  // Window pin + file attachments (v0.1.25)
  const [pinned, setPinned] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dropOverlay, setDropOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Projects + voice (v0.1.29)
  const [projects, setProjects] = useState<Project[]>(() => listProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const voiceRecRef = useRef<any>(null);

  // Command palette + Side Chat (v0.1.32)
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideChatMessages, setSideChatMessages] = useState<ChatMessage[]>([]);
  const [sideChatInput, setSideChatInput] = useState("");
  const [sideChatStreaming, setSideChatStreaming] = useState(false);
  const sideTurnIdRef = useRef<string | null>(null);
  // v0.1.52: traces that arrived before the assistant bubble existed.
  // Drained in onStart so the panel renders as soon as the bubble is up.
  const pendingTracesRef = useRef<Map<string, ProvenanceTrace>>(new Map());
  // v0.1.53: Watch-mode pre-flight banner + one-shot override.
  const [watchBanner, setWatchBanner] = useState<{
    text: string;
    evaluation: WatchEvaluation;
  } | null>(null);
  const watchOverrideRef = useRef<"bypass" | "ask" | null>(null);
  // v0.1.55: tone targeting — sticky audience selection.
  const [selectedTone, setSelectedTone] = useState<string>("default");
  const sideChatRef = useRef<HTMLDivElement>(null);

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

  // v0.1.35: in-chat find (⌘F). When open, the chat pane gets a find
  // bar at the top; matching message bubbles get .find-match class for
  // a yellow tint, and Enter / ⇧Enter cycle through matches.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // v0.1.35: shortcut help overlay (?)
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // v0.1.39: Event Stream Viewer (⌘E). Slide-in dev panel showing every
  // tool call on the current turn with wall-clock timing. Pattern lifted
  // from Agent TARS — useful for "what is the agent actually doing right
  // now" + post-mortem debugging of slow turns.
  const [eventStreamOpen, setEventStreamOpen] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  // v0.1.43 (Cua-inspired trajectory replay): when the user clicks
  // "Replay" on a past assistant message, store its index so EventStream
  // shows THAT turn's tools instead of the current/most-recent one.
  // Cleared when the viewer closes (next live turn re-takes focus).
  const [replayFocusIdx, setReplayFocusIdx] = useState<number | null>(null);

  // v0.1.35: last model the auto-router chose for the active chat, so
  // the titlebar chip can show "Auto → Sonnet" instead of just "Auto".
  // Reset when the user switches chats.
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  // v0.1.60: model picker dropdown
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelPickerOpen]);

  // v0.1.37: cached MCP server status from the main process. Updates on
  // every chat:start. Used for the titlebar MCP indicator pill.
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "general" | "memory" | "speed" | "mcp" | "account" | undefined
  >(undefined);
  useEffect(() => {
    window.flexhaul.mcp.status().then(setMcpStatus).catch(() => {});
    const off = window.flexhaul.mcp.onStatus((s) => setMcpStatus(s));
    return off;
  }, []);

  // v0.1.40: load vault note index on boot. Cheap (~1500 .md files
  // walked once). Errors are silent — Prism keeps working without the
  // vault; autocomplete just won't trigger.
  useEffect(() => {
    window.flexhaul.vault
      .list()
      .then((res) => {
        if (res.ok) setVaultNotes(res.notes);
      })
      .catch(() => {});
  }, []);

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

  // ── Projects (v0.1.29) ───────────────────────────────────
  const refreshProjects = useCallback(() => {
    setProjects(listProjects());
  }, []);

  const handleSelectProject = useCallback((projectId: string | null) => {
    setActiveProjectId(projectId);
    // Snap selection to the first chat in the project (or any chat
    // if "All"); creates a fresh one if the project has zero chats.
    setActiveId((curr) => {
      const filtered = listChats().filter(
        (c) => projectId === null || c.projectId === projectId,
      );
      if (filtered.length === 0) return curr; // composer is empty; user can hit + New chat
      if (filtered.some((c) => c.id === curr)) return curr;
      return filtered[0].id;
    });
  }, []);

  const handleCreateProject = useCallback(
    (name: string) => {
      const p = createProject(name);
      refreshProjects();
      setActiveProjectId(p.id);
      setEditingProjectId(p.id);
    },
    [refreshProjects],
  );

  const handleUpdateProject = useCallback(
    (id: string, updates: { name?: string; instructions?: string }) => {
      updateProject(id, updates);
      refreshProjects();
    },
    [refreshProjects],
  );

  const handleDeleteProject = useCallback(
    (id: string) => {
      if (!window.confirm("Delete this project? Its chats survive (unassigned).")) return;
      deleteProject(id);
      unassignFromProject(id);
      setChats(listChats());
      refreshProjects();
      if (activeProjectId === id) setActiveProjectId(null);
      if (editingProjectId === id) setEditingProjectId(null);
    },
    [activeProjectId, editingProjectId, refreshProjects],
  );

  const handleMoveChatToProject = useCallback(
    (chatId: string, projectId: string | null) => {
      setChatProject(chatId, projectId);
      setChats(listChats());
    },
    [],
  );

  // Fork — clone messages up to a user message index into a new chat.
  const handleFork = useCallback(
    (chatId: string, uptoIndex: number) => {
      const fresh = forkChatAtIndex(chatId, uptoIndex);
      if (!fresh) return;
      setChats(listChats());
      setActiveId(fresh.id);
    },
    [],
  );

  // ── Side Chat (v0.1.32) ──────────────────────────────────
  const sendSideChat = useCallback(async () => {
    const text = sideChatInput.trim();
    if (!text || sideChatStreaming) return;
    setSideChatInput("");
    setSideChatStreaming(true);
    setSideChatMessages((prev) => [...prev, { role: "user", text }]);

    // Side chat is always a fresh session — no project instructions,
    // no claudeSessionId. Its purpose is a scratchpad disconnected
    // from the main thread's history.
    const result = await window.flexhaul.chat.send({
      message: text,
      model: settings.model,
      sessionId: null,
      projectInstructions: null,
      permissionMode: settings.permissionMode,
    });
    if ("error" in result) {
      setSideChatMessages((prev) => [
        ...prev,
        { role: "system", text: `Error: ${result.error}` },
      ]);
      setSideChatStreaming(false);
    } else {
      // Tag this turn so onStart/Delta/End route to side state.
      sideTurnIdRef.current = result.turnId;
    }
  }, [sideChatInput, sideChatStreaming, settings.model]);

  // ── Voice input (v0.1.29) ────────────────────────────────
  // Browser Web Speech API. On macOS this routes through Apple's
  // dictation service (privacy note: audio leaves the device to
  // Apple, not to us). Streams interim results into the composer.
  const startVoice = useCallback(() => {
    const SR =
      (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SR) {
      setError("Voice input not available in this build.");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    let interimBase = "";
    rec.onstart = () => {
      // Snapshot whatever is already in the textarea so we append.
      interimBase = ""; // we'll set this from current input on first chunk
    };
    rec.onresult = (event: any) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0]?.transcript ?? "";
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      if (final) {
        setInput((curr) => (curr ? curr.trimEnd() + " " + final.trim() : final.trim()));
      }
      // (we don't render interim — keeps the textarea clean; final-only
      // matches Mac dictation UX)
    };
    rec.onerror = (e: any) => {
      setError(`Voice: ${e?.error ?? "unknown error"}`);
      setVoiceRecording(false);
    };
    rec.onend = () => {
      setVoiceRecording(false);
      voiceRecRef.current = null;
    };
    voiceRecRef.current = rec;
    setVoiceRecording(true);
    try {
      rec.start();
    } catch (e: any) {
      setError(`Voice: ${e?.message ?? String(e)}`);
      setVoiceRecording(false);
    }
  }, []);

  const stopVoice = useCallback(() => {
    try {
      voiceRecRef.current?.stop();
    } catch {
      /* ignore */
    }
    setVoiceRecording(false);
  }, []);

  const toggleVoice = useCallback(() => {
    if (voiceRecording) stopVoice();
    else startVoice();
  }, [voiceRecording, startVoice, stopVoice]);

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

  // v0.1.40: accept a vault note from the [[…]] autocomplete. Replaces
  // the in-progress `[[<query>` fragment with `[[<full title>]] ` in
  // the composer, AND fetches the note body to attach as turn context.
  // Two operations because:
  //   - The wikilink in the composer is what the user reads + what's
  //     sent to claude as part of the prompt (useful for citation /
  //     navigation back in Obsidian).
  //   - The body is attached as turn context so claude actually sees
  //     the note content, not just its title.
  const acceptVaultNote = useCallback(
    async (note: { title: string; relPath: string; absPath: string }) => {
      const el = composerRef.current;
      if (!el) {
        setVaultOpen(false);
        return;
      }
      const caret = el.selectionStart ?? el.value.length;
      const trigger = detectVaultTrigger(el.value, caret);
      if (!trigger) {
        setVaultOpen(false);
        return;
      }
      const before = el.value.slice(0, trigger.replaceFrom);
      const after = el.value.slice(trigger.replaceTo);
      const insertion = `[[${note.title}]] `;
      const nextValue = before + insertion + after;
      setInput(nextValue);
      setVaultOpen(false);
      setVaultQuery("");
      setVaultIndex(0);

      // Fetch + attach the note body as turn context. Best-effort.
      try {
        const res = await window.flexhaul.vault.readNote({
          relPath: note.relPath,
        });
        if (res.ok) {
          setVaultAttached((prev) => {
            // Dedup by relPath (don't double-attach the same note).
            if (prev.some((p) => p.relPath === note.relPath)) return prev;
            return [
              ...prev,
              { title: note.title, relPath: note.relPath, body: res.text },
            ];
          });
        }
      } catch {
        /* ignore — wikilink in composer is still useful even without attach */
      }

      // Restore focus + put caret right after the inserted "]] ".
      requestAnimationFrame(() => {
        const node = composerRef.current;
        if (!node) return;
        node.focus();
        const caretPos = before.length + insertion.length;
        node.setSelectionRange(caretPos, caretPos);
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

  // v0.1.40: ⌘⇧S — save the current chat's most recent (user, assistant)
  // pair to the Obsidian vault as a Sessions note with frontmatter
  // backlink to the Prism chat ID. Fire-and-forget; surface a success
  // toast via the system message stream so the user sees confirmation
  // in-chat. Declared AFTER updateActiveMessages because its useCallback
  // dep array references it; out-of-order declaration trips the TDZ
  // v0.1.42: approve a proposed plan + execute it. Sends a follow-up
  // turn with permissionMode forced to "bypass" for just this turn —
  // global setting is unchanged. The user's default stays Ask; this is
  // the one-shot "yes, do it" affordance the v0.1.41 safety mode was
  // missing. See MST-061.
  const approveAndExecute = useCallback(async () => {
    if (!activeChat) return;
    const sessionId = activeChat.claudeSessionId ?? null;
    const projectInstructions = activeChat.projectId
      ? getProject(activeChat.projectId)?.instructions ?? null
      : null;
    const approvalPrompt =
      "Approved. Execute the plan you just proposed above. " +
      "Run the operations end-to-end. If you hit anything ambiguous, " +
      "stop and ask before proceeding.";
    updateActiveMessages((prev) => [
      ...prev,
      { role: "user", text: approvalPrompt },
    ]);
    setSending(true);
    const result = await window.flexhaul.chat.send({
      message: approvalPrompt,
      model: settings.model,
      sessionId,
      projectInstructions,
      permissionMode: "bypass", // one-shot override — global stays Ask
    });
    if ("error" in result) {
      updateActiveMessages((prev) => [
        ...prev,
        { role: "system", text: `Approve failed: ${result.error}` },
      ]);
    }
    setSending(false);
  }, [activeChat, settings.model, updateActiveMessages]);

  // (caught by `ReferenceError: Cannot access 'Qe' before initialization`
  // in v0.1.40 pre-fix build).
  const saveTurnToVault = useCallback(async () => {
    if (!activeChat) return;
    const msgs = activeChat.messages;
    if (msgs.length === 0) return;
    // Find the most recent assistant message + the preceding user message.
    let assistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].text.trim().length > 0) {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx < 0) return;
    let userText = "";
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userText = msgs[i].text;
        break;
      }
    }
    if (!userText) return;
    const assistantText = msgs[assistantIdx].text;
    const model = msgs[assistantIdx].usage?.model ?? null;
    try {
      const res = await window.flexhaul.vault.saveTurn({
        chatId: activeChat.id,
        chatTitle: activeChat.title,
        userText,
        assistantText,
        model,
        redact: settings.redactBeforeVaultSave, // v0.1.46
      });
      if (res.ok) {
        setSavedToVault((prev) => ({ ...prev, [activeChat.id]: res.relPath }));
        updateActiveMessages((prev) => [
          ...prev,
          {
            role: "system",
            text: `Saved to vault → [[${res.relPath.replace(/\.md$/, "").split("/").pop()}]]\n_${res.relPath}_`,
          },
        ]);
      } else {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `Vault save failed: ${res.error}` },
        ]);
      }
    } catch (e: any) {
      updateActiveMessages((prev) => [
        ...prev,
        { role: "system", text: `Vault save threw: ${e?.message ?? e}` },
      ]);
    }
  }, [activeChat, updateActiveMessages]);

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
    const isSideTurn = (turnId: string) => sideTurnIdRef.current === turnId;

    // v0.1.57: subscribe to grounded-provenance traces emitted by main.
    const offTrace = window.flexhaul.provenance.onTrace((ev) => {
      let attached = false;
      updateActiveMessages((prev) => {
        const next = prev.map((m) => {
          if (m.role === "assistant" && m.turnId === ev.turnId) {
            attached = true;
            return { ...m, provenance: ev.trace };
          }
          return m;
        });
        return attached ? next : prev;
      });
      if (!attached) {
        pendingTracesRef.current.set(ev.turnId, ev.trace);
      }
    });

    const offStart = window.flexhaul.chat.onStart((ev) => {
      if (isSideTurn(ev.turnId)) {
        // Side chat turn — append empty assistant bubble to its own state
        setSideChatMessages((prev) => [...prev, { role: "assistant", text: "" }]);
        return;
      }
      // Stash session id back to the active chat so future turns can --resume
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeId && !c.claudeSessionId
            ? { ...c, claudeSessionId: ev.sessionId }
            : c,
        ),
      );
      // v0.1.52: drain any trace that landed before this onStart.
      const earlyTrace = pendingTracesRef.current.get(ev.turnId);
      if (earlyTrace) pendingTracesRef.current.delete(ev.turnId);
      updateActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "",
          turnId: ev.turnId,
          ...(earlyTrace ? { provenance: earlyTrace } : {}),
        },
      ]);
      setActiveTurnId(ev.turnId);
      setStreaming(true);
      // v0.1.35: capture the actual model claude is using so the titlebar
      // chip can reflect the auto-router's choice ("Auto → Haiku").
      if (ev.model) setRoutedModel(ev.model);
      // v0.1.39: stamp turn start for Event Stream Viewer relative
      // timestamps ("+1.2s into the turn").
      setTurnStartedAt(Date.now());
    });

    const offDelta = window.flexhaul.chat.onDelta((ev) => {
      if (isSideTurn(ev.turnId)) {
        setSideChatMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          if (last.role === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + ev.text };
          }
          return next;
        });
        return;
      }
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
      if (isSideTurn(ev.turnId)) {
        sideTurnIdRef.current = null;
        setSideChatStreaming(false);
        if (ev.finalText) {
          setSideChatMessages((prev) => {
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
        return;
      }
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
      // Backfill if assistant bubble is empty + stamp usage on the
      // assistant message so the footer can render Haiku · tokens · cost.
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        const next = [...prev];
        const usage =
          ev.inputTokens != null || ev.outputTokens != null || ev.cost != null
            ? {
                model: ev.model ?? "auto",
                inputTokens: ev.inputTokens ?? 0,
                outputTokens: ev.outputTokens ?? 0,
                cacheReadTokens: ev.cacheReadTokens ?? 0,
                cost: ev.cost ?? 0,
                durationMs: ev.durationMs ?? 0,
                // v0.1.42: stamp the permission mode the turn ran under so
                // the renderer can decide whether to show "Approve & execute".
                permissionMode: settings.permissionMode,
                // v0.1.44: APFS snapshot ID for Preview-mode turns.
                previewSnapshot: ev.previewSnapshot,
              }
            : last.usage;
        next[next.length - 1] = {
          ...last,
          text: last.text === "" && ev.finalText ? ev.finalText : last.text,
          usage,
        };
        return next;
      });
      // v0.1.54: extract first-person commitments from the assistant's
      // final text, persist each to the vault, and attach to the
      // message. Fire-and-forget — commitments are opportunistic.
      try {
        const finalForCommit = ev.finalText;
        if (finalForCommit) {
          const turnIdLocal = ev.turnId;
          const activeIdAtCapture = activeId;
          window.flexhaul.commitments
            .extract({
              text: finalForCommit,
              chatId: activeIdAtCapture ?? undefined,
              turnId: turnIdLocal,
            })
            .then(async (rawCommitments) => {
              if (!rawCommitments || rawCommitments.length === 0) return;
              const persisted: Commitment[] = [];
              for (const c of rawCommitments) {
                const res = await window.flexhaul.commitments.persist(c);
                if ("ok" in res && res.ok) {
                  persisted.push({ ...c, vaultRelPath: res.relPath });
                } else {
                  persisted.push(c);
                }
              }
              updateActiveMessages((prev) =>
                prev.map((m) =>
                  m.role === "assistant" && m.turnId === turnIdLocal
                    ? { ...m, commitments: persisted }
                    : m,
                ),
              );
            })
            .catch(() => {
              /* non-fatal */
            });
        }
      } catch {
        /* ignore */
      }

      // v0.1.33: auto-title — if the chat is still on its default
      // "New chat" / first-user-message stub title, ask haiku for a
      // proper 3-6 word title now that we have a full user+assistant
      // exchange. Fire-and-forget; never blocks the UI.
      try {
        if (ev.finalText) {
          // Snapshot the active chat for the title call (avoid stale closure)
          const chatId = activeId;
          if (chatId) {
            setChats((prev) => {
              const target = prev.find((c) => c.id === chatId);
              if (!target) return prev;
              const firstUser = target.messages.find((m) => m.role === "user");
              if (!firstUser) return prev;
              // Only auto-title if the title is still the default stub
              // (default = "New chat" or first-user-message prefix).
              const stub60 = firstUser.text.replace(/\s+/g, " ").trim().slice(0, 60);
              const looksDefault =
                target.title === "New chat" ||
                target.title === stub60 ||
                target.title.startsWith("Branch of ");
              if (!looksDefault) return prev;
              // Only worth firing on the first exchange — after that, the
              // user has had multiple turns to rename and the title is
              // probably meaningful in context.
              const userMsgs = target.messages.filter((m) => m.role === "user").length;
              if (userMsgs > 2) return prev;
              // Fire async title generation
              (async () => {
                try {
                  const res = await window.flexhaul.chat.generateTitle({
                    userMessage: firstUser.text,
                    assistantPreview: ev.finalText.slice(0, 400),
                  });
                  const title = (res?.title ?? "").trim();
                  if (!title) return;
                  // Only commit if the chat still looks default — user
                  // may have renamed manually during the haiku call.
                  setChats((curr) => {
                    const c = curr.find((x) => x.id === chatId);
                    if (!c) return curr;
                    const stillDefault =
                      c.title === "New chat" ||
                      c.title === stub60 ||
                      c.title.startsWith("Branch of ");
                    if (!stillDefault) return curr;
                    const updated = renameChat(chatId, title);
                    if (!updated) return curr;
                    return curr.map((x) => (x.id === chatId ? updated : x));
                  });
                } catch {
                  /* ignore — title is best-effort */
                }
              })();
              return prev;
            });
          }
        }
      } catch {
        /* ignore */
      }
      // v0.1.47: record a cross-session summary (claude-mem-inspired).
      // Fire-and-forget on every chat:end; the main process haiku-
      // summarizes the chat + embeds + persists. Idempotent — same
      // chatId UPSERTs. Only fires when the chat has ≥2 user turns
      // (≥1 user-assistant exchange already covered by other guards;
      // a richer summary needs at least 2 user turns to be useful).
      try {
        const chatId = activeId;
        if (chatId) {
          const target = chats.find((c) => c.id === chatId);
          if (target) {
            const users = target.messages.filter((m) => m.role === "user");
            const assistants = target.messages.filter((m) => m.role === "assistant");
            if (users.length >= 2 && assistants.length >= 1) {
              (async () => {
                try {
                  await window.flexhaul.session.record({
                    chatId,
                    title: target.title,
                    userMessages: users.map((m) => m.text),
                    assistantMessages: assistants.map((m) => m.text),
                    projectId: target.projectId ?? null,
                  });
                } catch {
                  /* fire-and-forget — best-effort persistence */
                }
              })();
            }
          }
        }
      } catch {
        /* ignore */
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
      if (isSideTurn(ev.turnId)) {
        sideTurnIdRef.current = null;
        setSideChatStreaming(false);
        setSideChatMessages((prev) => [
          ...prev,
          { role: "system", text: `Error: ${ev.error}` },
        ]);
        return;
      }
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

    // v0.1.30: parallel batch event subscriptions. Each event updates
    // the most recent assistant message (which we seeded with
    // batchAgents in `send` above). The renderer paints per-agent
    // progress live.
    const updateAgent = (
      index: number,
      mutator: (a: BatchAgent) => BatchAgent,
    ) =>
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        if (last.role !== "assistant" || !last.batchAgents) return prev;
        const agents = last.batchAgents.map((a) =>
          a.index === index ? mutator(a) : a,
        );
        const next = [...prev];
        next[lastIdx] = { ...last, batchAgents: agents };
        return next;
      });

    const offBatchStart = window.flexhaul.chat.onBatchStart(() => {});
    const offBatchAgentStart = window.flexhaul.chat.onBatchAgentStart((ev) => {
      updateAgent(ev.index, (a) => ({ ...a, tier: ev.tier, status: "running" }));
    });
    const offBatchAgentDelta = window.flexhaul.chat.onBatchAgentDelta((ev) => {
      updateAgent(ev.index, (a) => ({ ...a, text: a.text + ev.text }));
    });
    const offBatchAgentEnd = window.flexhaul.chat.onBatchAgentEnd((ev) => {
      updateAgent(ev.index, (a) => ({
        ...a,
        status: "done",
        text: ev.finalText || a.text,
      }));
    });
    const offBatchAgentError = window.flexhaul.chat.onBatchAgentError((ev) => {
      updateAgent(ev.index, (a) => ({ ...a, status: "error", error: ev.error }));
    });
    const offBatchReconcileStart = window.flexhaul.chat.onBatchReconcileStart(() => {
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        if (last.role !== "assistant" || !last.batchAgents) return prev;
        const next = [...prev];
        next[lastIdx] = { ...last, reconcilerStatus: "running", reconciled: "" };
        return next;
      });
    });
    const offBatchReconcileDelta = window.flexhaul.chat.onBatchReconcileDelta(
      (ev) => {
        updateActiveMessages((prev) => {
          if (prev.length === 0) return prev;
          const lastIdx = prev.length - 1;
          const last = prev[lastIdx];
          if (last.role !== "assistant" || !last.batchAgents) return prev;
          const newReconciled = (last.reconciled ?? "") + ev.text;
          const next = [...prev];
          // Stream reconciled into both `reconciled` (for the badge)
          // and `text` (so ReactMarkdown renders it live below the
          // agent cards).
          next[lastIdx] = {
            ...last,
            reconciled: newReconciled,
            text: newReconciled,
          };
          return next;
        });
      },
    );
    const offBatchEnd = window.flexhaul.chat.onBatchEnd((ev) => {
      setStreaming(false);
      updateActiveMessages((prev) => {
        if (prev.length === 0) return prev;
        const lastIdx = prev.length - 1;
        const last = prev[lastIdx];
        if (last.role !== "assistant" || !last.batchAgents) return prev;
        const next = [...prev];
        next[lastIdx] = {
          ...last,
          reconciled: ev.reconciled || last.reconciled,
          reconcilerStatus: ev.skippedReason ? "skipped" : "done",
          text: ev.reconciled || last.text,
        };
        return next;
      });
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
            // v0.1.39: capture wall-clock start for Event Stream Viewer
            // + per-tool duration pill. Prefer the main-process timestamp
            // (closer to the actual subprocess emit) if it came through,
            // else fall back to renderer-side Date.now().
            startedAt:
              typeof (ev as any).startedAt === "number"
                ? (ev as any).startedAt
                : Date.now(),
          });
        } else if (ev.phase === "result") {
          const idx = tools.findIndex((t) => t.toolUseId === ev.toolUseId);
          if (idx >= 0) {
            const startedAt = tools[idx].startedAt;
            tools[idx] = {
              ...tools[idx],
              resultPreview: ev.resultPreview,
              isError: !!ev.isError,
              status: ev.isError ? "error" : "done",
              durationMs: startedAt ? Date.now() - startedAt : undefined,
            };
          }
        }
        const next = [...prev];
        next[lastIdx] = { ...last, tools };
        return next;
      });
    });

    return () => {
      offTrace();
      offStart();
      offDelta();
      offEnd();
      offError();
      offPending();
      offTool();
      offBatchStart();
      offBatchAgentStart();
      offBatchAgentDelta();
      offBatchAgentEnd();
      offBatchAgentError();
      offBatchReconcileStart();
      offBatchReconcileDelta();
      offBatchEnd();
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
    // New chats inherit the active project so they show up under it
    // immediately. If user is in "All", the chat is unaffiliated.
    const fresh = createChat(activeProjectId);
    setChats((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
  }, [activeProjectId]);

  const handleSelectChat = useCallback((id: string) => {
    setActiveId(id);
    setRoutedModel(null);
    setTurnStartedAt(null);
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
      // v0.1.32: Command palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // v0.1.32: Side Chat
      if ((e.metaKey || e.ctrlKey) && e.key === ";") {
        e.preventDefault();
        setSideChatOpen((v) => !v);
      }
      // v0.1.39: Event Stream Viewer (⌘E).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setEventStreamOpen((v) => !v);
      }
      // v0.1.40: save current turn to Obsidian vault (⌘⇧S).
      // Saves the most-recent (user, assistant) pair as a Sessions/<year>/
      // <month>/ note with chat_id frontmatter back-reference.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        void saveTurnToVault();
      }
      // v0.1.42: ⌘⏎ approves the most-recent assistant plan and fires
      // a one-shot Bypass turn. Only when the last assistant turn ran
      // in Ask mode and isn't streaming. See MST-061.
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === "Enter" || e.key === "Return") &&
        !streaming
      ) {
        // Don't hijack Enter when the user is typing in the composer —
        // they probably mean "send", not "approve".
        const target = e.target as HTMLElement | null;
        const inComposer =
          target?.tagName === "TEXTAREA" ||
          target?.classList.contains("composer-input");
        if (!inComposer) {
          const last = messages[messages.length - 1];
          if (last?.role === "assistant" && last.usage?.permissionMode === "ask") {
            e.preventDefault();
            void approveAndExecute();
          }
        }
      }
      // v0.1.41: toggle Ask ↔ Bypass permission mode (⌘⇧P).
      // The user can flip mid-session — useful for "switch to Bypass
      // for this one turn, then back to Ask." See MST-060.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        setSettings((curr) => {
          const next = curr.permissionMode === "bypass" ? "ask" : "bypass";
          const updated = { ...curr, permissionMode: next as "ask" | "bypass" };
          saveSettings(updated);
          return updated;
        });
      }
      if (e.key === "Escape" && eventStreamOpen) {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".event-stream")) {
          e.preventDefault();
          setEventStreamOpen(false);
        }
      }
      // v0.1.35: in-chat find (⌘F). Esc closes when find bar is focused.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
        // Focus the find input on next tick so the autoFocus actually fires
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
      if (e.key === "Escape" && shortcutsOpen) {
        e.preventDefault();
        setShortcutsOpen(false);
        return;
      }
      if (e.key === "Escape" && findOpen) {
        const target = e.target as HTMLElement | null;
        if (target?.classList.contains("find-bar-input") || target?.closest(".find-bar")) {
          e.preventDefault();
          setFindOpen(false);
          setFindQuery("");
        }
      }
      // v0.1.35: shortcut help overlay (?). Only fires when not typing in
      // a text field — otherwise typing "?" into the composer would open.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        const target = e.target as HTMLElement | null;
        const isText =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable;
        if (!isText) {
          e.preventDefault();
          setShortcutsOpen((v) => !v);
        }
      }
      // v0.1.34: quick model swap — ⌘⇧0 auto, ⌘⇧1 haiku, ⌘⇧2 sonnet, ⌘⇧3 opus.
      // Doesn't interfere with ⌘1 (sidebar) because that's shift-less.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
        const modelMap: Record<string, Settings["model"]> = {
          "0": "auto",
          ")": "auto",
          "1": "haiku",
          "!": "haiku",
          "2": "sonnet",
          "@": "sonnet",
          "3": "opus",
          "#": "opus",
        };
        const next = modelMap[e.key];
        if (next) {
          e.preventDefault();
          setSettings((curr) => {
            const updated = { ...curr, model: next };
            saveSettings(updated);
            return updated;
          });
        }
      }
      // Close side chat with Esc when it's the active surface
      if (e.key === "Escape" && sideChatOpen && !paletteOpen) {
        const target = e.target as HTMLElement | null;
        if (sideChatRef.current?.contains(target)) {
          e.preventDefault();
          setSideChatOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNewChat, sideChatOpen, paletteOpen]);

  // v0.1.64: live fan-out preview. Mirrors the splitter inside send()
  // so the user can see "N agents will fan out" as they type.
  const batchPromptCount = useMemo(() => {
    if (!batchMode) return 0;
    return input
      .split("\n")
      .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
      .filter((l) => l && !l.startsWith("#")).length;
  }, [batchMode, input]);

  const send = useCallback(async () => {
    const hasInput = input.trim().length > 0;
    const hasAttachments = attachedFiles.length > 0;
    if (!claudeReady || (!hasInput && !hasAttachments) || sending || streaming) return;
    const text = input.trim();

    // v0.1.53: Watch-mode preflight. If the user is in Watch and this
    // message hits a destructive / egress / money / counterparty
    // trigger, pause and surface the banner — DON'T clear input or
    // send. The user picks Proceed (one-shot Bypass) or Switch to Ask.
    // The override ref carries the user's choice through to the
    // resend.
    let effectivePermissionMode: "ask" | "preview" | "bypass" =
      settings.permissionMode === "watch" ? "bypass" : settings.permissionMode;
    if (settings.permissionMode === "watch") {
      const override = watchOverrideRef.current;
      if (override) {
        effectivePermissionMode = override;
        watchOverrideRef.current = null;
      } else {
        const evaluation = evaluateRisk(text);
        if (evaluation.level !== "ok") {
          setWatchBanner({ text, evaluation });
          return;
        }
      }
    }

    const filesAtSend = attachedFiles; // snapshot before clearing
    setInput("");
    setAttachedFiles([]);
    setSending(true);
    setWatchBanner(null);

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

    // v0.1.36: /think — best-of-N at the same prompt. Detected here
    // (independent of batchMode). Spawns N=3 attempts in parallel +
    // reranker. UI mirrors batch's per-agent card layout.
    const thinkMatch = text.match(/^\s*\/think(?:\s+(\d+))?\s+([\s\S]+)$/);
    if (thinkMatch) {
      const n = Math.max(2, Math.min(5, parseInt(thinkMatch[1] || "3", 10) || 3));
      const thinkPrompt = thinkMatch[2].trim();
      if (!thinkPrompt) {
        setSending(false);
        return;
      }
      const userBubble: ChatMessage = {
        role: "user",
        text: thinkPrompt,
        batch: true,
        batchCount: n,
        batchMode: "think",
      };
      const assistantSeed: ChatMessage = {
        role: "assistant",
        text: "",
        batchAgents: Array.from({ length: n }, (_, i) => ({
          index: i,
          prompt: `Attempt ${i + 1}`,
          status: "running" as const,
          text: "",
        })),
        reconcilerStatus: "pending",
      };
      updateActiveMessages((prev) => [...prev, userBubble, assistantSeed]);
      const projectInstructions = activeChat?.projectId
        ? getProject(activeChat.projectId)?.instructions ?? null
        : null;
      const result = await window.flexhaul.chat.sendThink({
        prompt: applyTone(thinkPrompt, selectedTone),
        attempts: n,
        model: settings.model,
        projectInstructions,
        permissionMode: effectivePermissionMode,
      });
      if ("error" in result) {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `/think failed: ${result.error}` },
        ]);
      } else {
        setStreaming(true);
      }
      setSending(false);
      return;
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
      // v0.1.30: real parallel batch. Push the user bubble + an
      // empty assistant bubble with batchAgents seeded, then fire
      // the dedicated sendBatch IPC. The onBatchAgent* listeners
      // (see chat-events effect) update the assistant bubble live.
      userBubble = { role: "user", text, batch: true, batchCount: prompts.length };
      const assistantSeed: ChatMessage = {
        role: "assistant",
        text: "",
        batchAgents: prompts.map((p, i) => ({
          index: i,
          prompt: p,
          status: "running",
          text: "",
        })),
        reconcilerStatus: "pending",
      };
      updateActiveMessages((prev) => [...prev, userBubble, assistantSeed]);

      const projectInstructions = activeChat?.projectId
        ? getProject(activeChat.projectId)?.instructions ?? null
        : null;
      const result = await window.flexhaul.chat.sendBatch({
        prompts: prompts.map((p) => applyTone(p, selectedTone)),
        model: settings.model,
        projectInstructions,
        permissionMode: effectivePermissionMode,
      });
      if ("error" in result) {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `Batch failed: ${result.error}` },
        ]);
      } else {
        setStreaming(true);
      }
      setSending(false);
      return;
    } else {
      toSend = buildMessageWithAttachments(text, filesAtSend);
      // v0.1.40: append vault-note bodies (from `[[<title>]]` autocomplete)
      // as turn context. Display bubble shows the bracketed wikilink only —
      // claude sees the full body via the appended block below.
      const vaultsAtSend = vaultAttached;
      if (vaultsAtSend.length > 0) {
        const refs = vaultsAtSend
          .map(
            (a) =>
              `## [[${a.title}]] (from Obsidian vault: ${a.relPath})\n\n${a.body.trim()}`,
          )
          .join("\n\n---\n\n");
        toSend = `${toSend}\n\nLinked vault notes (full content, treat as authoritative reference):\n\n${refs}`;
      }
      // v0.1.47: cross-session recall (claude-mem-inspired). On the FIRST
      // user turn of a chat, ask the main process to embed the message
      // and find similar past sessions via cosine. If we find a top-1
      // match (cosine ≥ 0.30), inject its summary as context. Fire-and-
      // wait briefly: 800ms timeout in main process, ~100ms overhead
      // typical. Worst case: timeout returns no hits, turn proceeds
      // unchanged. Never blocks beyond the timeout.
      const isFirstTurn =
        (activeChat?.messages.filter((m) => m.role === "user").length ?? 0) === 0;
      if (isFirstTurn && text.trim().length >= 8) {
        try {
          const { hits } = await window.flexhaul.session.recall({
            queryText: text,
            excludeChatId: activeChat?.id,
            projectId: activeChat?.projectId ?? null,
            limit: 1,
          });
          if (hits && hits.length > 0) {
            const top = hits[0];
            toSend =
              `<!-- Prism cross-session recall (v0.1.47): retrieved a relevant past chat by cosine ${top.score.toFixed(2)}. Use this as context if helpful; do NOT repeat it back to the user unless asked. -->\n\n` +
              `## From a previous Prism chat: "${top.title}"\n\n${top.summary}\n\n---\n\n` +
              toSend;
          }
        } catch {
          /* recall is best-effort — never block the turn */
        }
      }
      const attachBits: string[] = [];
      if (filesAtSend.length > 0) {
        attachBits.push(
          `+${filesAtSend.length} file${filesAtSend.length === 1 ? "" : "s"}`,
        );
      }
      if (vaultsAtSend.length > 0) {
        attachBits.push(
          `+${vaultsAtSend.length} vault note${vaultsAtSend.length === 1 ? "" : "s"}`,
        );
      }
      const displayText =
        attachBits.length > 0
          ? `${text}\n\n[${attachBits.join(" · ")}]`
          : text;
      userBubble = { role: "user", text: displayText };
      // Clear vault attachments after the send is queued so the next
      // turn starts fresh (matching how file attachments are consumed).
      if (vaultsAtSend.length > 0) setVaultAttached([]);
    }
    updateActiveMessages((prev) => [...prev, userBubble]);

    // Send via IPC. Resume the chat's claude session if we have one.
    const sessionId = activeChat?.claudeSessionId ?? null;
    // v0.1.29: if the chat belongs to a project, surface its
    // instructions so the main process can inject them as a
    // system-prompt prefix.
    const projectInstructions = activeChat?.projectId
      ? getProject(activeChat.projectId)?.instructions ?? null
      : null;
    // v0.1.55: apply tone preset to the wire payload only — display
    // bubble keeps the user's clean text.
    const wireMessage = applyTone(toSend, selectedTone);
    const result = await window.flexhaul.chat.send({
      message: wireMessage,
      model: settings.model,
      sessionId,
      projectInstructions,
      permissionMode: effectivePermissionMode,
    });
    if ("error" in result) {
      updateActiveMessages((prev) => [
        ...prev,
        { role: "system", text: `Send failed: ${result.error}` },
      ]);
    } else {
      // v0.1.52: fire provenance gather in parallel with the LLM. Trace
      // attaches to the assistant message (matched by turnId) when ready
      // — usually after the stream starts but possibly before, depending
      // on cache state.
      // v0.1.57: trace now arrives via the main-process emit
      // (provenance.onTrace) — already wired in a separate effect.
      // The main process also injects the trace's top hits into the
      // LLM prompt, so the assistant text can cite [[Note]] directly.
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
    // v0.1.40: vault autocomplete navigation when the [[…]] dropdown is open.
    // Same model as slash commands — ↑/↓ navigate, Enter/Tab accept, Esc close.
    if (vaultOpen) {
      const ranked = rankVaultNotes(vaultNotes, vaultQuery);
      const visible = ranked.length;
      if (visible > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setVaultIndex((i) => (i + 1) % visible);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setVaultIndex((i) => (i - 1 + visible) % visible);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const n = ranked[Math.max(0, Math.min(vaultIndex, visible - 1))];
          if (n) acceptVaultNote(n);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setVaultOpen(false);
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

  // v0.1.29: filter by active project on top of any search filter.
  let visibleChats = searchQuery ? searchChats(searchQuery) : chats;
  if (activeProjectId !== null) {
    visibleChats = visibleChats.filter((c) => c.projectId === activeProjectId);
  }

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
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        activeProjectId={activeProjectId}
        onSelectProject={handleSelectProject}
        onManageProjects={() => setProjectManagerOpen(true)}
        onMoveChatToProject={handleMoveChatToProject}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        streamingChatId={streaming ? activeId : null}
        savedToVault={savedToVault}
      />

      <div className={`main-pane${activeArtifact ? " has-artifact" : ""}`}>
        <div className="titlebar">
          <span className="brand">PRISM</span>
          <span className="brand-version">v{version}</span>
          <span style={{ flex: 1 }} />
          {(() => {
            // v0.1.34: session totals — sum tokens/cost across assistant
            // messages in the active chat that carry usage data.
            const totals = messages.reduce(
              (acc, m) => {
                if (m.role === "assistant" && m.usage) {
                  acc.input += m.usage.inputTokens;
                  acc.output += m.usage.outputTokens;
                  acc.cost += m.usage.cost;
                  acc.turns += 1;
                }
                return acc;
              },
              { input: 0, output: 0, cost: 0, turns: 0 },
            );
            if (totals.turns === 0) return null;
            const fmtT = (n: number) =>
              n < 1000 ? String(Math.round(n)) : (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
            const fmtC = (n: number) =>
              n < 0.001
                ? `$${n.toFixed(5)}`
                : n < 0.01
                  ? `$${n.toFixed(4)}`
                  : n < 1
                    ? `$${n.toFixed(3)}`
                    : `$${n.toFixed(2)}`;
            return (
              <span
                className="titlebar-session-pill"
                title={`Session totals across ${totals.turns} turn${totals.turns === 1 ? "" : "s"}: ${totals.input.toLocaleString()} input tokens · ${totals.output.toLocaleString()} output tokens · ${fmtC(totals.cost)}`}
              >
                {fmtT(totals.input + totals.output)} tok · {fmtC(totals.cost)}
              </span>
            );
          })()}
          {/* v0.1.41/v0.1.44: permission-mode chip. Always visible so
              the user knows what state they're in. Click cycles
              ask → preview → bypass → ask. */}
          <button
            className={`titlebar-permission-chip ${settings.permissionMode}`}
            onClick={() => {
              const cycle: Record<string, "ask" | "preview" | "watch" | "bypass"> = {
                ask: "preview",
                preview: "watch",
                watch: "bypass",
                bypass: "ask",
              };
              const next = cycle[settings.permissionMode] ?? "ask";
              const updated = { ...settings, permissionMode: next };
              setSettings(updated);
              saveSettings(updated);
            }}
            title={
              settings.permissionMode === "bypass"
                ? "Bypass — claude executes freely, no snapshot. Click for Ask. ⌘⇧P toggles Ask↔Bypass."
                : settings.permissionMode === "preview"
                  ? "Preview (v0.1.44) — snapshot first, then execute. Reversible via tmutil. Click for Watch."
                  : settings.permissionMode === "watch"
                    ? "Watch (v0.1.53) — bypass-fast, pauses on risky messages. Click for Bypass."
                    : "Ask — claude reads + proposes but won't modify files. Click for Preview."
            }
          >
            {settings.permissionMode === "bypass" ? (
              <>
                <span className="titlebar-permission-icon">⚡</span> Bypass
              </>
            ) : settings.permissionMode === "preview" ? (
              <>
                <span className="titlebar-permission-icon">🧪</span> Preview
              </>
            ) : settings.permissionMode === "watch" ? (
              <>
                <span className="titlebar-permission-icon">👀</span> Watch
              </>
            ) : (
              <>
                <span className="titlebar-permission-icon">🔒</span> Ask
              </>
            )}
          </button>
          {mcpStatus && mcpStatus.servers.length > 0 ? (
            <button
              className="titlebar-mcp-chip"
              onClick={() => {
                setSettingsInitialTab("mcp");
                setSettingsOpen(true);
              }}
              title={`${mcpStatus.servers
                .filter((s) => s.status === "connected")
                .map((s) => s.name)
                .join(", ") || "no MCP servers connected"} · click to manage`}
            >
              <span
                className={`titlebar-mcp-dot ${
                  mcpStatus.servers.some((s) => s.status === "failed")
                    ? "warn"
                    : "ok"
                }`}
              />
              MCP·{mcpStatus.servers.filter((s) => s.status === "connected").length}
            </button>
          ) : null}
          {/* v0.1.67: native <select> for the model chip.
              History: v0.1.60 introduced a custom popover dropdown
              that never opened reliably. Two attempts to fix
              (position:fixed + JS coords in v0.1.66, no-drag in
              v0.1.67) didn't ship a working UI. Native <select>
              sidesteps every Electron drag-region / overflow /
              focus / z-index issue and gives free keyboard +
              VoiceOver support. The chip styling is preserved via
              appearance:none on the select itself. */}
          <div
            className="titlebar-model-wrap"
            ref={modelPickerRef}
            style={{ position: "relative" }}
          >
            <select
              className="titlebar-model-chip titlebar-model-native"
              value={settings.model}
              onChange={(e) => {
                const updated = { ...settings, model: e.target.value };
                setSettings(updated);
                saveSettings(updated);
              }}
              title={
                settings.model === "auto" && routedModel
                  ? `Auto-router picked ${shortModelName(routedModel)} (${routedModel}). Click to pick a different model.`
                  : `Current model: ${settings.model}. Click to pick a different model.`
              }
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.id === "auto"
                    ? routedModel
                      ? `Auto · ${shortModelName(routedModel)}`
                      : "Auto"
                    : `${opt.label}`}
                </option>
              ))}
            </select>
          </div>
          <button
            className={`titlebar-button${pinned ? " active" : ""}`}
            onClick={togglePinned}
            title={pinned ? "Unpin window (currently always-on-top)" : "Pin window (always-on-top)"}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
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
            <SettingsIcon size={14} />
            {memoryPending ? <span className="titlebar-button-dot" /> : null}
          </button>
        </div>

        <SettingsModal
          open={settingsOpen}
          onClose={() => {
            setSettingsOpen(false);
            // Clear the override so the next "regular" settings open
            // returns to the General tab.
            setSettingsInitialTab(undefined);
          }}
          onChange={setSettings}
          current={settings}
          initialTab={settingsInitialTab}
        />

        <ProjectManager
          open={projectManagerOpen}
          onClose={() => {
            setProjectManagerOpen(false);
            setEditingProjectId(null);
          }}
          projects={projects}
          initialEditId={editingProjectId}
          onCreate={handleCreateProject}
          onUpdate={handleUpdateProject}
          onDelete={handleDeleteProject}
        />

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={buildCommandItems({
            chats,
            projects,
            skills: commands,
            activeProjectId,
            pinned,
            density: settings.density ?? "normal",
            actions: {
              newChat: handleNewChat,
              openProjectManager: () => setProjectManagerOpen(true),
              selectProject: handleSelectProject,
              selectChat: handleSelectChat,
              openSettings: (_tab) => setSettingsOpen(true),
              togglePinned,
              toggleVoice,
              openSideChat: () => setSideChatOpen(true),
              setDensity: (d) => {
                const next = { ...settings, density: d };
                setSettings(next);
                saveSettings(next);
              },
              exportActiveChat: () => {
                if (activeChat) downloadChatAsMarkdown(activeChat);
              },
              runSkill: (name) => {
                setInput((curr) => (curr ? `${curr} /${name}` : `/${name} `));
                composerRef.current?.focus();
              },
            },
          })}
        />

        {shortcutsOpen && (
          <div
            className="shortcut-overlay"
            onClick={() => setShortcutsOpen(false)}
          >
            <div
              className="shortcut-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shortcut-modal-head">
                <span>Keyboard shortcuts</span>
                <button
                  className="shortcut-close"
                  onClick={() => setShortcutsOpen(false)}
                  title="Close (? or Esc)"
                >
                  <XIcon size={14} strokeWidth={2.2} />
                </button>
              </div>
              <div className="shortcut-grid">
                {[
                  ["⌘K", "Command palette"],
                  ["⌘N", "New chat"],
                  ["⌘1", "Toggle sidebar"],
                  ["⌘;", "Side chat"],
                  ["⌘B", "Batch mode"],
                  ["/think", "Best-of-N rerank"],
                  ["⌘F", "Find in chat"],
                  ["⌘E", "Event stream viewer"],
                  ["⌘⇧S", "Save turn to Obsidian"],
                  ["⌘⇧P", "Toggle Ask ↔ Bypass permissions"],
                  ["⌘⏎", "Approve & execute proposed plan"],
                  ["[[…", "Link vault note (autocomplete)"],
                  ["⌘,", "Settings"],
                  ["?", "This overlay"],
                  ["⌘⇧0", "Model → Auto"],
                  ["⌘⇧1", "Model → Haiku"],
                  ["⌘⇧2", "Model → Sonnet"],
                  ["⌘⇧3", "Model → Opus"],
                  ["Enter", "Send · Edit · Branch"],
                  ["⇧Enter", "Newline · Prev match"],
                  ["Esc", "Close panel / find / palette"],
                ].map(([k, label]) => (
                  <div className="shortcut-row" key={String(k)}>
                    <kbd>{k}</kbd>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="shortcut-footer">
                Paste an image into the composer to attach it.
              </div>
            </div>
          </div>
        )}

        <EventStream
          open={eventStreamOpen}
          onClose={() => {
            setEventStreamOpen(false);
            setReplayFocusIdx(null);
          }}
          tools={(() => {
            // v0.1.43: if user clicked Replay on a specific message, show
            // THAT turn's tools. Otherwise default to the most recent
            // assistant message's tool list.
            if (
              replayFocusIdx !== null &&
              replayFocusIdx >= 0 &&
              replayFocusIdx < messages.length
            ) {
              return messages[replayFocusIdx].tools ?? [];
            }
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i];
              if (m.role === "assistant" && m.tools && m.tools.length > 0) {
                return m.tools;
              }
            }
            return [];
          })()}
          turnStartedAt={
            replayFocusIdx !== null
              ? messages[replayFocusIdx]?.tools?.[0]?.startedAt ?? null
              : turnStartedAt
          }
          replayLabel={
            replayFocusIdx !== null
              ? `turn ${
                  messages
                    .slice(0, replayFocusIdx + 1)
                    .filter((m) => m.role === "user").length
                }`
              : null
          }
        />

        {sideChatOpen ? (
          <aside className="side-chat" ref={sideChatRef}>
            <div className="side-chat-head">
              <span className="side-chat-label">Side Chat</span>
              <span className="side-chat-hint">
                temporary · ⌘; or Esc to close
              </span>
              <button
                className="side-chat-close"
                onClick={() => setSideChatOpen(false)}
                title="Close (⌘;)"
              >
                <XIcon size={13} strokeWidth={2.2} />
              </button>
            </div>
            <div className="side-chat-body">
              {sideChatMessages.length === 0 ? (
                <div className="side-chat-empty">
                  Scratch any question here. Doesn't touch the main
                  thread. Closes anytime.
                </div>
              ) : (
                sideChatMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`side-chat-msg side-chat-msg-${m.role}`}
                  >
                    {m.text || (sideChatStreaming && i === sideChatMessages.length - 1
                      ? "…"
                      : "")}
                  </div>
                ))
              )}
            </div>
            <div className="side-chat-composer">
              <textarea
                value={sideChatInput}
                onChange={(e) => setSideChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendSideChat();
                  }
                }}
                placeholder="Quick question…"
                rows={2}
              />
              <button
                onClick={() => void sendSideChat()}
                disabled={!sideChatInput.trim() || sideChatStreaming}
              >
                {sideChatStreaming ? "…" : "Send"}
              </button>
            </div>
          </aside>
        ) : null}

        {(updateState.kind === "available" || updateState.kind === "downloaded") && (
          <div
            className={`update-banner${
              updateState.kind === "downloaded" ? " ready" : ""
            }`}
          >
            <span className="update-banner-dot" />
            <span className="update-banner-text">
              {updateState.kind === "downloaded"
                ? `Update v${updateState.version} ready`
                : `Downloading update v${updateState.version}…`}
            </span>
            {updateState.kind === "downloaded" && (
              <button
                className="update-banner-cta"
                onClick={async () => {
                  // v0.1.34: actually quit + relaunch with the new bundle,
                  // not a renderer reload. quitAndInstall triggers
                  // Squirrel.Mac to swap the .app bundle on disk.
                  try {
                    await window.flexhaul.installUpdate();
                  } catch {
                    // If the IPC fails (e.g. dev mode without updater),
                    // fall back to a hard reload so at least the UI
                    // reflects fresh state.
                    location.reload();
                  }
                }}
              >
                Restart now
              </button>
            )}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        {findOpen && (() => {
          const q = findQuery.trim().toLowerCase();
          const matchIdx = q
            ? messages
                .map((m, i) => (m.text.toLowerCase().includes(q) ? i : -1))
                .filter((i) => i >= 0)
            : [];
          const total = matchIdx.length;
          const safeIdx =
            total === 0 ? 0 : ((findIndex % total) + total) % total;
          const jumpTo = (idx: number) => {
            if (matchIdx.length === 0) return;
            const target = matchIdx[idx];
            const el = chatRef.current?.querySelector(
              `[data-msg-idx="${target}"]`,
            ) as HTMLElement | null;
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          };
          return (
            <div className="find-bar">
              <input
                ref={findInputRef}
                className="find-bar-input"
                autoFocus
                value={findQuery}
                placeholder="Find in chat…"
                onChange={(e) => {
                  setFindQuery(e.target.value);
                  setFindIndex(0);
                  if (e.target.value.trim()) {
                    requestAnimationFrame(() => {
                      const q2 = e.target.value.trim().toLowerCase();
                      const next = messages.findIndex((m) =>
                        m.text.toLowerCase().includes(q2),
                      );
                      if (next >= 0) {
                        const el = chatRef.current?.querySelector(
                          `[data-msg-idx="${next}"]`,
                        ) as HTMLElement | null;
                        el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }
                    });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const next = e.shiftKey ? safeIdx - 1 : safeIdx + 1;
                    setFindIndex(next);
                    jumpTo(((next % total) + total) % total);
                  }
                  if (e.key === "Escape") {
                    setFindOpen(false);
                    setFindQuery("");
                  }
                }}
              />
              <span className="find-bar-count">
                {q ? (total > 0 ? `${safeIdx + 1} / ${total}` : "No matches") : ""}
              </span>
              <button
                className="find-bar-btn"
                onClick={() => {
                  const next = safeIdx - 1;
                  setFindIndex(next);
                  jumpTo(((next % total) + total) % total);
                }}
                disabled={total === 0}
                title="Previous match (⇧Enter)"
              >
                ↑
              </button>
              <button
                className="find-bar-btn"
                onClick={() => {
                  const next = safeIdx + 1;
                  setFindIndex(next);
                  jumpTo(((next % total) + total) % total);
                }}
                disabled={total === 0}
                title="Next match (Enter)"
              >
                ↓
              </button>
              <button
                className="find-bar-btn"
                onClick={() => {
                  setFindOpen(false);
                  setFindQuery("");
                }}
                title="Close (Esc)"
              >
                ×
              </button>
            </div>
          );
        })()}

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
              <div className="starter-grid">
                {[
                  {
                    label: "Compare three approaches",
                    text:
                      "Compare three different approaches to building a real-time collaborative editor — operational transforms, CRDTs, and server-authoritative diffing. Pros, cons, when each wins.",
                  },
                  {
                    label: "Explain a concept simply",
                    text:
                      "Explain what a vector embedding is to a developer who knows linear algebra but has never built an ML system. Concrete examples, not just theory.",
                  },
                  {
                    label: "Plan a feature",
                    text:
                      "I want to add real-time presence (who's online, what they're looking at) to a Next.js app already using Supabase. Walk me through the architecture, tradeoffs, and the first PR.",
                  },
                  {
                    label: "/think — best of 3 attempts",
                    text:
                      "/think Design a rate-limit strategy for a public API that needs to be fair across users. Walk through algorithm choice, where to store state, and how to handle the burst-vs-sustained tradeoff.",
                  },
                ].map((s) => (
                  <button
                    key={s.label}
                    className="starter-chip"
                    onClick={() => setInput(s.text)}
                    title={s.text}
                  >
                    <span className="starter-chip-label">{s.label}</span>
                    <span className="starter-chip-arrow">→</span>
                  </button>
                ))}
              </div>
              <div className="hint">
                <kbd>Enter</kbd> send · <kbd>⌘</kbd>+<kbd>B</kbd> batch ·{" "}
                <kbd>⌘</kbd>+<kbd>K</kbd> palette · <kbd>⌘</kbd>+<kbd>;</kbd> side chat
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
                      permissionMode: settings.permissionMode,
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
            // v0.1.29: branch action on user messages. Clones the
            // conversation up to and including this message into a
            // fresh chat, then activates it. Useful when you want to
            // explore a different direction without losing the
            // original thread.
            const onBranch =
              m.role === "user" && activeId
                ? () => handleFork(activeId, i)
                : undefined;
            const findQ = findOpen ? findQuery.trim().toLowerCase() : "";
            const isFindMatch = findQ ? m.text.toLowerCase().includes(findQ) : false;
            return (
              <div
                key={i}
                data-msg-idx={i}
                className={`msg-wrap${isFindMatch ? " find-match" : ""}`}
              >
                <Message
                  message={m}
                  streaming={isStreaming}
                  onEdit={onEdit}
                  onBranch={onBranch}
                  artifacts={messageArtifacts}
                  onOpenArtifact={setActiveArtifact}
                  activeArtifactId={activeArtifact?.id ?? null}
                  density={settings.density ?? "normal"}
                  onFeedback={
                    m.role === "assistant"
                      ? (fb) => {
                          // v0.1.38: persist feedback on the assistant message
                          // and fire a feedback-aware re-extraction. The
                          // preceding user message + this assistant text get
                          // re-mined with the feedback signal, which routes
                          // the extracted preferences into the right
                          // dimension (anti_patterns for "down",
                          // communication_style reinforcement for "up").
                          const userBefore =
                              i > 0 && messages[i - 1]?.role === "user"
                                ? messages[i - 1].text
                                : "";
                          updateActiveMessages((prev) => {
                            if (i >= prev.length) return prev;
                            const next = [...prev];
                            const target = next[i];
                            if (target.role !== "assistant") return prev;
                            next[i] = fb
                              ? { ...target, feedback: fb }
                              : (() => {
                                  const { feedback: _drop, ...rest } = target;
                                  return rest;
                                })();
                            return next;
                          });
                          if (fb && userBefore && m.text) {
                            window.flexhaul.profile
                              .extractWithFeedback?.({
                                userMessage: userBefore,
                                assistantText: m.text,
                                feedback: fb,
                              })
                              .catch(() => {});
                          }
                        }
                      : undefined
                  }
                  onApproveExecute={
                    m.role === "assistant" && i === messages.length - 1
                      ? () => approveAndExecute()
                      : undefined
                  }
                  onReplay={
                    m.role === "assistant" && m.tools && m.tools.length > 0
                      ? () => {
                          setReplayFocusIdx(i);
                          setEventStreamOpen(true);
                        }
                      : undefined
                  }
                  previewScope={settings.previewScope || undefined}
                  onResolveCommitment={
                    m.role === "assistant" && m.commitments && m.commitments.length > 0
                      ? async (id, outcome) => {
                          const res = await window.flexhaul.commitments.resolve({
                            id,
                            outcome,
                          });
                          if ("ok" in res && res.ok) {
                            updateActiveMessages((prev) =>
                              prev.map((mm) =>
                                mm.role === "assistant" &&
                                mm.commitments &&
                                mm.commitments.some((cc) => cc.id === id)
                                  ? {
                                      ...mm,
                                      commitments: mm.commitments.map((cc) =>
                                        cc.id === id ? res.commitment : cc,
                                      ),
                                    }
                                  : mm,
                              ),
                            );
                          }
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>

        <div className={`composer ${batchMode ? "batch-active" : ""}`}>
          {batchMode ? (
            <div className="fanout-banner">
              <span className="fanout-banner-icon">⇶</span>
              <span className="fanout-banner-title">Fan-out mode</span>
              <span className="fanout-banner-detail">
                One prompt per line. Each line spawns a parallel agent.
                Haiku reconciles the N answers into one.
              </span>
              <span className="fanout-banner-count">
                {batchPromptCount}{" "}
                {batchPromptCount === 1 ? "agent" : "agents"} queued
              </span>
            </div>
          ) : null}
          <SlashCommandMenu
            open={slashOpen}
            query={slashQuery}
            commands={commands}
            selectedIndex={slashIndex}
            onSelect={acceptSlash}
            onHoverIndex={setSlashIndex}
          />
          <VaultAutocomplete
            open={vaultOpen}
            query={vaultQuery}
            notes={vaultNotes}
            selectedIndex={vaultIndex}
            onSelect={acceptVaultNote}
            onHoverIndex={setVaultIndex}
          />
          {vaultAttached.length > 0 ? (
            <div className="vault-attached">
              {vaultAttached.map((a) => (
                <button
                  key={a.relPath}
                  className="vault-attached-chip"
                  onClick={() => {
                    setVaultAttached((prev) =>
                      prev.filter((p) => p.relPath !== a.relPath),
                    );
                  }}
                  title={`Click to remove · ${a.relPath}`}
                >
                  <span className="vault-attached-bracket">[[</span>
                  {a.title}
                  <span className="vault-attached-bracket">]]</span>
                  <span className="vault-attached-x">×</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer-hint">
            <span>
              {batchMode
                ? "Batch · one prompt per line · ⌘⏎ to send"
                : "⏎ send · ⇧⏎ newline · ⌘B batch"}
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
          {/* v0.1.55: Tone targeting — sticky audience preset row. */}
          <div className="tone-row" title="Audience tone — prepended as a system tag to your next message">
            {TONE_PRESETS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tone-chip ${selectedTone === t.id ? "active" : ""}`}
                onClick={() => setSelectedTone(t.id)}
                title={t.hint}
              >
                <span className="tone-chip-emoji">{t.emoji}</span>
                <span className="tone-chip-label">{t.label}</span>
              </button>
            ))}
          </div>
          {/* v0.1.53: Watch-mode pre-flight banner. Surfaces when the
              composed message hits a destructive / egress / money /
              counterparty trigger. User picks Proceed (one-shot
              Bypass) or Switch to Ask. */}
          {watchBanner ? (
            <div
              className={`watch-banner watch-banner-${watchBanner.evaluation.level}`}
            >
              <div className="watch-banner-head">
                <span className="watch-banner-icon">
                  {watchBanner.evaluation.level === "high" ? "🛑" : "👀"}
                </span>
                <div className="watch-banner-title">
                  Watch mode flagged this message
                </div>
                <span className="watch-banner-level">
                  {watchBanner.evaluation.level} · severity{" "}
                  {watchBanner.evaluation.totalSeverity}
                </span>
              </div>
              <div className="watch-banner-triggers">
                {watchBanner.evaluation.triggers.map((t: WatchTrigger, i: number) => (
                  <div className="watch-banner-trigger" key={i}>
                    <span
                      className={`watch-banner-trigger-cat watch-banner-trigger-cat-${t.category}`}
                    >
                      {t.category}
                    </span>
                    <code className="watch-banner-trigger-match">{t.match}</code>
                    <span className="watch-banner-trigger-why">{t.why}</span>
                  </div>
                ))}
              </div>
              <div className="watch-banner-actions">
                <button
                  className="watch-banner-action watch-banner-action-proceed"
                  onClick={() => {
                    watchOverrideRef.current = "bypass";
                    setWatchBanner(null);
                    void send();
                  }}
                  title="One-shot Bypass for just this message. Your default mode stays Watch."
                >
                  <span>⚡</span> Proceed (one-shot Bypass)
                </button>
                <button
                  className="watch-banner-action watch-banner-action-downgrade"
                  onClick={() => {
                    watchOverrideRef.current = "ask";
                    setWatchBanner(null);
                    void send();
                  }}
                  title="Downgrade this message to Ask — claude proposes, you approve."
                >
                  <span>🔒</span> Switch to Ask
                </button>
                <button
                  className="watch-banner-action watch-banner-action-cancel"
                  onClick={() => setWatchBanner(null)}
                >
                  Cancel — edit message
                </button>
              </div>
            </div>
          ) : null}
          <div className="composer-row">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                // v0.1.40: detect [[…]] trigger and open vault autocomplete.
                const caret = e.target.selectionStart ?? value.length;
                const trigger = detectVaultTrigger(value, caret);
                if (trigger) {
                  setVaultQuery(trigger.query);
                  setVaultIndex(0);
                  setVaultOpen(true);
                } else if (vaultOpen) {
                  setVaultOpen(false);
                }
              }}
              onKeyUp={(e) => {
                // Re-evaluate the trigger on arrow keys / paste / etc.
                // that move the caret without changing value.
                const t = e.currentTarget;
                const trigger = detectVaultTrigger(
                  t.value,
                  t.selectionStart ?? t.value.length,
                );
                if (!trigger && vaultOpen) setVaultOpen(false);
              }}
              onKeyDown={onTextareaKey}
              onPaste={(e) => {
                // v0.1.35: paste-to-attach for screenshots. When clipboard
                // has image data, swallow the paste and route it through
                // saveAttachment instead of trying to dump it as base64
                // text. Falls through to default paste for non-image data.
                const items = e.clipboardData?.items;
                if (!items) return;
                const files: File[] = [];
                for (let i = 0; i < items.length; i++) {
                  const it = items[i];
                  if (it.kind === "file" && it.type.startsWith("image/")) {
                    const f = it.getAsFile();
                    if (f) {
                      // Clipboard images come in as "image.png" with the
                      // current timestamp — rename so multiple pastes don't
                      // collide in the uploads dir.
                      const ts = Date.now();
                      const ext = (f.type.split("/")[1] ?? "png").toLowerCase();
                      files.push(
                        new File([f], `pasted-${ts}.${ext}`, { type: f.type }),
                      );
                    }
                  }
                }
                if (files.length > 0) {
                  e.preventDefault();
                  void handleFiles(files);
                }
              }}
              placeholder={
                batchMode
                  ? "Summarize last week's Apollo replies\nDraft a 5-line follow-up to Tyson\nWhat changed in the FlexHaul rate card last 14 days?\n…each line above runs as its own parallel agent"
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
                <Paperclip size={15} strokeWidth={1.8} />
              </button>
              <button
                className={`composer-voice${voiceRecording ? " recording" : ""}`}
                onClick={toggleVoice}
                title={
                  voiceRecording
                    ? "Stop recording"
                    : "Voice input (browser dictation)"
                }
              >
                {voiceRecording ? (
                  <Square size={12} fill="currentColor" />
                ) : (
                  <Mic size={15} strokeWidth={1.8} />
                )}
              </button>
              <button
                className={`batch-toggle ${batchMode ? "active" : ""}`}
                onClick={() => setBatchMode((v) => !v)}
                title={
                  batchMode
                    ? `Fan-out mode is ON. Each line in the composer becomes a parallel agent. Currently ${batchPromptCount} prompt${batchPromptCount === 1 ? "" : "s"} detected. ⌘B to toggle off.`
                    : "Turn on fan-out: type N prompts (one per line), they run as N parallel agents reconciled into one answer. ⌘B"
                }
              >
                {batchMode
                  ? `▲ FAN-OUT · ${batchPromptCount}`
                  : "FAN-OUT"}
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
                  className="composer-send"
                  onClick={send}
                  disabled={
                    !claudeReady ||
                    (!input.trim() && attachedFiles.length === 0) ||
                    sending ||
                    (batchMode && batchPromptCount === 0)
                  }
                  title={
                    batchMode
                      ? batchPromptCount > 1
                        ? `Run ${batchPromptCount} agents in parallel`
                        : "Type at least one prompt (one per line for fan-out)"
                      : undefined
                  }
                >
                  {sending
                    ? "…"
                    : batchMode && batchPromptCount > 0
                      ? `Run ${batchPromptCount} →`
                      : "Send"}
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
