/**
 * Slash command autocomplete dropdown.
 *
 * Renders above the composer when the input starts with `/` and the
 * cursor is still inside the first word. Filters discovered commands
 * by prefix match; arrow keys navigate; Enter or Tab inserts the
 * selected command name + a trailing space; Escape dismisses.
 *
 * The actual routing happens in claude CLI — Prism just makes the
 * commands discoverable.
 */
import { useEffect, useMemo, useRef } from "react";

type Props = {
  open: boolean;
  query: string;                        // text after the leading `/`, before the first space
  commands: DiscoveredCommand[];
  selectedIndex: number;
  onSelect: (cmd: DiscoveredCommand) => void;
  onHoverIndex: (i: number) => void;
};

export function filterCommands(
  query: string,
  commands: DiscoveredCommand[],
): DiscoveredCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands.slice(0, 12);
  const starts: DiscoveredCommand[] = [];
  const contains: DiscoveredCommand[] = [];
  for (const c of commands) {
    const lname = c.name.toLowerCase();
    if (lname.startsWith(q)) starts.push(c);
    else if (lname.includes(q) || c.description.toLowerCase().includes(q))
      contains.push(c);
  }
  return [...starts, ...contains].slice(0, 12);
}

export function SlashCommandMenu({
  open,
  query,
  commands,
  selectedIndex,
  onSelect,
  onHoverIndex,
}: Props) {
  const filtered = useMemo(() => filterCommands(query, commands), [
    query,
    commands,
  ]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = containerRef.current?.querySelector<HTMLDivElement>(
      `[data-slash-idx="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  if (!open || filtered.length === 0) return null;

  return (
    <div className="slash-menu" ref={containerRef}>
      <div className="slash-menu-header">
        {filtered.length} command{filtered.length === 1 ? "" : "s"}
        {query ? <span className="slash-menu-query">/{query}</span> : null}
      </div>
      {filtered.map((c, i) => (
        <div
          key={c.filePath}
          data-slash-idx={i}
          className={`slash-menu-item ${i === selectedIndex ? "active" : ""}`}
          onMouseDown={(e) => {
            // mouseDown not click — fires before textarea blur, keeps focus.
            e.preventDefault();
            onSelect(c);
          }}
          onMouseEnter={() => onHoverIndex(i)}
        >
          <div className="slash-menu-item-row">
            <span className="slash-menu-name">/{c.name}</span>
            <span className="slash-menu-source">{c.source}</span>
          </div>
          {c.description ? (
            <div className="slash-menu-desc">{c.description}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Returns the filtered list size — App.tsx uses this to clamp the
 *  selectedIndex during keyboard nav. Exported so the parent doesn't
 *  have to recompute the same filter. */
export function visibleCommandCount(
  query: string,
  commands: DiscoveredCommand[],
): number {
  return filterCommands(query, commands).length;
}

/** Same idea — return the entry at index, for Enter/Tab handling. */
export function commandAt(
  query: string,
  commands: DiscoveredCommand[],
  index: number,
): DiscoveredCommand | null {
  const f = filterCommands(query, commands);
  return f[index] ?? null;
}
