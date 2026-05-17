/**
 * Thin client for the Prism agent runtime's WebSocket.
 *
 * v0.1.6 protocol:
 *   - Connect to ws://127.0.0.1:18789?token=...
 *   - JSON-RPC-ish requests: { id, method, params } → { id, result }
 *   - Push events: { method: "chat.delta", params: {...} } for streaming
 *
 * Streaming model:
 *   - User-side observable: onAssistantStart / onAssistantDelta / onAssistantEnd
 *   - Each user turn opens a new "stream"; deltas accumulate, end finalizes
 *   - abortCurrentTurn() asks the runtime to stop generating
 *
 * The legacy fields onMessage (callback) is kept for back-compat with
 * earlier versions that received whole messages. Internally we coalesce
 * stream events into onMessage at completion if no streaming listener
 * is provided.
 */

export type ToolEvent = {
  toolUseId: string;
  name: string;
  inputPreview?: string;
  resultPreview?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
  /** v0.1.39: wall-clock timing for the Event Stream Viewer + per-tool
   *  duration pills. `startedAt` is set when the tool_use event arrives;
   *  `durationMs` is computed on tool_result. Pattern lifted from
   *  Agent TARS's runtime-stats / event-stream viewer. */
  startedAt?: number;
  durationMs?: number;
};

export type BatchAgent = {
  index: number;
  prompt: string;
  status: "running" | "done" | "error";
  text: string;
  error?: string;
  tier?: string;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  /** v0.1.52: stamped onto assistant bubbles in chat:start so async
   *  provenance traces can be attached when they arrive. */
  turnId?: string;
  batch?: boolean;
  batchCount?: number;
  /** v0.1.36: discriminates /batch (N different prompts) from /think
   *  (N attempts at same prompt + reranker). Affects label rendering only. */
  batchMode?: "batch" | "think";
  /** Tool calls observed during this assistant turn. v0.1.18. */
  tools?: ToolEvent[];
  /** Real parallel batch result, when this message is the assistant
   *  side of a /batch turn. Each agent has its own live status + text;
   *  reconciled is the Haiku-synthesized final summary. v0.1.30. */
  batchAgents?: BatchAgent[];
  reconciled?: string;
  reconcilerStatus?: "pending" | "running" | "done" | "skipped";
  /** v0.1.34: per-turn usage stats. Set on the assistant message
   *  when its turn finishes. Renders as a footer pill. */
  usage?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cost: number;
    durationMs: number;
    /** v0.1.42/v0.1.44: the permission mode the turn ran under.
     *  - "ask"      → renderer shows "Approve & execute" button
     *  - "preview"  → renderer shows "Review changes" card with snapshot ID
     *  - "bypass"   → no special affordance (live execution, no safety net) */
    permissionMode?: "ask" | "preview" | "bypass";
    /** v0.1.44: APFS local snapshot ID for Preview-mode turns.
     *  User can roll back via `tmutil restore`. */
    previewSnapshot?: {
      id: string;
      fullName: string;
      createdAt: number;
    };
  };
  /** v0.1.38: explicit user feedback on the assistant message. Drives the
   *  profile extractor — "down" turns route extracted preferences into
   *  `anti_patterns` (avoid this); "up" turns reinforce `communication_style`
   *  and other positive dimensions. Inspired by Fast-Slow Training (arxiv
   *  2605.12484) — the "fast weight" half. The "slow weight" half (RL on
   *  base model params) is out of scope; we wrap a frozen claude CLI. */
  feedback?: "up" | "down";
  /** v0.1.52: Provenance Panel trace. Surfaced under the assistant
   *  message as a collapsible "show your work" panel — vault hits
   *  (with graph-walk paths), memory hits, session-recall hits. The
   *  keystone "senior-employee citation trail" feature. */
  provenance?: ProvenanceTrace;
  /** v0.1.54: First-person commitments extracted from the assistant
   *  message ("I will ship by Friday"). Persisted as vault notes in
   *  Commitments/; user can mark them resolved with an outcome. */
  commitments?: Commitment[];
};

export type StreamEvent =
  | { kind: "start"; turnId: string }
  | { kind: "delta"; turnId: string; text: string }
  | { kind: "end"; turnId: string; finalText: string }
  | { kind: "error"; turnId: string; error: string };

type Listener = (msg: ChatMessage) => void;
type StreamListener = (ev: StreamEvent) => void;

let nextId = 1;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, (result: any) => void>();
  private rejecters = new Map<number, (err: Error) => void>();
  private streamListener: StreamListener | null = null;
  // Track in-flight turns by id so abort can target them.
  private currentTurnId: string | null = null;

  constructor(
    private url: string,
    private token: string,
    private onMessage: Listener,
  ) {}

  /** Subscribe to streaming events. Optional — if not set, full assistant
   *  messages still arrive via onMessage on turn end. */
  onStream(cb: StreamListener): void {
    this.streamListener = cb;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      u.searchParams.set("token", this.token);
      this.ws = new WebSocket(u.toString());

      const timer = setTimeout(() => {
        try {
          this.ws?.close();
        } catch {}
        reject(new Error("Gateway connect timed out (6s)"));
      }, 6000);

      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${String(e)}`));
      };
      this.ws.onclose = (e) => {
        clearTimeout(timer);
        if (e.code !== 1000 && e.code !== 1001) {
          this.onMessage({
            role: "system",
            text: `Gateway disconnected (code=${e.code}). ${e.reason || "Restart the app to reconnect."}`,
          });
        }
      };
      this.ws.onmessage = (ev) => this.handle(ev.data);
    });
  }

  private handle(data: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    // Response to a request we sent
    if (parsed.id && this.pending.has(parsed.id)) {
      const cb = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      this.rejecters.delete(parsed.id);
      cb(parsed.result ?? parsed.error ?? null);
      return;
    }

    // Streaming events from the runtime
    const method = parsed.method;
    const params = parsed.params ?? {};
    const turnId = params.turnId ?? params.turn_id ?? "unknown";

    if (method === "chat.start" || method === "chat.delta" || method === "chat.end" || method === "chat.error") {
      if (method === "chat.start") {
        this.currentTurnId = turnId;
        this.streamListener?.({ kind: "start", turnId });
      } else if (method === "chat.delta") {
        const text = String(params.text ?? params.delta ?? "");
        if (text) this.streamListener?.({ kind: "delta", turnId, text });
      } else if (method === "chat.end") {
        const finalText = String(params.text ?? params.final ?? "");
        this.currentTurnId = null;
        this.streamListener?.({ kind: "end", turnId, finalText });
        if (!this.streamListener && finalText) {
          // Backwards-compat: emit as whole message if no streamer attached
          this.onMessage({ role: "assistant", text: finalText });
        }
      } else if (method === "chat.error") {
        this.currentTurnId = null;
        this.streamListener?.({
          kind: "error",
          turnId,
          error: String(params.error ?? "Runtime error"),
        });
      }
      return;
    }

    // Legacy whole-message push (older runtime versions)
    const text =
      parsed?.result?.text ??
      parsed?.params?.text ??
      parsed?.params?.message?.text ??
      parsed?.text ??
      null;
    if (typeof text === "string" && text) {
      this.onMessage({ role: "assistant", text });
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Gateway not connected"));
    }
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.rejecters.set(id, reject);
      this.ws!.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.rejecters.delete(id);
          reject(new Error(`Timeout waiting for reply to ${method}`));
        }
      }, 120_000);
    });
  }

  async send(text: string, model: string = "auto"): Promise<void> {
    await this.rpc("chat.send", {
      sessionKey: "main",
      message: text,
      channel: "webchat",
      model: model === "auto" ? undefined : model,
      stream: true,
    });
  }

  /** Ask the runtime to stop generating the in-flight turn. Best-effort —
   *  the runtime may have already finished, in which case this is a no-op. */
  async abort(): Promise<void> {
    if (!this.currentTurnId) return;
    try {
      await this.rpc("chat.abort", { turnId: this.currentTurnId });
    } catch {
      // ignore — even on abort failure we want UI to settle
    }
    this.currentTurnId = null;
  }

  isStreaming(): boolean {
    return this.currentTurnId !== null;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
