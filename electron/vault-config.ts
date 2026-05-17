/**
 * v0.1.61 — Vault path config.
 *
 * Previously every vault-touching module hardcoded
 *   ~/Documents/Obsidian Vault
 * which worked for Richard but breaks anyone whose vault lives in
 * iCloud Drive, ~/Obsidian, or a project-scoped subdir. This module
 * is the single source of truth — set once via Settings, every other
 * main-process module reads through getVaultRoot().
 *
 * Stored at <userData>/vault-config.json. Reads + writes are synchronous
 * because the path is needed at module-load time in some callers (no
 * async migration of existing hardcodes worth the cost).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app } from "electron";

type VaultConfig = {
  vaultRoot: string;
  updatedAt: string;
};

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "Obsidian Vault");

function configPath(): string {
  try {
    return path.join(app.getPath("userData"), "vault-config.json");
  } catch {
    // app.getPath fails before app.ready — fall back to a homedir cache
    return path.join(os.homedir(), ".prism-vault-config.json");
  }
}

let cached: string | null = null;

export function getVaultRoot(): string {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as VaultConfig;
    if (parsed.vaultRoot && fs.existsSync(parsed.vaultRoot)) {
      cached = parsed.vaultRoot;
      return cached;
    }
  } catch {
    /* fall through */
  }
  cached = DEFAULT_VAULT;
  return cached;
}

export function setVaultRoot(p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!p || typeof p !== "string") {
    return { ok: false, error: "Empty path" };
  }
  const resolved = path.resolve(p.replace(/^~/, os.homedir()));
  try {
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Folder does not exist: ${resolved}` };
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Not a directory: ${resolved}` };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  try {
    const cfg: VaultConfig = {
      vaultRoot: resolved,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
    cached = resolved;
    return { ok: true, path: resolved };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** v0.1.61: best-effort lightweight check — does this look like a
 *  vault? We allow any folder, but flag if it's missing the `.obsidian`
 *  metadata folder so the user can confirm. */
export function vaultLooksValid(p: string): {
  exists: boolean;
  hasObsidianFolder: boolean;
  noteCount: number;
} {
  let exists = false;
  try {
    exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return { exists: false, hasObsidianFolder: false, noteCount: 0 };
  }
  if (!exists) return { exists: false, hasObsidianFolder: false, noteCount: 0 };
  const hasObsidianFolder = fs.existsSync(path.join(p, ".obsidian"));
  let noteCount = 0;
  try {
    const entries = fs.readdirSync(p);
    noteCount = entries.filter((e) => e.toLowerCase().endsWith(".md")).length;
  } catch {
    /* permission denied — leave 0 */
  }
  return { exists, hasObsidianFolder, noteCount };
}
