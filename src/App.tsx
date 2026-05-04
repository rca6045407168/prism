import { useEffect, useState, useRef, useCallback } from "react";
import { GatewayClient, ChatMessage } from "./gateway";
import { SetupWizard } from "./SetupWizard";
import { SettingsModal, loadSettings, saveSettings, MODEL_OPTIONS, Settings } from "./Settings";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

const PRICING_URL = "https://prism.run/pricing"; // TODO: replace with real Stripe Payment Link once account exists

export function App() {
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  // Persist chat history across launches (v0.1.2). Loaded synchronously on
  // first render so users don't see the empty state flash.
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem("prism.chat.v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-500) : []; // hard cap to avoid runaway
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Apply theme override
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.theme);
    }
  }, [settings.theme]);

  // Pre-boot: check if first-launch setup is needed.
  // Hard timeout so the Loading screen never spins forever — if status check
  // hangs > 4s, assume setup is needed and show the wizard.
  useEffect(() => {
    let cancelled = false;
    const fallbackTimer = setTimeout(() => {
      if (!cancelled) {
        console.warn("setup status check timed out — showing wizard");
        setSetupNeeded(true);
      }
    }, 4000);

    (async () => {
      try {
        const v = await window.flexhaul.getAppVersion();
        if (!cancelled) setVersion(v);
        const status = await window.flexhaul.setup.status();
        if (cancelled) return;
        const reachable = !!status.daemonReachable;
        clearTimeout(fallbackTimer);
        // Setup needed if either: runtime missing, not paired, or daemon down
        setSetupNeeded(!status.runtimeInstalled || !status.paired || !reachable);
      } catch (e) {
        clearTimeout(fallbackTimer);
        if (!cancelled) setSetupNeeded(true);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, []);

  // Boot the gateway client only when setup is complete
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
            setError(
              "Prism runtime paired but no operator token found. Re-run setup from the menu: Prism → Setup runtime…",
            );
          return;
        }
        const c = new GatewayClient(cfg.url, cfg.token, (msg) => {
          if (cancelled) return;
          setMessages((prev) => [...prev, msg]);
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
  }, []);

  useEffect(() => {
    if (setupNeeded === false) return bootGateway();
  }, [setupNeeded, bootGateway]);

  // Update events (always wired)
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

  // Auto-scroll + persist on every change
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    try {
      localStorage.setItem("prism.chat.v1", JSON.stringify(messages.slice(-500)));
    } catch {
      // localStorage may be full; silently drop persistence rather than crash
    }
  }, [messages]);

  const clearChat = useCallback(() => {
    if (messages.length === 0) return;
    if (
      window.confirm(
        `Clear ${messages.length} messages? This deletes the local chat history. The conversation on the server side is unaffected.`,
      )
    ) {
      setMessages([]);
      localStorage.removeItem("prism.chat.v1");
    }
  }, [messages.length]);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      setMessages((prev) => [
        ...prev,
        { role: "user", text, batch: true, batchCount: prompts.length },
      ]);
      try {
        await client.send(`/batch\n${prompts.join("\n")}`, settings.model);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    } else {
      setMessages((prev) => [...prev, { role: "user", text }]);
      try {
        await client.send(text, settings.model);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    }
    setSending(false);
  }, [client, input, batchMode, sending]);

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

  // Show setup wizard before the main UI if first-launch setup is needed
  if (setupNeeded === true) {
    return <SetupWizard onComplete={() => setSetupNeeded(false)} />;
  }
  if (setupNeeded === null) {
    return <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-mute)" }}>Loading…</div>;
  }

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">PRISM</span>
        <span className="brand-version">v{version}</span>
        <span style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button className="titlebar-button" onClick={clearChat} title="Clear local chat history">
            Clear
          </button>
        )}
        <button className="titlebar-button" onClick={() => setSettingsOpen(true)} title="Settings (⌘,)">
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
              Type N prompts. Get N parallel agents. Reconciled into one answer.
              Routes across any model — Anthropic, OSS, local. Runs on your machine.
            </div>
            <div className="hint">
              Press <kbd>Enter</kbd> to send · <kbd>⌘</kbd>+<kbd>B</kbd> for batch mode
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.batch && (
              <div className="label batch">
                ▲ Batch · {m.batchCount} prompts in parallel
              </div>
            )}
            {m.text}
          </div>
        ))}
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
            <button onClick={send} disabled={!client || !input.trim() || sending}>
              {sending ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
