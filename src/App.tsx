import { useEffect, useState, useRef, useCallback } from "react";
import { GatewayClient, ChatMessage } from "./gateway";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

export function App() {
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [sending, setSending] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Boot: discover gateway, connect, wire update events
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await window.flexhaul.getAppVersion();
        if (!cancelled) setVersion(v);

        const cfg = await window.flexhaul.getGatewayConfig();
        if (cfg.error) {
          if (!cancelled) setError(cfg.error);
          return;
        }
        if (!cfg.token) {
          if (!cancelled)
            setError(
              "OpenClaw paired but no operator token found. Pair a desktop device in the OpenClaw dashboard.",
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

    return () => {
      cancelled = true;
      off.forEach((fn) => fn());
    };
  }, []);

  // Auto-scroll on new message
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

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
        { role: "user", text: text, batch: true, batchCount: prompts.length },
      ]);
      try {
        await client.send(`/batch\n${prompts.join("\n")}`);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    } else {
      setMessages((prev) => [...prev, { role: "user", text }]);
      try {
        await client.send(text);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          { role: "system", text: `Send failed: ${e.message ?? String(e)}` },
        ]);
      }
    }
    setSending(false);
  }, [client, input, batchMode, sending]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !batchMode) {
      e.preventDefault();
      send();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && batchMode) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="app">
      <div className="titlebar">
        FlexHaul Agent <span className="version">v{version}</span>
      </div>

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
            <h2>FlexHaul Agent</h2>
            <p>
              Connected to local OpenClaw daemon. Send a message to start. Press{" "}
              <code>⌘B</code> or click <strong>Batch</strong> below to fan out N prompts in
              parallel.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.batch && (
              <div className="label batch">
                ⚡ Batch · {m.batchCount} prompts in parallel
              </div>
            )}
            {m.text}
          </div>
        ))}
      </div>

      <div className={`composer ${batchMode ? "batch-mode-active" : ""}`}>
        <div className="composer-hint">
          {batchMode
            ? "Batch mode: one prompt per line. ⌘+Enter to send. Each runs in parallel via the batch-orchestrator skill."
            : "Enter to send · Shift+Enter for new line · ⌘B to toggle batch mode"}
        </div>
        <div className="composer-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              batchMode
                ? "prompt 1\nprompt 2\nprompt 3"
                : client
                ? "Ask anything…"
                : "Connecting…"
            }
            rows={batchMode ? 5 : 1}
          />
          <div className="composer-actions">
            <button
              className={batchMode ? "batch" : ""}
              onClick={() => setBatchMode((v) => !v)}
              title="Toggle batch mode (⌘B)"
            >
              {batchMode ? "← Single" : "Batch ⚡"}
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
