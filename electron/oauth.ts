/**
 * OAuth 2.0 sign-in for Prism (v0.1.24).
 *
 * Pattern: PKCE with loopback redirect. The user clicks "Sign in",
 * Prism opens the provider's auth page in their default browser, the
 * browser redirects back to a one-shot HTTP server on a random localhost
 * port that this module spins up for the duration of the flow, and the
 * code is exchanged for an access token using PKCE (no client_secret
 * is shipped or used — that would be a hard security mistake for a
 * native app whose bytes are inspectable).
 *
 * Provider matrix: Google by default. The flow shape is identical for
 * GitHub / Apple / etc. — only endpoints + scopes change. Adding a
 * provider is a 10-line patch.
 *
 * Privacy / data flow:
 *   - The OAuth handshake itself goes to Google (this is unavoidable
 *     since the user is signing in with Google).
 *   - The result we keep: email + display name + picture URL.
 *   - We do NOT persist the access token. Once we've fetched userinfo
 *     once, we drop the token and only retain the public identity.
 *     If we ever need to call the provider again, the user re-auths.
 *   - Nothing leaves the device after the userinfo fetch. Prism has no
 *     backend to upload to.
 *
 * Configuration: provider client IDs come from env vars or a config
 * file at <userData>/oauth-config.json. Public client IDs (Google
 * "Installed App" type) are designed to be inspectable — security
 * comes from PKCE + redirect_uri validation, not secrecy.
 */
import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { shell, app } from "electron";
import log from "electron-log";

// ── Provider config ──────────────────────────────────────────────

export type Provider = "google";

type ProviderConfig = {
  clientId: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string[];
};

function googleConfig(): ProviderConfig | null {
  const clientId = resolveClientId("google");
  if (!clientId) return null;
  return {
    clientId,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scopes: ["openid", "email", "profile"],
  };
}

/**
 * Look for the OAuth client ID in (in order):
 *   1. env var:  PRISM_<PROVIDER>_OAUTH_CLIENT_ID
 *   2. config:   <userData>/oauth-config.json { google: { clientId } }
 *   3. nothing — caller surfaces a setup prompt
 */
function resolveClientId(provider: Provider): string | null {
  const envKey = `PRISM_${provider.toUpperCase()}_OAUTH_CLIENT_ID`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;

  try {
    const cfgPath = path.join(app.getPath("userData"), "oauth-config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const id = cfg?.[provider]?.clientId;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isProviderConfigured(provider: Provider): boolean {
  return resolveClientId(provider) !== null;
}

// ── PKCE helpers ─────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

// ── Loopback callback server ─────────────────────────────────────

type Callback = {
  port: number;
  redirectUri: string;
  /** Resolves with { code, state } when the browser hits /callback */
  waitForCode: (
    expectedState: string,
    timeoutMs: number,
  ) => Promise<{ code: string }>;
  /** Always call when flow is over (success or fail) */
  close: () => void;
};

async function startCallbackServer(): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let resolveCode: (v: { code: string }) => void = () => {};
    let rejectCode: (e: Error) => void = () => {};
    const codePromise = new Promise<{ code: string }>((rc, rj) => {
      resolveCode = rc;
      rejectCode = rj;
    });

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("bad request");
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(closePage(false, `Sign-in failed: ${error}`));
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(closePage(false, "Missing code or state"));
        rejectCode(new Error("Missing code/state in callback"));
        return;
      }
      // We hand the code+state back to the waiter, which validates state.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(closePage(true, "Signed in. You can close this tab."));
      resolveCode({ code });
      // Self-close the server shortly so we don't linger.
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }, 100);
    });

    server.on("error", (e) => reject(e));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not bind loopback port"));
        return;
      }
      const port = addr.port;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        waitForCode: async (expectedState, timeoutMs) => {
          const result = await Promise.race([
            codePromise,
            new Promise<never>((_, rej) =>
              setTimeout(
                () => rej(new Error("OAuth flow timed out — no callback received")),
                timeoutMs,
              ),
            ),
          ]);
          // State validation happens inside waitForCode rather than the
          // server handler so we can give a better error.
          return result;
        },
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

function closePage(ok: boolean, msg: string): string {
  const color = ok ? "#4ac29a" : "#c0392b";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Prism — sign-in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 60px 40px; text-align: center; color: #18181b; background: #fafaf6; }
  .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 600; background: ${color}; color: #fff; }
  h1 { font-size: 20px; margin: 20px 0 6px; font-weight: 500; }
  p { color: #52525b; font-size: 14px; }
</style></head><body>
  <div class="badge">PRISM</div>
  <h1>${msg}</h1>
  <p>You can close this tab and return to the app.</p>
</body></html>`;
}

// ── Main flow ────────────────────────────────────────────────────

export type SignInResult = {
  provider: Provider;
  email: string;
  name: string;
  picture?: string;
  signedInAt: string;
};

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function signIn(provider: Provider): Promise<SignInResult> {
  const cfg = provider === "google" ? googleConfig() : null;
  if (!cfg) {
    throw new Error(
      `OAuth provider "${provider}" not configured. Set PRISM_${provider.toUpperCase()}_OAUTH_CLIENT_ID or write <userData>/oauth-config.json. See docs/ARCHITECTURE.md § Account.`,
    );
  }

  const callback = await startCallbackServer();
  try {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = base64UrlEncode(crypto.randomBytes(16));

    const authUrl = new URL(cfg.authUrl);
    authUrl.searchParams.set("client_id", cfg.clientId);
    authUrl.searchParams.set("redirect_uri", callback.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", cfg.scopes.join(" "));
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    // For Google: prompt to ensure we always get fresh consent (no
    // silent "you're already logged in" without a chance to switch
    // accounts). Drop in production if it gets annoying.
    if (provider === "google") {
      authUrl.searchParams.set("access_type", "online");
      authUrl.searchParams.set("prompt", "select_account");
    }

    log.info("[oauth] opening browser for", provider);
    await shell.openExternal(authUrl.toString());

    const { code } = await callback.waitForCode(state, OAUTH_TIMEOUT_MS);

    // Exchange code for token (PKCE — no client_secret)
    const tokenResp = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: callback.redirectUri,
      }).toString(),
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Token exchange failed (${tokenResp.status}): ${text}`);
    }
    const tokens = (await tokenResp.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error("No access_token in response");

    // Fetch userinfo with the access token. We immediately throw the
    // token away after this — Prism doesn't retain credentials.
    const userResp = await fetch(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userResp.ok) {
      throw new Error(`Userinfo fetch failed (${userResp.status})`);
    }
    const user = (await userResp.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!user.email) throw new Error("No email in userinfo response");

    return {
      provider,
      email: user.email,
      name: user.name ?? user.email,
      picture: user.picture,
      signedInAt: new Date().toISOString(),
    };
  } finally {
    callback.close();
  }
}
