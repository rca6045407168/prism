/**
 * Projects — collections of chats with shared instructions (v0.1.29).
 *
 * The "Claude Desktop has Projects, Prism doesn't" gap, closed.
 *
 * Data model: a Project has a name, free-form `instructions` (used
 * as a system-prompt prefix on every turn in a chat that belongs to
 * the project), and a creation timestamp. Chats can optionally
 * declare `projectId` to inherit the project's instructions.
 *
 * Persistence: localStorage in the renderer under `prism.projects.v1`.
 * Same place as chats — single source of truth, no IPC for CRUD
 * (rare enough operations that we don't need a main-process
 * roundtrip).
 *
 * Lifecycle:
 *   - Create: `createProject(name)` — empty instructions
 *   - Update: `updateProject(id, { name?, instructions? })`
 *   - Delete: `deleteProject(id)` — also unassigns from any chats
 *     (caller responsibility; renderer does this when handling
 *     the delete action)
 *   - List:   `listProjects()` — sorted by name ASC
 */

export type Project = {
  id: string;
  name: string;
  /** Free-form prose injected as a system-prompt prefix on every
   *  chat turn that belongs to this project. Plain text or markdown
   *  — claude doesn't care which. */
  instructions: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "prism.projects.v1";

function read(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) => p && typeof p.id === "string" && typeof p.name === "string",
    );
  } catch {
    return [];
  }
}

function write(projects: Project[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    /* quota / serialization failure — ignore */
  }
}

export function listProjects(): Project[] {
  return read().sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(id: string): Project | null {
  return read().find((p) => p.id === id) ?? null;
}

export function createProject(name: string, instructions = ""): Project {
  const project: Project = {
    id: `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Untitled project",
    instructions,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const list = read();
  list.push(project);
  write(list);
  return project;
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, "name" | "instructions">>,
): Project | null {
  const list = read();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  list[idx] = {
    ...list[idx],
    ...updates,
    updatedAt: Date.now(),
  };
  write(list);
  return list[idx];
}

export function deleteProject(id: string): void {
  write(read().filter((p) => p.id !== id));
}
