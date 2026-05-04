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

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  batch?: boolean;
  batchCount?: number;
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
