/**
 * Account persistence for Prism (v0.1.24).
 *
 * Stores the result of OAuth sign-in at <userData>/account.json. No
 * access tokens, no refresh tokens — just the public identity that the
 * provider returned. If we ever need to call the provider again, the
 * user signs in again.
 *
 * Privacy contract:
 *   - Local-only. Never read or written from anywhere except this
 *     module + IPC handlers in main.ts.
 *   - Inspect / delete with `cat ~/Library/Application\\ Support/Prism/account.json`
 *     or via Settings → Account → Sign out.
 *   - Wiping with `clear()` deletes the file entirely.
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import log from "electron-log";

export type Account = {
  version: 1;
  provider: "google";
  email: string;
  name: string;
  picture?: string;
  signedInAt: string;
};

function accountPath(): string {
  return path.join(app.getPath("userData"), "account.json");
}

export function loadAccount(): Account | null {
  const p = accountPath();
  try {
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data?.version !== 1) return null;
    if (typeof data?.email !== "string") return null;
    return {
      version: 1,
      provider: data.provider ?? "google",
      email: data.email,
      name: data.name ?? data.email,
      picture: data.picture,
      signedInAt: data.signedInAt ?? new Date().toISOString(),
    };
  } catch (e) {
    log.warn("[account] load failed", e);
    return null;
  }
}

export function saveAccount(a: Account): void {
  try {
    fs.writeFileSync(accountPath(), JSON.stringify(a, null, 2), "utf-8");
  } catch (e) {
    log.warn("[account] save failed", e);
  }
}

export function clear(): void {
  const p = accountPath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    log.warn("[account] clear failed", e);
  }
}
