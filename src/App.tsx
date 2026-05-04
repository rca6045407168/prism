import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { GatewayClient, ChatMessage } from "./gateway";
import { SetupWizard } from "./SetupWizard";
import { SettingsModal, loadSettings, saveSettings, MODEL_OPTIONS, Settings } from "./Settings";
import { Message } from "./Message";
import { Sidebar } from "./Sidebar";
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

export function App() {
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Boot the gateway client when setup is complete
  const bootGateway = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.flexhaul.getGatewayConfig();
        if (cfg.error) {
          if (!cancelled) setError(cfg.error);
          return;
        }
        if (!cfg.token) {
          if (!cancelled)
            setError("Prism runtime paired but no operator token found. Re-run setup.");
          return;
        }
        const c = new GatewayClient(cfg.url, cfg.token, (msg) => {
          if (cancelled) return;
          updateActiveMessages((prev) => [...prev, msg]);
        });

        // Streaming: append a placeholder assistant message at start, mutate
        // its text in place on each delta, finalize on end.
        c.onStream((ev) => {
          if (cancelled) return;
          if (ev.kind === "start") {
            updateActiveMessages((prev) => [
              ...prev,
              { role: "assistant", text: "" },
            ]);
            setStreaming(true);
          } else if (ev.kind === "delta") {
            updateActiveMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === "assistant") {
                next[next.length - 1] = { ...last, text: last.text + ev.text };
              }
              return next;
            });
          } else if (ev.kind === "end") {
            setStreaming(false);
            // If runtime sent a final non-empty text and we accumulated nothing,
            // backfill so we don't show an empty bubble.
            updateActiveMessages((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.role === "assistant" && last.text === "" && ev.finalText) {
                const next = [...prev];
                next[next.length - 1] = { ...last, text: ev.finalText };
                return next;
              }
              return prev;
            });
          } else if (ev.kind === "error") {
            setStreaming(false);
            updateActiveMessages((prev) => [
              ...prev,
              { role: "system", text: `Error: ${ev.error}` },
            ]);
          }
        });

        await c.connect();
        if (cancelled) return;
        setClient(c);
      } catch (e: any) {
        if (!cancelled) setError(`Failed to connect: ${e.message ?? String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateActiveMessages]);

  useEffect(() => {
    if (setupNeeded === false) return bootGateway();
  }, [setupNeeded, bootGateway]);

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
    if (!client || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    if (batchMode) {
      const prompts = text
        .split("\n")
        .map((l) => l.replace(/^[\s\-*\d.)]+/, "").trim())
        .filter((l) => l && !l.startsWith("#"));
      if (prompts.length === 0) {
        setSending(false);
        return;
      }
      updateActiveMessages((prev) => [
        ...prev,
        { role: "user", text, batch: true, batchCount: prompts.length },
      ]);
      try {
        await client.send(`/batch\n${prompts.join("\n")}`, settings.model);
      } catch (e: any) {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    } else {
      updateActiveMessages((prev) => [...prev, { role: "user", text }]);
      try {
        await client.send(text, settings.model);
      } catch (e: any) {
        updateActiveMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    }
    setSending(false);
  }, [client, input, batchMode, sending, settings.model, updateActiveMessages]);

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !batchMode) {
      e.preventDefault();
      send();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && batchMode) {
      e.preventDefault();
      send();
    }
  };

  // Setup wizard / loading gate
  if (setupNeeded === true) {
    return <SetupWizard onComplete={() => setSetupNeeded(false)} />;
  }
  if (setupNeeded === null) {
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
        Loading…
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
        onToggle={() => setSidebarCollapsed((v) => !v)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className="main-pane">
        <div className="titlebar">
          <span className="brand">PRISM</span>
          <span className="brand-version">v{version}</span>
          <span style={{ flex: 1 }} />
          <button
            className="titlebar-button"
            onClick={() => setSettingsOpen(true)}
            title="Settings (⌘,)"
          >
            ⚙
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

        <div className="chat" ref={chatRef}>
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
            return <Message key={i} message={m} streaming={isStreaming} />;
          })}
        </div>

        <div className={`composer ${batchMode ? "batch-active" : ""}`}>
          <div className="composer-hint">
            <span>
              {batchMode
                ? "Batch · one prompt per line · ⌘+Enter to send"
                : "Enter to send · Shift+Enter for new line · ⌘B to batch"}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
          <div className="composer-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onTextareaKey}
              placeholder={
                batchMode
                  ? "first prompt\nsecond prompt\nthird prompt"
                  : client
                  ? "Ask anything…"
                  : "Starting Prism runtime…"
              }
              rows={batchMode ? 5 : 1}
            />
            <div className="composer-actions">
              <button
                className={`batch-toggle ${batchMode ? "active" : ""}`}
                onClick={() => setBatchMode((v) => !v)}
                title="Toggle batch mode (⌘B)"
              >
                {batchMode ? "▲ BATCH" : "BATCH"}
              </button>
              {streaming ? (
                <button
                  onClick={() => client?.abort()}
                  className="composer-stop"
                  title="Stop generating"
                >
                  ■ Stop
                </button>
              ) : (
                <button onClick={send} disabled={!client || !input.trim() || sending}>
                  {sending ? "…" : "Send"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
