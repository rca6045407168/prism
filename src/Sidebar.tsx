import { useState } from "react";
import type { Chat } from "./chats";
import {
  PanelLeft,
  Plus,
  Pencil,
  Download,
  X as XIcon,
  Settings as SettingsIcon,
} from "lucide-react";

type Props = {
  chats: Chat[];
  activeId: string | null;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport?: (id: string) => void;
  // v0.1.29: projects
  projects?: { id: string; name: string }[];
  activeProjectId?: string | null;
  onSelectProject?: (projectId: string | null) => void;
  onManageProjects?: () => void;
  onMoveChatToProject?: (chatId: string, projectId: string | null) => void;
  onToggle: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** v0.1.33: id of the chat currently streaming a turn — draws a pulse
   *  dot on that row so the user can see progress while scrolling around. */
  streamingChatId?: string | null;
  /** v0.1.40: map of chatId → vault relPath for chats that have been
   *  saved to Obsidian via ⌘⇧S. Renders a small "saved" indicator next
   *  to the chat title so the user can tell at a glance what's archived. */
  savedToVault?: Record<string, string>;
};

export function Sidebar({
  chats,
  activeId,
  collapsed,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  onExport,
  projects,
  activeProjectId,
  onSelectProject,
  onManageProjects,
  onMoveChatToProject,
  onToggle,
  searchQuery,
  onSearchChange,
  streamingChatId,
  savedToVault,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const startRename = (chat: Chat) => {
    setRenamingId(chat.id);
    setRenameDraft(chat.title);
  };

  const commitRename = () => {
    if (renamingId) onRename(renamingId, renameDraft);
    setRenamingId(null);
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button
          className="sidebar-toggle"
          onClick={onToggle}
          title="Show sidebar (⌘1)"
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="sidebar-toggle sidebar-new"
          onClick={onNewChat}
          title="New chat (⌘N)"
        >
          <Plus size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-toggle" onClick={onToggle} title="Hide sidebar (⌘1)">
          <PanelLeft size={14} />
        </button>
        <button className="sidebar-new-full" onClick={onNewChat} title="New chat (⌘N)">
          <Plus size={12} strokeWidth={2.5} /> New chat
        </button>
      </div>

      {projects && projects.length > 0 && onSelectProject ? (
        <div className="sidebar-projects">
          <button
            className={`sidebar-project-chip ${activeProjectId === null ? "active" : ""}`}
            onClick={() => onSelectProject(null)}
            title="All chats"
          >
            All
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`sidebar-project-chip ${activeProjectId === p.id ? "active" : ""}`}
              onClick={() => onSelectProject(p.id)}
              title={`Project: ${p.name}`}
            >
              {p.name}
            </button>
          ))}
          {onManageProjects ? (
            <button
              className="sidebar-project-manage"
              onClick={onManageProjects}
              title="Manage projects"
            >
              <SettingsIcon size={11} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      ) : onManageProjects ? (
        <div className="sidebar-projects">
          <button
            className="sidebar-project-chip ghost"
            onClick={onManageProjects}
            title="Create a project"
          >
            + New project
          </button>
        </div>
      ) : null}

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search chats…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <div className="sidebar-list">
        {chats.length === 0 && (
          <div className="sidebar-empty">
            <div className="sidebar-empty-title">No chats yet</div>
            <div className="sidebar-empty-sub">
              Start one with <kbd>⌘N</kbd> — or open the command palette with{" "}
              <kbd>⌘K</kbd>.
            </div>
            <button className="sidebar-empty-cta" onClick={onNewChat}>
              <Plus size={12} strokeWidth={2.5} /> New chat
            </button>
          </div>
        )}
        {chats.map((chat) => (
          <div
            key={chat.id}
            className={`sidebar-item ${chat.id === activeId ? "active" : ""}${
              chat.id === streamingChatId ? " streaming" : ""
            }`}
            onClick={() => {
              if (renamingId !== chat.id) onSelect(chat.id);
            }}
          >
            {renamingId === chat.id ? (
              <input
                className="sidebar-rename"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="sidebar-item-title">
                {chat.id === streamingChatId && (
                  <span className="sidebar-stream-dot" title="Streaming…" />
                )}
                {chat.title}
                {savedToVault?.[chat.id] ? (
                  <span
                    className="sidebar-vault-badge"
                    title={`Saved to vault → ${savedToVault[chat.id]}`}
                  >
                    ◆
                  </span>
                ) : null}
              </div>
            )}
            <div className="sidebar-item-meta">
              <span>{chat.messages.length} {chat.messages.length === 1 ? "msg" : "msgs"}</span>
            </div>
            <div className="sidebar-item-actions">
              <button
                className="sidebar-action"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(chat);
                }}
                title="Rename"
              >
                <Pencil size={11} strokeWidth={2} />
              </button>
              {onExport ? (
                <button
                  className="sidebar-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport(chat.id);
                  }}
                  title="Export chat as markdown"
                >
                  <Download size={11} strokeWidth={2} />
                </button>
              ) : null}
              <button
                className="sidebar-action sidebar-action-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${chat.title}"? This can't be undone.`)) {
                    onDelete(chat.id);
                  }
                }}
                title="Delete"
              >
                <XIcon size={12} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
