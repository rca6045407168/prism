/**
 * Thin client for the OpenClaw gateway WebSocket.
 *
 * v0.1: just enough to send a chat message and receive the assistant reply.
 * Authenticates via the operator token discovered from ~/.openclaw/devices/paired.json.
 *
 * Protocol notes (reverse-engineered from gateway.log + dashboard traffic):
 *   - Connect to ws://127.0.0.1:18789
 *   - First message must include the auth token (sent in the URL or first frame)
 *   - JSON-RPC-ish: { id, method, params } request → { id, result } reply
 *   - Chat send method is `chat.send` (per src/gateway/method-scopes.ts:152)
 *
 * v0.2 will:
 *   - Stream incremental tokens
 *   - Subscribe to sessions for multi-turn state
 *   - Properly handle reconnect
 */

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  batch?: boolean;
  batchCount?: number;
};

type Listener = (msg: ChatMessage) => void;

let nextId = 1;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, (result: any) => void>();
  private rejecters = new Map<number, (err: Error) => void>();

  constructor(
    private url: string,
    private token: string,
    private onMessage: Listener,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      u.searchParams.set("token", this.token);
      this.ws = new WebSocket(u.toString());

      // Hard timeout: if the daemon doesn't ack in 6s, give up so the UI
      // can show an error rather than spin forever. (v0.1.3)
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
        // Surface unexpected closes to the UI as a system message
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

    // Reply to a request we sent
    if (parsed.id && this.pending.has(parsed.id)) {
      const cb = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      this.rejecters.delete(parsed.id);
      cb(parsed.result ?? parsed.error ?? null);
      return;
    }

    // Push notification: assistant message arrived
    // Shape varies by gateway version; try common fields.
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
      // Generous timeout — agent turns can take 30s+
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.rejecters.delete(id);
          reject(new Error(`Timeout waiting for reply to ${method}`));
        }
      }, 120_000);
    });
  }

  /**
   * Send a chat message and wait for the assistant's reply.
   * The reply arrives async via onMessage; this just confirms the dispatch.
   *
   * `model` is the user's chosen model alias from Settings. "auto" lets
   * the auto-model-select skill route per prompt; any other value pins.
   */
  async send(text: string, model: string = "auto"): Promise<void> {
    await this.rpc("chat.send", {
      sessionKey: "main",
      message: text,
      channel: "webchat",
      model: model === "auto" ? undefined : model,
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
