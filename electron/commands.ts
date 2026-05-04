/**
 * Slash command + skill discovery.
 *
 * Scans the user's Claude config dirs for invokable commands. Two
 * sources:
 *  - ~/.claude/commands/<name>.md       — slash commands
 *  - ~/.claude/skills/<name>/SKILL.md   — skills (also addressable via `/<name>`)
 *
 * Commands carry frontmatter:
 *   ---
 *   name: foo
 *   description: ...
 *   ---
 *
 * Some skills omit frontmatter — we fall back to dir name + first
 * heading. Returns a flat list sorted by name. The command name (whether
 * from frontmatter or dir) is what the user types after the leading `/`.
 *
 * No write side. The user manages these in their own filesystem.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import log from "electron-log";

export type CommandKind = "command" | "skill";

export type DiscoveredCommand = {
  name: string;
  description: string;
  source: CommandKind;
  filePath: string;
};

/**
 * Lazy-stripped YAML frontmatter parser. Only handles the keys we need
 * (`name`, `description`) and tolerates quotes / multi-line description
 * folded with leading whitespace.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const body = m[1];
  const out: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    // Continuation of a folded value (leading whitespace)
    if (lastKey && /^\s+/.test(line)) {
      out[lastKey] = (out[lastKey] + " " + line.trim()).trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    lastKey = key;
  }
  return out;
}

function firstHeading(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.match(/^#+\s+(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}

function safeReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function discoverCommandsDir(dir: string, out: DiscoveredCommand[]): void {
  if (!fs.existsSync(dir)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    const text = safeReadFile(filePath);
    if (!text) continue;
    const fm = parseFrontmatter(text);
    const name = (fm.name ?? entry.replace(/\.md$/, "")).trim();
    if (!/^[a-z0-9_-]+$/i.test(name)) continue;
    const description = (fm.description ?? firstHeading(text) ?? "").trim();
    out.push({
      name,
      description: trimDescription(description),
      source: "command",
      filePath,
    });
  }
}

function discoverSkillsDir(dir: string, out: DiscoveredCommand[]): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    // Some skills are symlinks (e.g. ~/.claude/skills/foo →
    // ~/openclaw-workspace/skills/foo). isDirectory() returns false on
    // a symlink, so additionally accept any entry whose target resolves
    // to a directory.
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, dirent.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    const subdir = path.join(dir, dirent.name);
    const skillPath = path.join(subdir, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const text = safeReadFile(skillPath);
    if (!text) continue;
    const fm = parseFrontmatter(text);
    const name = (fm.name ?? dirent.name).trim();
    if (!/^[a-z0-9_-]+$/i.test(name)) continue;
    const description = (fm.description ?? firstHeading(text) ?? "").trim();
    out.push({
      name,
      description: trimDescription(description),
      source: "skill",
      filePath: skillPath,
    });
  }
}

function trimDescription(d: string): string {
  if (!d) return "";
  // Most descriptions are first-sentence-ish; cap at 200 chars for
  // dropdown legibility.
  const collapsed = d.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 200) return collapsed;
  return collapsed.slice(0, 197).trimEnd() + "…";
}

let cachedAt = 0;
let cached: DiscoveredCommand[] = [];
const CACHE_TTL_MS = 30_000;

export function listCommands(): DiscoveredCommand[] {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS && cached.length > 0) return cached;

  const out: DiscoveredCommand[] = [];
  const home = os.homedir();
  try {
    discoverCommandsDir(path.join(home, ".claude", "commands"), out);
    discoverSkillsDir(path.join(home, ".claude", "skills"), out);
  } catch (e) {
    log.warn("[commands] discovery failed", e);
  }

  // De-dupe by name (skill + command with same name → keep skill, since
  // skills are typically richer)
  const byName = new Map<string, DiscoveredCommand>();
  for (const c of out) {
    const existing = byName.get(c.name);
    if (!existing || (existing.source === "command" && c.source === "skill")) {
      byName.set(c.name, c);
    }
  }
  const list = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  cached = list;
  cachedAt = now;
  return list;
}

export function refreshCommandsCache(): void {
  cachedAt = 0;
  cached = [];
}
