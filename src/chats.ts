/**
 * Multi-chat persistence layer (v0.1.5).
 *
 * Each chat has an id, title, message list, and last-updated timestamp.
 * All chats live in localStorage under `prism.chats.v1`. The currently-open
 * chat id is in `prism.chats.activeId`.
 *
 * Storage shape:
 *   {
 *     [chatId]: {
 *       id: string,
 *       title: string,
 *       messages: ChatMessage[],
 *       createdAt: number,
 *       updatedAt: number,
 *     }
 *   }
 *
 * Title generation: first 60 chars of the first user message, or "New chat".
 */
import type { ChatMessage } from "./gateway";

export type Chat = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** claude CLI session UUID for `--resume`. Captured from the first turn's
   *  init event. Lets us actually have separate conversations across chats
   *  on the backend (not just on the UI). v0.1.9. */
  claudeSessionId?: string | null;
  /** Project this chat belongs to. When set, the project's `instructions`
   *  are injected as a system-prompt prefix on every turn. v0.1.29. */
  projectId?: string | null;
};

const CHATS_KEY = "prism.chats.v1";
const ACTIVE_KEY = "prism.chats.activeId";
const MAX_MSGS_PER_CHAT = 500;

function genId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function readAll(): Record<string, Chat> {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(chats: Record<string, Chat>): void {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch {
    // localStorage may be full; silently drop the write — user keeps the
    // in-memory state, just won't persist this turn.
  }
}

export function listChats(): Chat[] {
  return Object.values(readAll()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChat(id: string): Chat | null {
  return readAll()[id] ?? null;
}

export function createChat(projectId: string | null = null): Chat {
  const id = genId();
  const now = Date.now();
  const chat: Chat = {
    id,
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
    projectId,
  };
  const all = readAll();
  all[id] = chat;
  writeAll(all);
  return chat;
}

/** v0.1.29: when a project is deleted, strip its id from every chat
 *  so we don't dangle dead references. Chats themselves survive. */
export function unassignFromProject(projectId: string): void {
  const all = readAll();
  let changed = false;
  for (const id of Object.keys(all)) {
    if (all[id]?.projectId === projectId) {
      all[id] = { ...all[id], projectId: null, updatedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

/** v0.1.29: assign / unassign a chat from a project. */
export function setChatProject(id: string, projectId: string | null): Chat | null {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = { ...all[id], projectId, updatedAt: Date.now() };
  writeAll(all);
  return all[id];
}

/** v0.1.29: fork — clone messages up to (and including) a given
 *  index into a brand-new chat with a fresh session. Used by the
 *  "Branch from here" action. The new chat starts in the same
 *  project as the parent. */
export function forkChatAtIndex(
  parentId: string,
  uptoIndex: number,
): Chat | null {
  const all = readAll();
  const parent = all[parentId];
  if (!parent) return null;
  const sliced = parent.messages.slice(0, uptoIndex + 1);
  if (sliced.length === 0) return null;
  const id = genId();
  const now = Date.now();
  const baseTitle = parent.title.replace(/^Branch of /, "");
  const chat: Chat = {
    id,
    title: `Branch of ${baseTitle}`,
    messages: sliced,
    createdAt: now,
    updatedAt: now,
    projectId: parent.projectId ?? null,
    // Fresh session — branches diverge on the backend too. claude will
    // pick up the slice via the next user message; no --resume.
    claudeSessionId: null,
  };
  all[id] = chat;
  writeAll(all);
  return chat;
}

export function saveChat(chat: Chat): void {
  const all = readAll();
  all[chat.id] = {
    ...chat,
    messages: chat.messages.slice(-MAX_MSGS_PER_CHAT),
    updatedAt: Date.now(),
  };
  writeAll(all);
}

export function renameChat(id: string, title: string): Chat | null {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = { ...all[id], title: title.trim() || "New chat", updatedAt: Date.now() };
  writeAll(all);
  return all[id];
}

export function deleteChat(id: string): void {
  const all = readAll();
  delete all[id];
  writeAll(all);
  if (loadActiveId() === id) {
    saveActiveId(null);
  }
}

export function autoTitle(messages: ChatMessage[], current: string): string {
  // Auto-name a chat from its first user message — but only if it's still
  // got the default title. Once the user renames it, leave it alone.
  if (current && current !== "New chat") return current;
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const t = firstUser.text.replace(/\s+/g, " ").trim().slice(0, 60);
  return t || "New chat";
}

export function searchChats(query: string): Chat[] {
  const q = query.toLowerCase().trim();
  if (!q) return listChats();
  return listChats().filter((c) => {
    if (c.title.toLowerCase().includes(q)) return true;
    return c.messages.some((m) => m.text.toLowerCase().includes(q));
  });
}

export function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // ignore
  }
}

/**
 * On v0.1.5 first launch: migrate the legacy single-chat localStorage key
 * (`prism.chat.v1`) into a single Chat record so users don't lose history.
 */
export function migrateLegacyChat(): Chat | null {
  try {
    const legacy = localStorage.getItem("prism.chat.v1");
    if (!legacy) return null;
    const messages: ChatMessage[] = JSON.parse(legacy);
    if (!Array.isArray(messages) || messages.length === 0) {
      localStorage.removeItem("prism.chat.v1");
      return null;
    }
    const all = readAll();
    // If the user already has chats (e.g. ran v0.1.5 once), don't double-migrate
    if (Object.keys(all).length > 0) {
      localStorage.removeItem("prism.chat.v1");
      return null;
    }
    const id = genId();
    const now = Date.now();
    const chat: Chat = {
      id,
      title: autoTitle(messages, "New chat"),
      messages,
      createdAt: now,
      updatedAt: now,
    };
    all[id] = chat;
    writeAll(all);
    saveActiveId(id);
    localStorage.removeItem("prism.chat.v1"); // legacy key cleaned up
    return chat;
  } catch {
    return null;
  }
}
