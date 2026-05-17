/**
 * Event Stream Viewer (v0.1.39) — slide-in dev panel showing every tool
 * call on the current turn with wall-clock timing + status + previews.
 *
 * Pattern lifted from Agent TARS's Event Stream Viewer. Their version
 * shows the multi-tool streaming pipeline for debugging; ours is the
 * Prism-shaped echo — focused on the active assistant turn, tied to
 * Prism's existing ToolEvent data, no separate event-bus to maintain.
 *
 * Toggle with ⌘E (mirrors UI-TARS's runtime-settings panel). Auto-opens
 * when there's any tool activity on the current turn if you've never
 * dismissed it; closing it persists the dismissal for that turn.
 */
import { Activity, X as XIcon } from "lucide-react";
import type { ToolEvent } from "./gateway";

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtClock(ts: number | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Strip the mcp__ prefix when present so "mcp__insforge__fetch-docs"
 *  reads as "insforge · fetch-docs" in the viewer. */
function splitName(name: string): { provider: string | null; action: string } {
  if (!name.startsWith("mcp__")) return { provider: null, action: name };
  const parts = name.replace(/^mcp__/, "").split("__");
  const provider = (parts[0] ?? "")
    .replace(/^claude_ai_/, "")
    .replace(/^plugin_/, "");
  const action = (parts[1] ?? "tool").replace(/_/g, " ");
  return { provider: provider || null, action };
}

type Props = {
  open: boolean;
  onClose: () => void;
  tools: ToolEvent[];
  turnStartedAt: number | null;
  /** v0.1.43 (Cua-inspired): when set, the viewer is in "replay" mode
   *  showing a past turn's tool calls rather than the current one. Used
   *  by the Replay button on assistant messages. */
  replayLabel?: string | null;
};

export function EventStream({
  open,
  onClose,
  tools,
  turnStartedAt,
  replayLabel,
}: Props) {
  if (!open) return null;
  const running = tools.filter((t) => t.status === "running").length;
  const errored = tools.filter((t) => t.status === "error").length;
  const done = tools.length - running - errored;
  const totalMs = tools.reduce(
    (sum, t) => sum + (t.durationMs ?? 0),
    0,
  );
  return (
    <aside className="event-stream" role="dialog" aria-label="Event stream">
      <div className="event-stream-head">
        <div className="event-stream-title">
          <Activity size={13} strokeWidth={2.2} />
          {replayLabel ? `Replay · ${replayLabel}` : "Event Stream"}
        </div>
        <div className="event-stream-stats">
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
          {running > 0 ? ` · ${running} running` : ""}
          {errored > 0 ? ` · ${errored} failed` : ""}
          {totalMs > 0 ? ` · ${fmtDuration(totalMs)} total` : ""}
        </div>
        <button
          className="event-stream-close"
          onClick={onClose}
          title="Close (⌘E or Esc)"
        >
          <XIcon size={13} strokeWidth={2.2} />
        </button>
      </div>

      <div className="event-stream-body">
        {tools.length === 0 ? (
          <div className="event-stream-empty">
            No tool activity yet on this turn.
            <div className="event-stream-empty-hint">
              Tool calls appear here in real time as Claude uses them.
              <br />
              ⌘E to toggle.
            </div>
          </div>
        ) : (
          <ol className="event-stream-list">
            {tools.map((t, i) => {
              const { provider, action } = splitName(t.name);
              const sinceTurnStart =
                turnStartedAt && t.startedAt
                  ? t.startedAt - turnStartedAt
                  : null;
              return (
                <li
                  key={t.toolUseId || i}
                  className={`event-stream-row event-stream-row-${t.status}`}
                >
                  <div className="event-stream-row-bar">
                    <span
                      className={`event-stream-dot event-stream-dot-${t.status}`}
                    />
                    {i < tools.length - 1 ? (
                      <span className="event-stream-line" />
                    ) : null}
                  </div>
                  <div className="event-stream-row-body">
                    <div className="event-stream-row-head">
                      <span className="event-stream-row-action">
                        {provider ? (
                          <span className="event-stream-row-provider">
                            {provider}
                          </span>
                        ) : null}
                        <span className="event-stream-row-name">{action}</span>
                      </span>
                      <span className="event-stream-row-time">
                        {sinceTurnStart !== null
                          ? `+${fmtDuration(sinceTurnStart)}`
                          : fmtClock(t.startedAt)}
                        {typeof t.durationMs === "number"
                          ? ` · ${fmtDuration(t.durationMs)}`
                          : t.status === "running"
                            ? " · running"
                            : ""}
                      </span>
                    </div>
                    {t.inputPreview ? (
                      <div className="event-stream-row-input">
                        {t.inputPreview}
                      </div>
                    ) : null}
                    {t.resultPreview ? (
                      <div
                        className={`event-stream-row-result${
                          t.isError ? " err" : ""
                        }`}
                      >
                        {t.resultPreview}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="event-stream-foot">
        {done}/{tools.length} done · press <kbd>⌘E</kbd> to close
      </div>
    </aside>
  );
}
