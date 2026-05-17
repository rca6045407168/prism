/**
 * Message renderer with markdown + syntax-highlighted code blocks + copy button.
 *
 * - User messages: rendered as plain text (no markdown — preserves exact input)
 * - Assistant messages: full GFM markdown, code blocks via Shiki (VSCode-grade
 *   highlighting; same TextMate grammars as VSCode itself, theme-aware via the
 *   data-theme attribute on <html>).
 * - System messages: plain text, italicized
 *
 * Each assistant message has a "Copy" button that copies the raw markdown.
 * Each code block has its own "Copy" button.
 *
 * 2026-05-08: swapped prism-react-renderer → shiki. Reasons:
 *   - VSCode-grade grammars (Microsoft uses Shiki on vscode.dev)
 *   - Much wider language coverage (~200 vs ~80)
 *   - Themes match VSCode 1:1 (vitesse-dark, vitesse-light, github-dark, etc.)
 * Cost: highlighter loads async (one-time ~50ms). Code blocks render with a
 * plain <pre> fallback while loading, then upgrade in place.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pencil, GitBranch, Copy as CopyIcon, Check, ThumbsUp, ThumbsDown } from "lucide-react";
import { ChatMessage, ToolEvent, BatchAgent } from "./gateway";
import { Artifact } from "./artifacts";
import { copyToClipboard } from "./clipboard";

/**
 * v0.1.60: hide "Approve & execute" on dead-end turns.
 *
 * Previously the button rendered on every Ask-mode assistant turn.
 * Problem: when claude answers "you need to do this in the Stripe
 * dashboard yourself", there's literally nothing to approve —
 * clicking just spawns another turn that says the same thing in
 * Bypass mode. Wasted click + cost.
 *
 * Rules:
 *   - If the message contains a fenced shell block (```bash/sh/zsh/
 *     shell/console/python/node) → there's something runnable → show.
 *   - Else if the message contains a "dead-end" marker like "you need
 *     to", "in the dashboard", "manually", "please go to" → no
 *     executable action by claude → hide.
 *   - Default: show (existing behavior preserved when ambiguous).
 */
function turnHasExecutablePlan(messageText: string): boolean {
  const lower = messageText.toLowerCase();
  // Strong "go runnable" signal: fenced executable code block.
  const hasFencedExec = /```(?:bash|sh|zsh|shell|console|python|py|node|js|ts|tsx)\b/i.test(
    messageText,
  );
  if (hasFencedExec) return true;
  // Strong dead-end signal — claude told the user to act themselves.
  const deadEndMarkers = [
    "you need to",
    "you'll need to",
    "you have to",
    "please do this",
    "please go to",
    "manually",
    "in the dashboard",
    "in the web portal",
    "in your browser",
    "in the stripe dashboard",
    "in the gcp console",
    "open the dashboard",
    "i can't",
    "i cannot",
    "requires web portal access",
    "requires manual",
  ];
  for (const marker of deadEndMarkers) {
    if (lower.includes(marker)) return false;
  }
  return true;
}

/**
 * v0.1.33: scan a message body for `@<absolute-path>` references that
 * point at an image file (png/jpg/jpeg/gif/webp/svg/heic). Returns the
 * deduped list of absolute paths so the renderer can paint inline
 * thumbnails below the bubble.
 */
const IMAGE_REF_RE = /@(\/[\w\-./ %]+\.(?:png|jpe?g|gif|webp|svg|heic|bmp))\b/gi;
function extractImageRefs(text: string): string[] {
  if (!text) return [];
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = IMAGE_REF_RE.exec(text)) !== null) {
    set.add(m[1]);
  }
  return Array.from(set);
}

/**
 * v0.1.40: transform Obsidian-style `[[wikilinks]]` into markdown links
 * with the synthetic `prism-vault://` scheme. The ReactMarkdown `a`
 * component override (below) detects that scheme and routes the click
 * through the vault IPC → `obsidian://open?...`.
 *
 * Supported forms:
 *   [[Note Title]]            → [Note Title](prism-vault://Note Title)
 *   [[Note Title|Custom]]     → [Custom](prism-vault://Note Title)
 *
 * Skipped inside:
 *   - fenced code blocks (```...```)
 *   - inline code (`...`)
 *
 * Why pre-transform vs. a custom remark plugin: simpler, no extra
 * dependency, and the result roundtrips cleanly through GFM. The cost
 * is one regex scan per render — negligible vs. the syntax-highlight
 * pass that already happens for code blocks.
 */
const WIKILINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

export function expandWikilinks(text: string): string {
  if (!text || text.indexOf("[[") === -1) return text;
  // Split out fenced + inline code so we don't transform inside them.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((chunk) => {
      if (chunk.startsWith("```") || (chunk.startsWith("`") && chunk.endsWith("`"))) {
        return chunk;
      }
      return chunk.replace(WIKILINK_RE, (_m, target: string, alias?: string) => {
        const t = target.trim();
        const a = (alias ?? t).trim();
        // Encode the target so spaces and unicode roundtrip. Use a synthetic
        // scheme so the `a` component override knows to route via IPC.
        return `[${a}](prism-vault://${encodeURIComponent(t)})`;
      });
    })
    .join("");
}

/** Build a prism-img:// URL for an absolute file path, encoding
 *  each path segment so spaces / unicode survive. */
function toImgUrl(absPath: string): string {
  const segments = absPath.split("/").map((s) => encodeURIComponent(s));
  // Result starts with "//" — we want "prism-img:///Users/..." which is
  // equivalent. The first empty segment from the leading "/" handles it.
  return `prism-img://${segments.join("/")}`;
}

/**
 * v0.1.34: friendly token formatter — 1234 → "1.2k", 7 → "7", 123 → "123".
 */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/**
 * v0.1.34: friendly cost formatter. Caps decimals smartly:
 *   $0.0008 → "$0.0008"
 *   $0.123  → "$0.12"
 *   $1.234  → "$1.23"
 */
function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.001) return `$${n.toFixed(5)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * v0.1.34: model name → short label. Claude returns things like
 * "claude-haiku-4-5", "claude-sonnet-4-6". We collapse to "Haiku" /
 * "Sonnet" / "Opus" for the pill; full model is in the title attr.
 */
export function shortModelName(model: string): string {
  if (!model) return "auto";
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("opus")) return "Opus";
  return model;
}

/**
 * v0.1.45: interactive Preview-mode snapshot card. Lists files modified
 * since the snapshot, per-file revert (rm). Loads lazily on first expand
 * so opening a long thread of past turns doesn't fan out 50 `find` calls.
 */
function PreviewSnapshotCard({
  snapshot,
  scope,
}: {
  snapshot: NonNullable<NonNullable<ChatMessage["usage"]>["previewSnapshot"]>;
  /** v0.1.48: user-configured scope dir for the diff query. Empty/undefined
   *  → $HOME default. */
  scope?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<
    Array<{ path: string; mtime: number; size: number; likelyNew: boolean }> | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [reverted, setReverted] = useState<Set<string>>(new Set());

  const load = async () => {
    if (loading || files) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.flexhaul.preview.listChanged(
        snapshot.id,
        scope || undefined,
      );
      if ("error" in res) {
        setError(res.error);
      } else {
        setFiles(res.files);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    setLoading(false);
  };

  const onExpand = () => {
    setExpanded(true);
    void load();
  };

  const onRevert = async (p: string) => {
    const res = await window.flexhaul.preview.revertFile(p);
    if (res.ok) {
      setReverted((prev) => {
        const next = new Set(prev);
        next.add(p);
        return next;
      });
    } else {
      setError(`Revert failed for ${p}: ${res.error ?? "unknown"}`);
    }
  };

  const home = "/Users/richardchen"; // best-effort display shortening; safe to hardcode for now
  const visibleFiles = files ?? [];

  return (
    <div className="msg-preview-row">
      <div className="msg-preview-head">
        <span className="msg-preview-icon">🧪</span>
        <span className="msg-preview-title">Preview snapshot captured</span>
        <code className="msg-preview-id">{snapshot.id}</code>
      </div>
      <div className="msg-preview-body">
        Any changes claude made during this turn are reversible while the
        snapshot is still on disk (purgeable by macOS under disk pressure —
        review within ~30 min).
        {!expanded ? (
          <button
            className="msg-preview-expand"
            onClick={onExpand}
          >
            Show changed files →
          </button>
        ) : null}
        {expanded && loading ? (
          <div className="msg-preview-loading">Scanning $HOME for changes…</div>
        ) : null}
        {expanded && error ? (
          <div className="msg-preview-error">⚠ {error}</div>
        ) : null}
        {expanded && files && files.length === 0 ? (
          <div className="msg-preview-empty">
            No files modified since this snapshot. Turn was read-only or
            claude didn't touch the disk.
          </div>
        ) : null}
        {expanded && files && files.length > 0 ? (
          <ul className="msg-preview-files">
            {visibleFiles.map((f) => {
              const isReverted = reverted.has(f.path);
              const display = f.path.startsWith(home + "/")
                ? "~" + f.path.slice(home.length)
                : f.path;
              return (
                <li
                  key={f.path}
                  className={`msg-preview-file${isReverted ? " reverted" : ""}`}
                >
                  <code className="msg-preview-file-path">{display}</code>
                  <span className="msg-preview-file-size">
                    {f.size < 1024
                      ? `${f.size}B`
                      : f.size < 1024 * 1024
                        ? `${(f.size / 1024).toFixed(1)}KB`
                        : `${(f.size / 1024 / 1024).toFixed(1)}MB`}
                  </span>
                  {isReverted ? (
                    <span className="msg-preview-reverted-tag">reverted ✓</span>
                  ) : (
                    <button
                      className="msg-preview-revert-btn"
                      onClick={() => onRevert(f.path)}
                      title="Delete this file (revert claude's change)"
                    >
                      Revert
                    </button>
                  )}
                </li>
              );
            })}
            {files.length >= 200 ? (
              <li className="msg-preview-truncated">
                + more (capped at 200 results). Use Finder to inspect deeper.
              </li>
            ) : null}
          </ul>
        ) : null}
        <details className="msg-preview-cmd-details">
          <summary>Or roll back manually via Terminal</summary>
          <pre className="msg-preview-cmd">
            <code>
              # List local snapshots:{"\n"}
              tmutil listlocalsnapshots /{"\n"}
              {"\n"}
              # Mount this snapshot read-only:{"\n"}
              sudo mount_apfs -s {snapshot.id} -o nobrowse,ro
              /System/Volumes/Data /private/tmp/snap-{snapshot.id}
            </code>
          </pre>
        </details>
      </div>
    </div>
  );
}

function UsagePill({
  usage,
}: {
  usage: NonNullable<ChatMessage["usage"]>;
}) {
  const { model, inputTokens, outputTokens, cost, durationMs } = usage;
  const seconds = durationMs > 0 ? (durationMs / 1000).toFixed(1) + "s" : "";
  return (
    <div
      className="msg-usage-pill"
      title={`Model: ${model} · ${inputTokens.toLocaleString()} input tokens · ${outputTokens.toLocaleString()} output tokens · ${fmtCost(cost)} · ${seconds}`}
    >
      <span className="msg-usage-model">{shortModelName(model)}</span>
      <span className="msg-usage-sep">·</span>
      <span>{fmtTokens(inputTokens)} in</span>
      <span className="msg-usage-sep">·</span>
      <span>{fmtTokens(outputTokens)} out</span>
      {cost > 0 ? (
        <>
          <span className="msg-usage-sep">·</span>
          <span>{fmtCost(cost)}</span>
        </>
      ) : null}
      {seconds ? (
        <>
          <span className="msg-usage-sep">·</span>
          <span>{seconds}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * v0.1.52: ProvenancePanel — "show your work" surface.
 *
 * Renders under each assistant message that has a `provenance` trace.
 * Collapsible — the chip stays visible (1 line, score-summarized), the
 * full panel expands on click. This is the Google-challenge keystone:
 * a senior employee shows their citation trail; Prism does too.
 *
 * Three retrieval lanes shown:
 *  1. Vault hits — direct embed matches AND wikilink-graph walks. The
 *     graph-walk hits carry a path: "query → MST-061 → Saia incident".
 *  2. Memory hits — entries from MEMORY.md whose description line
 *     shares lexical bigrams with the question.
 *  3. Trace notes — free-form lines ("vault index: 230 notes, 3 hits").
 *
 * No interaction in v0.1.52 beyond expand/collapse + open-in-Obsidian
 * on each vault hit. Later release will add "promote this hit" /
 * "demote this hit" feedback to tune the embedding ranker.
 */
function ProvenancePanel({ trace }: { trace: ProvenanceTrace }) {
  const [open, setOpen] = useState(false);
  const commitCount = (trace.commitmentHits ?? []).length;
  const totalHits = trace.vaultHits.length + trace.memoryHits.length + commitCount;
  if (totalHits === 0 && trace.notes.length === 0) return null;
  const topScore = trace.vaultHits.length > 0 ? trace.vaultHits[0].score : 0;
  const summary =
    totalHits === 0
      ? "no provenance hits"
      : `${trace.vaultHits.length} vault · ${trace.memoryHits.length} memory${
          commitCount > 0 ? ` · ${commitCount} commit` : ""
        }${topScore > 0 ? ` · top ${Math.round(topScore * 100)}%` : ""}`;
  return (
    <div className={`provenance-panel ${open ? "open" : ""}`}>
      <button
        className="provenance-chip"
        onClick={() => setOpen(!open)}
        title="Show citation trail for this answer"
      >
        <span className="provenance-chip-icon">🔍</span>
        <span className="provenance-chip-label">Show your work</span>
        <span className="provenance-chip-summary">{summary}</span>
        <span className="provenance-chip-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="provenance-body">
          {trace.vaultHits.length > 0 ? (
            <div className="provenance-section">
              <div className="provenance-section-head">
                Vault notes consulted
              </div>
              {trace.vaultHits.map((hit, i) => (
                <div className="provenance-hit" key={`v-${i}`}>
                  <div className="provenance-hit-head">
                    <span
                      className={`provenance-hit-source provenance-hit-source-${hit.source}`}
                    >
                      {hit.source === "graph-walk" ? "graph" : "embed"}
                    </span>
                    <a
                      className="provenance-hit-title"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        window.flexhaul.vault
                          .openInObsidian({ relPath: hit.relPath })
                          .catch(() => {});
                      }}
                      title={`Open ${hit.relPath} in Obsidian`}
                    >
                      {hit.title}
                    </a>
                    <span className="provenance-hit-score">
                      {Math.round(hit.score * 100)}%
                    </span>
                  </div>
                  <div className="provenance-hit-path">
                    {hit.pathFromQuery.map((step, j) => (
                      <span key={j}>
                        {j > 0 ? (
                          <span className="provenance-hit-arrow"> → </span>
                        ) : null}
                        <span
                          className={
                            j === hit.pathFromQuery.length - 1
                              ? "provenance-hit-path-end"
                              : "provenance-hit-path-step"
                          }
                        >
                          {step}
                        </span>
                      </span>
                    ))}
                  </div>
                  <div className="provenance-hit-why">{hit.why}</div>
                  {hit.snippet ? (
                    <div className="provenance-hit-snippet">{hit.snippet}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {trace.memoryHits.length > 0 ? (
            <div className="provenance-section">
              <div className="provenance-section-head">Memory entries</div>
              {trace.memoryHits.map((hit, i) => (
                <div className="provenance-hit" key={`m-${i}`}>
                  <div className="provenance-hit-head">
                    <span className={`provenance-mem-type provenance-mem-${hit.type}`}>
                      {hit.type}
                    </span>
                    <span className="provenance-hit-title">{hit.title}</span>
                    <span className="provenance-hit-file">{hit.file}</span>
                  </div>
                  <div className="provenance-hit-why">{hit.why}</div>
                </div>
              ))}
            </div>
          ) : null}

          {/* v0.1.58: past commitments + outcomes — the wins/losses feedback loop */}
          {trace.commitmentHits && trace.commitmentHits.length > 0 ? (
            <div className="provenance-section">
              <div className="provenance-section-head">
                Past commitments {trace.commitmentHits.some((h) => h.resolved) ? "+ outcomes" : ""}
              </div>
              {trace.commitmentHits.map((hit, i) => (
                <div className="provenance-hit" key={`c-${i}`}>
                  <div className="provenance-hit-head">
                    <span
                      className={`provenance-commit-status provenance-commit-status-${
                        hit.resolved ? "resolved" : "open"
                      }`}
                    >
                      {hit.resolved ? "✓ resolved" : "○ open"}
                    </span>
                    <span className="provenance-hit-title">{hit.verb}</span>
                    {hit.counterparty ? (
                      <span className="provenance-commit-counterparty">
                        w/ {hit.counterparty}
                      </span>
                    ) : null}
                    <span className="provenance-hit-score">
                      {Math.round(hit.score * 100)}%
                    </span>
                  </div>
                  <div className="provenance-hit-why">{hit.why}</div>
                  {hit.text ? (
                    <div className="provenance-hit-snippet">"{hit.text}"</div>
                  ) : null}
                  {hit.resolved && hit.outcome ? (
                    <div className="provenance-commit-outcome">
                      <span className="provenance-commit-outcome-label">Outcome:</span>{" "}
                      {hit.outcome}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="provenance-trace-notes">
            {trace.notes.map((n, i) => (
              <div className="provenance-trace-line" key={i}>
                {n}
              </div>
            ))}
            <div className="provenance-trace-line">
              Gathered in {trace.durationMs}ms.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * v0.1.54 — CommitmentsRow.
 *
 * Renders one pill per extracted commitment (e.g. "ship by Friday").
 * Each pill is clickable — opens a tiny inline resolver where the
 * user types an outcome ("shipped 0.1.55") + Save. The note in the
 * vault gets updated; the pill flips to a resolved-style.
 *
 * The point: senior employees remember their commitments. Prism now
 * does too, and the user closes the loop by recording what actually
 * happened.
 */
function CommitmentsRow({
  commitments,
  onResolve,
}: {
  commitments: Commitment[];
  onResolve: (id: string, outcome: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [outcomeText, setOutcomeText] = useState("");
  if (!commitments || commitments.length === 0) return null;
  return (
    <div className="commitment-row">
      <div className="commitment-row-label">
        <span className="commitment-row-icon">🤝</span> Commitments captured
      </div>
      {commitments.map((c) => (
        <div
          key={c.id}
          className={`commitment-pill ${c.resolved ? "resolved" : ""}`}
        >
          <span className="commitment-pill-verb">{c.verb}</span>
          {c.deadline ? (
            <span className="commitment-pill-deadline">{c.deadline}</span>
          ) : null}
          {c.counterparty ? (
            <span className="commitment-pill-counterparty">
              w/ {c.counterparty}
            </span>
          ) : null}
          {c.resolved ? (
            <span className="commitment-pill-status">
              ✓ {c.outcome ? c.outcome.slice(0, 60) : "resolved"}
            </span>
          ) : editingId === c.id ? (
            <span className="commitment-pill-resolver">
              <input
                className="commitment-pill-input"
                value={outcomeText}
                onChange={(e) => setOutcomeText(e.target.value)}
                placeholder="Outcome (e.g. 'shipped v0.1.55')"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && outcomeText.trim()) {
                    void onResolve(c.id, outcomeText.trim()).then(() => {
                      setEditingId(null);
                      setOutcomeText("");
                    });
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                    setOutcomeText("");
                  }
                }}
              />
              <button
                className="commitment-pill-save"
                disabled={!outcomeText.trim()}
                onClick={() => {
                  void onResolve(c.id, outcomeText.trim()).then(() => {
                    setEditingId(null);
                    setOutcomeText("");
                  });
                }}
              >
                Save
              </button>
            </span>
          ) : (
            <button
              className="commitment-pill-resolve-btn"
              onClick={() => {
                setEditingId(c.id);
                setOutcomeText("");
              }}
              title="Mark this commitment resolved with an outcome"
            >
              Mark resolved
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Per-agent card for a parallel /batch turn (v0.1.30). */
function BatchAgentCard({ agent }: { agent: BatchAgent }) {
  return (
    <div className={`batch-agent batch-agent-${agent.status}`}>
      <div className="batch-agent-head">
        <div className="batch-agent-status">
          {agent.status === "running" ? (
            <span className="batch-agent-spinner" />
          ) : agent.status === "error" ? (
            <span className="batch-agent-x">×</span>
          ) : (
            <span className="batch-agent-check">✓</span>
          )}
        </div>
        <div className="batch-agent-meta">
          <div className="batch-agent-prompt">{agent.prompt}</div>
          {agent.tier ? (
            <div className="batch-agent-tier">{agent.tier}</div>
          ) : null}
        </div>
      </div>
      {agent.status === "error" ? (
        <div className="batch-agent-error">{agent.error ?? "error"}</div>
      ) : (
        <div className="batch-agent-body">
          {agent.text || (agent.status === "running" ? "…" : "(no output)")}
        </div>
      )}
    </div>
  );
}

function BatchSection({ message }: { message: ChatMessage }) {
  const agents = message.batchAgents ?? [];
  const completed = agents.filter((a) => a.status === "done").length;
  const errored = agents.filter((a) => a.status === "error").length;
  const running = agents.length - completed - errored;
  // v0.1.36: /think labels its agents "Attempt 1/2/3"; /batch uses
  // the actual prompt. We detect the think shape by checking whether
  // every agent's prompt matches /^Attempt \d+$/ — cheap heuristic
  // that the renderer doesn't need to know about a mode flag.
  const isThink = agents.length > 0 && agents.every((a) => /^Attempt \d+$/.test(a.prompt));
  return (
    <div className={`batch-section${isThink ? " think-section" : ""}`}>
      <div className="batch-summary">
        <span className="batch-summary-label">
          {isThink
            ? `Think · ${agents.length} attempts`
            : `${agents.length} parallel agents`}
        </span>
        <span className="batch-summary-stats">
          {running > 0 ? `${running} running · ` : ""}
          {completed} done
          {errored > 0 ? ` · ${errored} failed` : ""}
        </span>
      </div>
      <div className="batch-agents-grid">
        {agents.map((a) => (
          <BatchAgentCard key={a.index} agent={a} />
        ))}
      </div>
      {message.reconcilerStatus === "running" ? (
        <div className="batch-reconciler-status">
          <span className="batch-agent-spinner" />{" "}
          {isThink ? "Reranking with Haiku…" : "Reconciling with Haiku…"}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Convert a raw tool name like "mcp__claude_ai_Gmail__search_threads"
 * into a friendly two-part label: { provider, action }.
 *
 *   mcp__claude_ai_Gmail__search_threads   → { provider: "Gmail", action: "search threads" }
 *   mcp__plugin_woz_code__Search           → { provider: "WozCode", action: "Search" }
 *   Read                                   → { provider: null,    action: "Read" }
 */
function friendlyToolName(raw: string): { provider: string | null; action: string } {
  if (!raw.startsWith("mcp__")) {
    return { provider: null, action: raw };
  }
  const parts = raw.replace(/^mcp__/, "").split("__");
  // Provider segment may itself be underscore-joined (e.g. claude_ai_Gmail).
  // Heuristic: drop "claude_ai_" or "plugin_" prefixes, take what's left.
  let providerSeg = parts[0] ?? "";
  providerSeg = providerSeg.replace(/^claude_ai_/, "").replace(/^plugin_/, "");
  // Convert snake → spaces, leave PascalCase / Title Case alone
  const provider = providerSeg
    .split("_")
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
  const action = (parts[1] ?? "")
    .replace(/_/g, " ")
    .toLowerCase();
  return { provider: provider || null, action: action || "tool" };
}

function ToolStrip({
  tools,
  defaultExpanded = false,
}: {
  tools: ToolEvent[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (tools.length === 0) return null;

  const running = tools.filter((t) => t.status === "running").length;
  const erroredCount = tools.filter((t) => t.status === "error").length;
  const summary =
    running > 0
      ? `Using ${running} tool${running === 1 ? "" : "s"}…`
      : `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}`;

  return (
    <div className={`tools ${running > 0 ? "running" : "done"}`}>
      <button
        className="tools-summary"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Hide tool calls" : "Show tool calls"}
      >
        <span className={`tools-dot ${running > 0 ? "spin" : ""}`} />
        <span>{summary}</span>
        {erroredCount > 0 ? (
          <span className="tools-error-tag">{erroredCount} failed</span>
        ) : null}
        <span className="tools-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div className="tools-list">
          {tools.map((t) => {
            const { provider, action } = friendlyToolName(t.name);
            return (
              <div key={t.toolUseId} className={`tool-row tool-row-${t.status}`}>
                <div className="tool-row-head">
                  <span className="tool-icon">
                    {t.status === "running" ? "●" : t.status === "error" ? "✕" : "✓"}
                  </span>
                  {provider ? <span className="tool-provider">{provider}</span> : null}
                  <span className="tool-action">{action}</span>
                  {/* v0.1.39: per-tool wall-clock duration */}
                  {typeof t.durationMs === "number" && t.durationMs >= 0 ? (
                    <span className="tool-duration">
                      {t.durationMs < 1000
                        ? `${t.durationMs}ms`
                        : `${(t.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  ) : null}
                </div>
                {t.inputPreview ? (
                  <div className="tool-input">{t.inputPreview}</div>
                ) : null}
                {t.resultPreview ? (
                  <div className="tool-result">{t.resultPreview}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function isDarkTheme(): boolean {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark") return true;
  if (explicit === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// ── Shiki — module-level lazy singleton ──────────────────────────
//
// One highlighter instance is shared across every CodeBlock. We lazy-
// load on first CodeBlock mount so the ~200KB Shiki bundle isn't on
// the critical path. While loading, code blocks render as plain <pre>
// — once loaded they upgrade in place via state update.
//
// Languages: a curated list covering 95% of what assistants emit.
// Adding more is cheap (Shiki loads grammars on demand) but each one
// adds bundle bytes; the list below is calibrated for typical chat-with-
// LLM usage (Python, TS/JS, Rust, Go, SQL, Bash, JSON, YAML, MD, diff).
const SHIKI_LANGS = [
  "javascript", "typescript", "tsx", "jsx",
  "python", "rust", "go", "java", "kotlin", "swift",
  "ruby", "php", "csharp", "cpp", "c",
  "bash", "sh", "zsh", "fish", "powershell",
  "sql", "graphql", "yaml", "toml", "json", "jsonc",
  "html", "css", "scss",
  "markdown", "diff", "regex",
  "dockerfile", "nginx", "ini",
  "lua", "perl", "haskell", "elixir", "erlang", "clojure",
  "r", "julia", "matlab", "scala", "dart",
] as const;

const SHIKI_THEMES = ["vitesse-dark", "vitesse-light"] as const;

let shikiHighlighterPromise: Promise<any> | null = null;

function getShikiHighlighter(): Promise<any> {
  if (shikiHighlighterPromise) return shikiHighlighterPromise;
  shikiHighlighterPromise = import("shiki").then(({ createHighlighter }) =>
    createHighlighter({
      themes: [...SHIKI_THEMES],
      langs: [...SHIKI_LANGS],
    }),
  );
  return shikiHighlighterPromise;
}

// Map Markdown language tags to Shiki language ids. Most are direct;
// a few common aliases need normalization.
function normalizeShikiLang(lang: string): string {
  const l = (lang || "").toLowerCase().trim();
  const aliases: Record<string, string> = {
    "js": "javascript",
    "ts": "typescript",
    "py": "python",
    "rs": "rust",
    "rb": "ruby",
    "yml": "yaml",
    "md": "markdown",
    "shell": "bash",
    "console": "bash",
  };
  const mapped = aliases[l] || l;
  // Fall back to plaintext for unknown/empty so Shiki doesn't throw.
  return (SHIKI_LANGS as readonly string[]).includes(mapped) ? mapped : "text";
}

function CodeBlock({ children, language }: { children: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  const copy = async () => {
    if (await copyToClipboard(children)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  // Run Shiki on mount + whenever theme/language/content changes.
  useEffect(() => {
    let cancelled = false;
    const theme = isDarkTheme() ? "vitesse-dark" : "vitesse-light";
    const lang = normalizeShikiLang(language);

    getShikiHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          // codeToHtml returns a <pre><code>…</code></pre> with inline
          // styles. Theme-aware: vitesse-dark for dark mode, vitesse-light
          // otherwise. Same VSCode TextMate grammars Microsoft uses.
          const html = hl.codeToHtml(children.trimEnd(), {
            lang,
            theme,
          });
          setHighlightedHtml(html);
        } catch {
          // Shiki throws on malformed input or unloaded language — fall
          // back to plain <pre> rather than crashing the message.
          setHighlightedHtml(null);
        }
      })
      .catch(() => {
        // Network failure loading Shiki bundle — keep plain <pre>.
        setHighlightedHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [children, language]);

  return (
    <div className="codeblock">
      <div className="codeblock-header">
        <span className="codeblock-lang">{language || "text"}</span>
        <button className="codeblock-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {highlightedHtml ? (
        // Shiki-rendered HTML is sanitized by the library (no <script>);
        // the syntax tokens are <span> with inline color styles.
        <div
          className="codeblock-shiki"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        // Pre-Shiki fallback: plain <pre> while highlighter loads (~50ms
        // on first mount; instant on subsequent CodeBlocks since the
        // highlighter is a singleton).
        <pre ref={codeRef} className="codeblock-pre codeblock-pre-plain">
          {children.trimEnd()}
        </pre>
      )}
    </div>
  );
}

type Props = {
  message: ChatMessage;
  streaming?: boolean;
  onEdit?: (newText: string) => void;
  /** v0.1.29: fork from this message into a new chat. */
  onBranch?: () => void;
  artifacts?: Artifact[];
  onOpenArtifact?: (a: Artifact) => void;
  activeArtifactId?: string | null;
  /** v0.1.32: density controls tool-strip + metadata visibility. */
  density?: "verbose" | "normal" | "summary";
  /** v0.1.38: thumbs feedback handler. When set, renders thumb buttons
   *  on assistant messages; clicking persists + fires feedback-aware
   *  profile extraction. Toggle behavior: clicking the active thumb
   *  clears feedback (back to neutral). */
  onFeedback?: (feedback: "up" | "down" | null) => void;
  /** v0.1.42: handler for the "Approve & execute" button. Only renders
   *  on assistant turns that ran in Ask (plan) mode — i.e. claude
   *  proposed but didn't execute. Clicking re-fires a follow-up turn
   *  with permissionMode forced to bypass for just that one turn. */
  onApproveExecute?: () => void;
  /** v0.1.43 (Cua-inspired): replay this assistant turn's tool calls in
   *  the Event Stream Viewer. Only renders when this message has tools. */
  onReplay?: () => void;
  /** v0.1.48: scope dir for Preview diff. Threaded from Settings. */
  previewScope?: string;
  /** v0.1.54: resolve a captured commitment with an outcome string.
   *  Writes back to the vault note + flips the pill to resolved. */
  onResolveCommitment?: (id: string, outcome: string) => Promise<void>;
};

export function Message({
  message,
  streaming = false,
  onEdit,
  onBranch,
  artifacts = [],
  onOpenArtifact,
  activeArtifactId,
  density = "normal",
  onFeedback,
  onApproveExecute,
  onReplay,
  previewScope,
  onResolveCommitment,
}: Props) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const copyAll = async () => {
    if (await copyToClipboard(message.text)) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1400);
    }
  };

  const startEdit = () => {
    setDraft(message.text);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (draft.trim() && draft !== message.text && onEdit) {
      onEdit(draft.trim());
    }
  };

  if (message.role === "user") {
    if (editing) {
      return (
        <div className="msg user editing">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="msg-edit-hint">Enter saves + regenerates · Esc cancels</div>
        </div>
      );
    }
    const imageRefs = extractImageRefs(message.text);
    // v0.1.34: when we have inline images, hide the raw `@<long-path>`
    // from the body and the "Attached files: …" footer that
    // buildMessageWithAttachments() prepends. The image preview makes
    // them visually redundant — and the path noise was making messages
    // ugly. We strip:
    //  1. The trailing "Attached files (please Read these…):\n- @...\n…"
    //  2. Any standalone `@<image-path>` tokens left in the prose.
    const displayedText =
      imageRefs.length > 0
        ? message.text
            .replace(
              /\n*\n*Attached files \(please Read these as part of answering\):[\s\S]*$/i,
              "",
            )
            .replace(IMAGE_REF_RE, "")
            .replace(/[ \t]+\n/g, "\n")
            .trim()
        : message.text;
    return (
      <div className="msg user">
        {message.batch && (
          <div className={`label batch${message.batchMode === "think" ? " think" : ""}`}>
            {message.batchMode === "think"
              ? `✦ Think · ${message.batchCount} attempts`
              : `▲ Batch · ${message.batchCount} prompts in parallel`}
          </div>
        )}
        {displayedText}
        {imageRefs.length > 0 && (
          <div className="msg-inline-images">
            {imageRefs.map((p) => (
              <img
                key={p}
                className="msg-inline-img"
                src={toImgUrl(p)}
                alt={p.split("/").pop() ?? p}
                loading="lazy"
                onError={(e) => {
                  // If the file is gone, hide silently
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ))}
          </div>
        )}
        {onEdit && (
          <button
            className="msg-edit"
            onClick={startEdit}
            title="Edit and regenerate from this point"
          >
            <Pencil size={10} strokeWidth={2.2} /> Edit
          </button>
        )}
        {onBranch && (
          <button
            className="msg-branch"
            onClick={onBranch}
            title="Branch — fork a new chat from this point"
          >
            <GitBranch size={10} strokeWidth={2.2} /> Branch
          </button>
        )}
      </div>
    );
  }

  if (message.role === "system") {
    return <div className="msg system">{message.text}</div>;
  }

  // Assistant — markdown render
  return (
    <div className={`msg assistant${streaming ? " streaming" : ""}`}>
      <button className="msg-copy" onClick={copyAll} title="Copy message">
        {copiedAll ? "Copied" : "Copy"}
      </button>
      {onReplay && message.tools && message.tools.length > 0 && !streaming ? (
        <button
          className="msg-replay"
          onClick={onReplay}
          title={`Replay this turn — open Event Stream Viewer showing the ${message.tools.length} tool call${message.tools.length === 1 ? "" : "s"} from this response`}
        >
          ↻ Replay
        </button>
      ) : null}
      {onFeedback && !streaming ? (
        <div className="msg-feedback">
          <button
            className={`msg-feedback-btn${message.feedback === "up" ? " active up" : ""}`}
            onClick={() => onFeedback(message.feedback === "up" ? null : "up")}
            title={
              message.feedback === "up"
                ? "Clear feedback"
                : "This worked well — reinforce in profile"
            }
            aria-label="Thumbs up"
          >
            <ThumbsUp size={12} strokeWidth={2} />
          </button>
          <button
            className={`msg-feedback-btn${message.feedback === "down" ? " active down" : ""}`}
            onClick={() => onFeedback(message.feedback === "down" ? null : "down")}
            title={
              message.feedback === "down"
                ? "Clear feedback"
                : "This didn't work — add to anti-patterns"
            }
            aria-label="Thumbs down"
          >
            <ThumbsDown size={12} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {message.tools && message.tools.length > 0 && density !== "summary" ? (
        <ToolStrip tools={message.tools} defaultExpanded={density === "verbose"} />
      ) : null}
      {message.batchAgents && message.batchAgents.length > 0 ? (
        <BatchSection message={message} />
      ) : null}
      {artifacts.length > 0 && onOpenArtifact ? (
        <div className="artifact-strip">
          {artifacts.map((a) => (
            <button
              key={a.id}
              className={`artifact-chip ${
                activeArtifactId === a.id ? "active" : ""
              }`}
              onClick={() => onOpenArtifact(a)}
              title={`Preview ${a.type.toUpperCase()}`}
            >
              <span className="artifact-chip-type">{a.type}</span>
              <span className="artifact-chip-title">{a.title}</span>
              <span className="artifact-chip-arrow">→</span>
            </button>
          ))}
        </div>
      ) : null}
      {(() => {
        const refs = extractImageRefs(message.text);
        if (refs.length === 0) return null;
        return (
          <div className="msg-inline-images">
            {refs.map((p) => (
              <img
                key={p}
                className="msg-inline-img"
                src={toImgUrl(p)}
                alt={p.split("/").pop() ?? p}
                loading="lazy"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ))}
          </div>
        );
      })()}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match ? match[1] : "";
            const content = String(children).replace(/\n$/, "");
            if (inline || !content.includes("\n")) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={lang}>{content}</CodeBlock>;
          },
          pre({ children }: any) {
            // CodeBlock renders its own <pre>; this is for non-code <pre>
            return <>{children}</>;
          },
          a({ href, children }: any) {
            // v0.1.40: synthetic prism-vault:// links route through the
            // vault IPC to open in Obsidian via the obsidian:// URI scheme.
            // Catches the [[wikilink]] expansion path.
            if (typeof href === "string" && href.startsWith("prism-vault://")) {
              const target = decodeURIComponent(
                href.slice("prism-vault://".length),
              );
              return (
                <a
                  className="wikilink"
                  href={href}
                  title={`Open in Obsidian → ${target}`}
                  onClick={(e) => {
                    e.preventDefault();
                    // The vault IPC expects a relPath; the wikilink target
                    // is a note TITLE (no folder). Append .md so the open
                    // step works whether the note lives in vault root or
                    // a subfolder (obsidian:// resolves by name).
                    window.flexhaul.vault.openInObsidian({
                      relPath: `${target}.md`,
                    });
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) window.open(href, "_blank");
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {expandWikilinks(message.text)}
      </ReactMarkdown>
      {/* v0.1.44/v0.1.45/v0.1.48: Preview-mode snapshot notice + diff/revert UI. */}
      {!streaming && message.usage?.previewSnapshot ? (
        <PreviewSnapshotCard
          snapshot={message.usage.previewSnapshot}
          scope={previewScope}
        />
      ) : null}
      {/* v0.1.42: Approve & execute. Shows only when the turn ran in
          Ask (plan) mode — claude proposed but didn't act. Clicking
          re-fires a follow-up turn with one-shot Bypass override. */}
      {!streaming &&
      onApproveExecute &&
      message.usage?.permissionMode === "ask" &&
      turnHasExecutablePlan(message.text) ? (
        <div className="msg-approve-row">
          <button
            className="msg-approve-btn"
            onClick={onApproveExecute}
            title="Approve this plan and execute it. Sends a new turn with Bypass for just this one operation. ⌘⏎ shortcut."
          >
            <span className="msg-approve-icon">⚡</span> Approve & execute
            <kbd className="msg-approve-kbd">⌘⏎</kbd>
          </button>
          <span className="msg-approve-hint">
            One-shot Bypass — your default mode stays Ask.
          </span>
        </div>
      ) : null}
      {message.usage && !streaming ? <UsagePill usage={message.usage} /> : null}
      {/* v0.1.52: Provenance Panel — collapsible citation trail. */}
      {message.provenance ? <ProvenancePanel trace={message.provenance} /> : null}
      {/* v0.1.54: Commitments captured from this turn. */}
      {message.commitments && message.commitments.length > 0 && onResolveCommitment ? (
        <CommitmentsRow
          commitments={message.commitments}
          onResolve={onResolveCommitment}
        />
      ) : null}
    </div>
  );
}
