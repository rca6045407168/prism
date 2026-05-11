/**
 * Command palette — ⌘K-triggered fuzzy launcher (v0.1.32).
 *
 * Unified surface across:
 *   - Chats (jump to any past conversation)
 *   - Projects (switch project context)
 *   - Skills / slash commands (run an existing /skill)
 *   - App actions (new chat, new project, toggle pin, open settings tab,
 *     toggle density, etc.)
 *
 * Borrowed shape from Raycast / Linear / VSCode — a centered modal with
 * a single input on top, grouped results below, arrow-key navigation,
 * keyboard shortcuts visible per item, Enter to execute, Esc to dismiss.
 *
 * No fuzzy search dep — substring + prefix scoring is good enough for a
 * corpus that's typically < 200 items. Saves the bundle hit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  FolderPlus,
  Pin,
  Settings as SettingsIcon,
  MessageSquare,
  Folder,
  Sparkles,
  Download,
  GitBranch,
  Eye,
  EyeOff,
  Mic,
} from "lucide-react";
import type { Chat } from "./chats";
import type { Project } from "./projects";

type CommandKind = "action" | "chat" | "project" | "skill";

export type CommandItem = {
  id: string;
  kind: CommandKind;
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon?: "plus" | "folder-plus" | "pin" | "settings" | "chat" | "folder" | "skill" | "download" | "branch" | "eye" | "eye-off" | "mic";
  onSelect: () => void;
};

function iconFor(k: NonNullable<CommandItem["icon"]>) {
  const props = { size: 14, strokeWidth: 1.8 };
  switch (k) {
    case "plus": return <Plus {...props} />;
    case "folder-plus": return <FolderPlus {...props} />;
    case "pin": return <Pin {...props} />;
    case "settings": return <SettingsIcon {...props} />;
    case "chat": return <MessageSquare {...props} />;
    case "folder": return <Folder {...props} />;
    case "skill": return <Sparkles {...props} />;
    case "download": return <Download {...props} />;
    case "branch": return <GitBranch {...props} />;
    case "eye": return <Eye {...props} />;
    case "eye-off": return <EyeOff {...props} />;
    case "mic": return <Mic {...props} />;
    default: return null;
  }
}

const KIND_ORDER: Record<CommandKind, number> = {
  action: 0,
  project: 1,
  chat: 2,
  skill: 3,
};

const KIND_LABEL: Record<CommandKind, string> = {
  action: "Actions",
  project: "Projects",
  chat: "Chats",
  skill: "Skills",
};

function score(query: string, label: string, subtitle?: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 10;
  if (l.includes(q)) return 6;
  if (subtitle && subtitle.toLowerCase().includes(q)) return 3;
  // Fuzzy: every char of q appears in l in order
  let i = 0;
  for (const c of l) {
    if (c === q[i]) i++;
    if (i === q.length) return 1;
  }
  return 0;
}

type Props = {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
};

export function CommandPalette({ open, onClose, items }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter + rank + group
  const filtered = useMemo(() => {
    const scored = items
      .map((it) => ({ it, s: score(query, it.label, it.subtitle) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => {
        if (b.s !== a.s) return b.s - a.s;
        const ko = KIND_ORDER[a.it.kind] - KIND_ORDER[b.it.kind];
        if (ko !== 0) return ko;
        return a.it.label.localeCompare(b.it.label);
      })
      .map((x) => x.it);
    return scored.slice(0, 60);
  }, [items, query]);

  // Group by kind for display
  const grouped = useMemo(() => {
    const map = new Map<CommandKind, CommandItem[]>();
    for (const it of filtered) {
      if (!map.has(it.kind)) map.set(it.kind, []);
      map.get(it.kind)!.push(it);
    }
    return Array.from(map.entries()).sort(
      (a, b) => KIND_ORDER[a[0]] - KIND_ORDER[b[0]],
    );
  }, [filtered]);

  // Flat index for keyboard navigation
  const flatIds = useMemo(
    () => grouped.flatMap(([, list]) => list.map((it) => it.id)),
    [grouped],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // Focus next tick so the autoFocus doesn't lose to the parent
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (selected >= flatIds.length) setSelected(Math.max(0, flatIds.length - 1));
  }, [flatIds, selected]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLDivElement>(
      `[data-cmd-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(flatIds.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const id = flatIds[selected];
      const item = items.find((x) => x.id === id);
      if (item) {
        item.onSelect();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Build a flat-index map so each rendered row knows its position
  let flatIdx = -1;

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder="Search chats, projects, skills, actions…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKey}
        />
        <div className="cmd-list" ref={listRef}>
          {grouped.length === 0 ? (
            <div className="cmd-empty">No matches.</div>
          ) : (
            grouped.map(([kind, list]) => (
              <div key={kind} className="cmd-group">
                <div className="cmd-group-head">{KIND_LABEL[kind]}</div>
                {list.map((it) => {
                  flatIdx++;
                  const isSelected = flatIdx === selected;
                  return (
                    <div
                      key={it.id}
                      data-cmd-idx={flatIdx}
                      className={`cmd-item${isSelected ? " selected" : ""}`}
                      onMouseEnter={() => setSelected(flatIdx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        it.onSelect();
                        onClose();
                      }}
                    >
                      <span className="cmd-item-icon">
                        {it.icon ? iconFor(it.icon) : null}
                      </span>
                      <span className="cmd-item-label">{it.label}</span>
                      {it.subtitle ? (
                        <span className="cmd-item-subtitle">{it.subtitle}</span>
                      ) : null}
                      {it.shortcut ? (
                        <span className="cmd-item-shortcut">{it.shortcut}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="cmd-footer">
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

/** Helper for App.tsx — turn the world into a flat CommandItem[]. */
export function buildCommandItems(args: {
  chats: Chat[];
  projects: Project[];
  skills: DiscoveredCommand[];
  activeProjectId: string | null;
  actions: {
    newChat: () => void;
    openProjectManager: () => void;
    selectProject: (id: string | null) => void;
    selectChat: (id: string) => void;
    openSettings: (tab?: "general" | "memory" | "speed" | "account") => void;
    togglePinned: () => void;
    toggleVoice: () => void;
    openSideChat: () => void;
    setDensity: (d: "verbose" | "normal" | "summary") => void;
    exportActiveChat: () => void;
    runSkill: (name: string) => void;
  };
  pinned: boolean;
  density: "verbose" | "normal" | "summary";
}): CommandItem[] {
  const out: CommandItem[] = [];

  // Top-level app actions
  out.push({
    id: "act-new-chat",
    kind: "action",
    label: "New chat",
    shortcut: "⌘N",
    icon: "plus",
    onSelect: args.actions.newChat,
  });
  out.push({
    id: "act-new-project",
    kind: "action",
    label: "New project…",
    icon: "folder-plus",
    onSelect: args.actions.openProjectManager,
  });
  out.push({
    id: "act-side-chat",
    kind: "action",
    label: "Open Side Chat",
    subtitle: "Scratchpad over the main chat",
    shortcut: "⌘;",
    icon: "branch",
    onSelect: args.actions.openSideChat,
  });
  out.push({
    id: "act-toggle-pin",
    kind: "action",
    label: args.pinned ? "Unpin window" : "Pin window (always on top)",
    icon: "pin",
    onSelect: args.actions.togglePinned,
  });
  out.push({
    id: "act-voice",
    kind: "action",
    label: "Toggle voice input",
    icon: "mic",
    onSelect: args.actions.toggleVoice,
  });
  out.push({
    id: "act-export",
    kind: "action",
    label: "Export current chat as markdown",
    icon: "download",
    onSelect: args.actions.exportActiveChat,
  });

  // Density modes
  for (const d of ["verbose", "normal", "summary"] as const) {
    out.push({
      id: `act-density-${d}`,
      kind: "action",
      label: `Density: ${d[0].toUpperCase()}${d.slice(1)}`,
      subtitle: args.density === d ? "current" : undefined,
      icon: d === "summary" ? "eye-off" : "eye",
      onSelect: () => args.actions.setDensity(d),
    });
  }

  // Settings tabs
  for (const tab of ["general", "memory", "speed", "account"] as const) {
    out.push({
      id: `act-settings-${tab}`,
      kind: "action",
      label: `Settings → ${tab[0].toUpperCase()}${tab.slice(1)}`,
      icon: "settings",
      onSelect: () => args.actions.openSettings(tab),
    });
  }

  // Projects — quick-switch
  out.push({
    id: "proj-all",
    kind: "project",
    label: "All chats",
    subtitle: args.activeProjectId === null ? "current" : undefined,
    icon: "folder",
    onSelect: () => args.actions.selectProject(null),
  });
  for (const p of args.projects) {
    out.push({
      id: `proj-${p.id}`,
      kind: "project",
      label: p.name,
      subtitle: args.activeProjectId === p.id ? "current" : undefined,
      icon: "folder",
      onSelect: () => args.actions.selectProject(p.id),
    });
  }

  // Recent chats — top 30
  const recentChats = [...args.chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  for (const c of recentChats) {
    const preview = c.messages[c.messages.length - 1]?.text?.slice(0, 60);
    out.push({
      id: `chat-${c.id}`,
      kind: "chat",
      label: c.title || "Untitled chat",
      subtitle: preview,
      icon: "chat",
      onSelect: () => args.actions.selectChat(c.id),
    });
  }

  // Skills
  for (const s of args.skills) {
    out.push({
      id: `skill-${s.name}`,
      kind: "skill",
      label: `/${s.name}`,
      subtitle: s.description.slice(0, 80),
      icon: "skill",
      onSelect: () => args.actions.runSkill(s.name),
    });
  }

  return out;
}
