/**
 * v0.1.52 — Provenance Panel.
 *
 * For every chat turn we gather a "show your work" trace: which vault
 * notes the agent looked at, which memory entries were relevant, which
 * past sessions surfaced as similar — each with a score and a one-line
 * "why this mattered." The trace is rendered as a collapsible panel
 * under the assistant message.
 *
 * This is the keystone v1.0 feature. Senior employees say "I'm
 * recommending X because (a), (b), (c)." Prism without provenance
 * gives an answer; Prism with provenance gives an *auditable* answer.
 *
 * Three retrieval paths:
 *  1. Vault embedding search — cosine(query, note title + first 600
 *     chars) over the user's Obsidian vault, top-K by score.
 *  2. Wikilink graph walk — for each top vault hit, follow `[[...]]`
 *     refs one hop. Walked notes are tagged "graph-walk" with the
 *     path back to the originating embed hit.
 *  3. Memory scan — read MEMORY.md, surface entries whose description
 *     line shares lexical bigrams with the query.
 *
 * Session recall stays where it lives (electron/session-summary.ts);
 * the renderer merges its hits into the provenance display layer.
 *
 * Latency budget: ≤ 2.5s. Embedding 1500 notes from scratch would blow
 * that, so we cache an embedding-per-note keyed by `${absPath}#${mtime}`
 * on disk. Cold cache fills lazily as the user chats. The first turn
 * after the vault changes pays for the new notes only.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app, ipcMain } from "electron";
import log from "electron-log";
import { embed, cosine, embedWithTimeout } from "./embed";
import { getVaultRoot } from "./vault-config";
const MAX_NOTES_SCANNED = 1500;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const VAULT_TOP_K = 4;
const GRAPH_NEIGHBORS_PER_HIT = 2;
const NOTE_PEEK_CHARS = 600;
const CACHE_VERSION = "v1";

type VaultIndexEntry = {
  absPath: string;
  relPath: string;
  title: string;
  mtimeMs: number;
  peek: string;
  outlinks: string[]; // wikilink targets ([[X]] -> X)
  embedding: number[]; // 384-dim
};

type ProvenanceVaultHit = {
  relPath: string;
  title: string;
  score: number;
  source: "embed" | "graph-walk";
  pathFromQuery: string[];
  snippet: string;
  why: string;
};

type ProvenanceMemoryHit = {
  file: string;
  title: string;
  type: "user" | "feedback" | "project" | "reference" | "unknown";
  why: string;
};

type ProvenanceCommitmentHit = {
  id: string;
  verb: string;
  text: string;
  capturedAt: number;
  resolved: boolean;
  outcome?: string;
  counterparty?: string;
  deadlineIso?: string;
  vaultRelPath?: string;
  score: number;
  why: string;
};

export type ProvenanceTrace = {
  turnId: string;
  queryText: string;
  generatedAtMs: number;
  durationMs: number;
  vaultHits: ProvenanceVaultHit[];
  memoryHits: ProvenanceMemoryHit[];
  // v0.1.58: past commitments + outcomes that match the query — closes
  // the senior-employee feedback loop. "you committed to this same
  // thing 2026-03-12 → outcome: shipped two days late."
  commitmentHits?: ProvenanceCommitmentHit[];
  notes: string[]; // free-form trace lines: "embedded 4 vault notes in 1.2s"
};

function cacheFile(): string {
  return path.join(app.getPath("userData"), "provenance-vault-cache.json");
}

let memoryIndex: VaultIndexEntry[] | null = null;
let memoryIndexLoadedAt = 0;
const INDEX_TTL_MS = 5 * 60 * 1000;

function loadDiskCache(): Map<string, VaultIndexEntry> {
  try {
    const raw = fs.readFileSync(cacheFile(), "utf8");
    const parsed = JSON.parse(raw) as { version: string; entries: VaultIndexEntry[] };
    if (parsed.version !== CACHE_VERSION) return new Map();
    return new Map(parsed.entries.map((e) => [e.absPath + "#" + e.mtimeMs, e]));
  } catch {
    return new Map();
  }
}

function writeDiskCache(byKey: Map<string, VaultIndexEntry>): void {
  try {
    const entries = [...byKey.values()];
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ version: CACHE_VERSION, entries }),
      "utf8",
    );
  } catch (e) {
    log.warn("[provenance] cache write failed", String(e).slice(0, 200));
  }
}

function walkVault(root: string): Array<{
  absPath: string;
  relPath: string;
  title: string;
  mtimeMs: number;
}> {
  const out: Array<{
    absPath: string;
    relPath: string;
    title: string;
    mtimeMs: number;
  }> = [];
  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH || out.length >= MAX_NOTES_SCANNED) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_NOTES_SCANNED) return;
      if (ent.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
      const abs = path.join(dir, ent.name);
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          walk(abs, depth + 1);
        } else if (stat.isFile() && ent.name.toLowerCase().endsWith(".md")) {
          out.push({
            absPath: abs,
            relPath: path.relative(root, abs),
            title: ent.name.replace(/\.md$/i, ""),
            mtimeMs: stat.mtimeMs,
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  walk(root, 0);
  return out;
}

function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]\|#]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].trim();
    if (target) out.add(target);
  }
  return [...out];
}

async function buildIndex(): Promise<VaultIndexEntry[]> {
  if (!fs.existsSync(getVaultRoot())) return [];
  const files = walkVault(getVaultRoot());
  const cache = loadDiskCache();
  const next = new Map<string, VaultIndexEntry>();
  let newEmbeds = 0;
  const NEW_EMBED_BUDGET = 40;
  for (const f of files) {
    const key = f.absPath + "#" + f.mtimeMs;
    const cached = cache.get(key);
    if (cached) {
      next.set(key, cached);
      continue;
    }
    if (newEmbeds >= NEW_EMBED_BUDGET) {
      // skip — will be picked up on next turn
      continue;
    }
    let body = "";
    try {
      body = fs.readFileSync(f.absPath, "utf8");
    } catch {
      continue;
    }
    const peek = body.slice(0, NOTE_PEEK_CHARS);
    const outlinks = extractWikilinks(body);
    const embedText = `${f.title}\n\n${peek}`;
    let vec: number[];
    try {
      vec = await embed(embedText);
    } catch {
      continue;
    }
    const entry: VaultIndexEntry = {
      absPath: f.absPath,
      relPath: f.relPath,
      title: f.title,
      mtimeMs: f.mtimeMs,
      peek,
      outlinks,
      embedding: vec,
    };
    next.set(key, entry);
    newEmbeds++;
  }
  writeDiskCache(next);
  return [...next.values()];
}

async function getIndex(): Promise<VaultIndexEntry[]> {
  const now = Date.now();
  if (memoryIndex && now - memoryIndexLoadedAt < INDEX_TTL_MS) return memoryIndex;
  memoryIndex = await buildIndex();
  memoryIndexLoadedAt = now;
  return memoryIndex;
}

function buildTitleIndex(entries: VaultIndexEntry[]): Map<string, VaultIndexEntry> {
  const m = new Map<string, VaultIndexEntry>();
  for (const e of entries) {
    m.set(e.title.toLowerCase(), e);
  }
  return m;
}

function snippetFor(entry: VaultIndexEntry, queryLower: string): string {
  const body = entry.peek;
  if (!queryLower) return body.slice(0, 220);
  const firstTerm = queryLower.split(/\s+/).find((t) => t.length >= 4);
  if (!firstTerm) return body.slice(0, 220);
  const i = body.toLowerCase().indexOf(firstTerm);
  if (i < 0) return body.slice(0, 220);
  const start = Math.max(0, i - 60);
  return body.slice(start, start + 220);
}

function lexicalScore(queryTokens: Set<string>, entry: VaultIndexEntry): number {
  if (queryTokens.size === 0) return 0;
  const text = (entry.title + " " + entry.peek).toLowerCase();
  let hits = 0;
  for (const t of queryTokens) if (text.includes(t)) hits++;
  return hits / queryTokens.size;
}

async function gatherVaultProvenance(
  queryText: string,
): Promise<ProvenanceVaultHit[]> {
  const index = await getIndex();
  if (index.length === 0) return [];
  // v0.1.56: bumped 1500 → 4000ms so cold-start MiniLM has time to load.
  // On miss, fall back to lexical token-overlap so the first turn after
  // app boot still surfaces vault hits.
  const qvec = await embedWithTimeout(queryText, 4000);
  const queryLower = queryText.toLowerCase();
  if (!qvec) {
    const queryTokens = new Set(
      queryLower
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4),
    );
    if (queryTokens.size === 0) return [];
    const lexScored = index.map((e) => ({ e, score: lexicalScore(queryTokens, e) }));
    lexScored.sort((a, b) => b.score - a.score);
    const lexTop = lexScored.slice(0, VAULT_TOP_K);
    const out: ProvenanceVaultHit[] = [];
    for (const { e, score } of lexTop) {
      if (score < 0.25) continue;
      out.push({
        relPath: e.relPath,
        title: e.title,
        score,
        source: "embed", // category-wise close enough; lexical lane
        pathFromQuery: ["query", e.title],
        snippet: snippetFor(e, queryLower),
        why: `Lexical token overlap ${(score * 100).toFixed(0)}% — embedding model was warming up on this turn; lexical fallback used.`,
      });
    }
    return out;
  }
  const scored = index.map((e) => ({ e, score: cosine(qvec, e.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, VAULT_TOP_K);
  const titleIndex = buildTitleIndex(index);
  const hits: ProvenanceVaultHit[] = [];
  const seen = new Set<string>();

  for (const { e, score } of top) {
    if (score < 0.18) continue;
    hits.push({
      relPath: e.relPath,
      title: e.title,
      score,
      source: "embed",
      pathFromQuery: ["query", e.title],
      snippet: snippetFor(e, queryLower),
      why: `Embedding similarity ${(score * 100).toFixed(1)}% — top-${
        hits.length + 1
      } match across ${index.length} vault notes.`,
    });
    seen.add(e.absPath);
  }

  // Graph walk: one hop out from each embed hit, follow [[wikilinks]].
  for (const { e } of top) {
    let neighborCount = 0;
    for (const target of e.outlinks) {
      if (neighborCount >= GRAPH_NEIGHBORS_PER_HIT) break;
      const neighbor = titleIndex.get(target.toLowerCase());
      if (!neighbor) continue;
      if (seen.has(neighbor.absPath)) continue;
      const neighborScore = cosine(qvec, neighbor.embedding);
      if (neighborScore < 0.12) continue;
      hits.push({
        relPath: neighbor.relPath,
        title: neighbor.title,
        score: neighborScore,
        source: "graph-walk",
        pathFromQuery: ["query", e.title, neighbor.title],
        snippet: snippetFor(neighbor, queryLower),
        why: `Reached via wikilink from "${e.title}". Independent similarity ${(neighborScore * 100).toFixed(1)}%.`,
      });
      seen.add(neighbor.absPath);
      neighborCount++;
    }
  }

  return hits;
}

function memoryDir(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    "-Users-richardchen-FlexHaul",
    "memory",
  );
}

function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4),
  );
}

// v0.1.65: more selective stopwords for memory matching. Common words
// in user messages ("approved", "execute", "plan", "above", "before",
// "first", "second") were getting through the length≥4 filter and
// surfacing noise hits on any memory entry containing them.
const MEMORY_QUERY_STOPWORDS = new Set([
  "approved", "execute", "plan", "above", "below", "before", "after",
  "first", "second", "third", "fourth", "fifth", "next", "last",
  "anything", "something", "everyone", "anyone", "someone", "nothing",
  "would", "could", "should", "going", "doing", "trying", "looking",
  "thanks", "please", "really", "actually", "maybe", "probably",
  "still", "again", "once", "twice", "also", "even", "just",
  "operations", "proceeding", "ambiguous", "proposed",
  "files", "thing", "things", "stuff", "matter",
  "this", "that", "these", "those", "what", "when", "where", "which",
  "with", "from", "into", "about", "between", "through", "during",
  "make", "made", "take", "took", "give", "gave", "want", "need",
]);

function gatherMemoryProvenance(queryText: string): ProvenanceMemoryHit[] {
  const indexPath = path.join(memoryDir(), "MEMORY.md");
  if (!fs.existsSync(indexPath)) return [];
  let body = "";
  try {
    body = fs.readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  // v0.1.65: filter out stopwords AND short tokens after tokenization
  const queryTokens = new Set(
    [...tokensOf(queryText)].filter((t) => !MEMORY_QUERY_STOPWORDS.has(t)),
  );
  if (queryTokens.size === 0) return [];
  // v0.1.65: scale required overlap with query size — very short queries
  // (1-4 content tokens) can pass with 1 match, normal queries require 2,
  // long detailed queries require 3.
  const minOverlap =
    queryTokens.size <= 3 ? 1 : queryTokens.size <= 10 ? 2 : 3;
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)\s+—?\s*(.*)/g;
  const hits: Array<{
    file: string;
    title: string;
    line: string;
    score: number;
    matchedTokens: string[];
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) !== null) {
    const [, title, file, hint] = m;
    const lineText = `${title} ${hint}`;
    const lineTokens = tokensOf(lineText);
    let overlap = 0;
    const matchedTokens: string[] = [];
    for (const t of queryTokens) {
      if (lineTokens.has(t)) {
        overlap++;
        matchedTokens.push(t);
      }
    }
    if (overlap < minOverlap) continue;
    hits.push({ file, title, line: lineText, score: overlap, matchedTokens });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 4).map((h) => {
    let type: ProvenanceMemoryHit["type"] = "unknown";
    if (h.file.startsWith("feedback_")) type = "feedback";
    else if (h.file.startsWith("project_")) type = "project";
    else if (h.file.startsWith("reference_")) type = "reference";
    else if (h.file.startsWith("user_")) type = "user";
    return {
      file: h.file,
      title: h.title,
      type,
      // v0.1.65: actually quote the matched tokens, not the entry content.
      why: `Matched ${h.score} query keyword${h.score === 1 ? "" : "s"}: ${h.matchedTokens.slice(0, 5).map((t) => `"${t}"`).join(", ")}.`,
    };
  });
}

// v0.1.58: scan Commitments/ folder. Prioritize resolved ones (those
// carry outcomes — the actual learning signal). Score by lexical
// overlap of query against verb + counterparty + outcome.
function gatherCommitmentProvenance(queryText: string): ProvenanceCommitmentHit[] {
  const commitmentsDir = path.join(getVaultRoot(), "Commitments");
  if (!fs.existsSync(commitmentsDir)) return [];
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(commitmentsDir)
      .filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const queryTokens = new Set(
    queryText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4),
  );
  if (queryTokens.size === 0) return [];
  const hits: ProvenanceCommitmentHit[] = [];
  for (const f of files) {
    const abs = path.join(commitmentsDir, f);
    let body = "";
    try {
      body = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fm: Record<string, string> = {};
    const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const k = line.slice(0, colon).trim();
        let v = line.slice(colon + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        fm[k] = v;
      }
    }
    if (!fm.id || !fm.verb) continue;
    const blockquote = body.match(/^>\s*(.+)$/m);
    const outcomeMatch = body.match(/##\s+Outcome\n+([\s\S]*?)(?:\n##|$)/);
    const haystack = (
      fm.verb +
      " " +
      (fm.counterparty ?? "") +
      " " +
      (blockquote?.[1] ?? "") +
      " " +
      (outcomeMatch?.[1] ?? "")
    ).toLowerCase();
    let overlap = 0;
    for (const t of queryTokens) if (haystack.includes(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / queryTokens.size;
    const isResolved = fm.resolved === "true";
    // resolved gets a 1.25× score multiplier — outcomes are gold for
    // the feedback loop.
    const adjusted = isResolved ? score * 1.25 : score;
    hits.push({
      id: fm.id,
      verb: fm.verb,
      text: blockquote?.[1].trim() ?? "",
      capturedAt: fm.captured_at ? new Date(fm.captured_at).getTime() : 0,
      resolved: isResolved,
      outcome: outcomeMatch?.[1].trim() || undefined,
      counterparty: fm.counterparty || undefined,
      deadlineIso: fm.deadline || undefined,
      vaultRelPath: path.relative(getVaultRoot(), abs),
      score: adjusted,
      why: isResolved
        ? `Past resolved commitment (outcome on file). Overlap ${overlap}/${queryTokens.size} keywords.`
        : `Open commitment from ${fm.captured_at?.slice(0, 10) ?? "earlier"}. Overlap ${overlap}/${queryTokens.size} keywords.`,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 4);
}

export async function gatherProvenance(params: {
  turnId: string;
  queryText: string;
}): Promise<ProvenanceTrace> {
  const t0 = Date.now();
  const notes: string[] = [];
  let vaultHits: ProvenanceVaultHit[] = [];
  let memoryHits: ProvenanceMemoryHit[] = [];
  try {
    vaultHits = await gatherVaultProvenance(params.queryText);
    notes.push(
      `Vault: scanned index (${(memoryIndex ?? []).length} notes), surfaced ${vaultHits.length} hits.`,
    );
  } catch (e) {
    notes.push(`Vault provenance failed: ${String(e).slice(0, 200)}`);
  }
  try {
    memoryHits = gatherMemoryProvenance(params.queryText);
    notes.push(`Memory: ${memoryHits.length} entries matched.`);
  } catch (e) {
    notes.push(`Memory provenance failed: ${String(e).slice(0, 200)}`);
  }
  let commitmentHits: ProvenanceCommitmentHit[] = [];
  try {
    commitmentHits = gatherCommitmentProvenance(params.queryText);
    notes.push(
      `Commitments: ${commitmentHits.length} matched (${commitmentHits.filter((h) => h.resolved).length} resolved).`,
    );
  } catch (e) {
    notes.push(`Commitment provenance failed: ${String(e).slice(0, 200)}`);
  }
  return {
    turnId: params.turnId,
    queryText: params.queryText,
    generatedAtMs: Date.now(),
    durationMs: Date.now() - t0,
    vaultHits,
    memoryHits,
    commitmentHits,
    notes,
  };
}

export function registerProvenance() {
  ipcMain.handle(
    "prism:provenance:gather",
    async (
      _e,
      params: { turnId: string; queryText: string },
    ): Promise<ProvenanceTrace> => {
      try {
        return await gatherProvenance(params);
      } catch (e: any) {
        log.warn("[provenance] gather failed", String(e).slice(0, 300));
        return {
          turnId: params.turnId,
          queryText: params.queryText,
          generatedAtMs: Date.now(),
          durationMs: 0,
          vaultHits: [],
          memoryHits: [],
          notes: [`Gather failed: ${String(e).slice(0, 200)}`],
        };
      }
    },
  );
}
