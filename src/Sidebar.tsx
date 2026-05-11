import { useState } from "react";
import type { Chat } from "./chats";

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
          ☰
        </button>
        <button
          className="sidebar-toggle sidebar-new"
          onClick={onNewChat}
          title="New chat (⌘N)"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-toggle" onClick={onToggle} title="Hide sidebar (⌘1)">
          ☰
        </button>
        <button className="sidebar-new-full" onClick={onNewChat} title="New chat (⌘N)">
          + New chat
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
              ⚙
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
          <div className="sidebar-empty">No chats yet. Start one with the + button above.</div>
        )}
        {chats.map((chat) => (
          <div
            key={chat.id}
            className={`sidebar-item ${chat.id === activeId ? "active" : ""}`}
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
              <div className="sidebar-item-title">{chat.title}</div>
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
                ✎
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
                  ↓
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
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
