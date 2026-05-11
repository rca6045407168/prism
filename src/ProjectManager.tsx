/**
 * Project manager modal (v0.1.29). Lists projects, lets the user
 * pick one to edit (name + instructions), create a new one, or
 * delete an existing one. Survives the parent App.tsx not being
 * touched too much.
 *
 * Storage is in `src/projects.ts` (localStorage). This component
 * only deals with the IDs + already-loaded list; the parent passes
 * handlers that go back through `createProject` / `updateProject` /
 * `deleteProject`.
 */
import { useEffect, useMemo, useState } from "react";
import type { Project } from "./projects";

type Props = {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  initialEditId?: string | null;
  onCreate: (name: string) => void;
  onUpdate: (id: string, updates: { name?: string; instructions?: string }) => void;
  onDelete: (id: string) => void;
};

export function ProjectManager({
  open,
  onClose,
  projects,
  initialEditId,
  onCreate,
  onUpdate,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(
    initialEditId ?? null,
  );
  const [nameDraft, setNameDraft] = useState("");
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [newName, setNewName] = useState("");

  // When the modal opens, snap to initialEditId; if there is one, load
  // its fields. Otherwise show the create-only state.
  useEffect(() => {
    if (open) setEditingId(initialEditId ?? null);
  }, [open, initialEditId]);

  const editing = useMemo(
    () => projects.find((p) => p.id === editingId) ?? null,
    [projects, editingId],
  );

  useEffect(() => {
    if (editing) {
      setNameDraft(editing.name);
      setInstructionsDraft(editing.instructions);
    } else {
      setNameDraft("");
      setInstructionsDraft("");
    }
  }, [editing]);

  if (!open) return null;

  const commit = () => {
    if (!editingId) return;
    onUpdate(editingId, {
      name: nameDraft.trim() || "Untitled project",
      instructions: instructionsDraft,
    });
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Projects</h2>
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <div className="project-mgr">
            <div className="project-mgr-list">
              <div className="project-mgr-list-head">All projects</div>
              {projects.length === 0 ? (
                <div className="settings-memory-empty">
                  No projects yet. Create one below.
                </div>
              ) : (
                projects.map((p) => (
                  <button
                    key={p.id}
                    className={`project-mgr-item ${
                      p.id === editingId ? "active" : ""
                    }`}
                    onClick={() => setEditingId(p.id)}
                  >
                    {p.name}
                  </button>
                ))
              )}
              <form
                className="project-mgr-create"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newName.trim()) return;
                  onCreate(newName.trim());
                  setNewName("");
                }}
              >
                <input
                  type="text"
                  placeholder="New project name…"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button type="submit" disabled={!newName.trim()}>
                  Create
                </button>
              </form>
            </div>

            <div className="project-mgr-detail">
              {editing ? (
                <>
                  <div className="settings-row">
                    <label>Name</label>
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                    />
                  </div>
                  <div className="settings-row">
                    <label>Instructions</label>
                    <textarea
                      className="project-mgr-instructions"
                      value={instructionsDraft}
                      onChange={(e) => setInstructionsDraft(e.target.value)}
                      placeholder={
                        "Free-form text injected as a system-prompt prefix on " +
                        "every chat in this project.\n\nExample: 'This project is " +
                        "FlexHaul GTM. Drafts should match Richard's voice (terse, " +
                        "no preamble). Use the carrier vetting heuristics from " +
                        "agents/quotation-agent/double_broker.py.'"
                      }
                      rows={10}
                    />
                    <span className="settings-hint">
                      Injected ahead of the auto-profile on every turn in
                      chats that belong to this project. Plain text or
                      markdown.
                    </span>
                  </div>
                  <div className="project-mgr-detail-footer">
                    <button
                      className="settings-memory-danger-link"
                      onClick={() => onDelete(editing.id)}
                    >
                      Delete project
                    </button>
                    <div style={{ flex: 1 }} />
                    <button className="settings-secondary" onClick={onClose}>
                      Cancel
                    </button>
                    <button className="settings-primary" onClick={commit}>
                      Save
                    </button>
                  </div>
                </>
              ) : (
                <div className="settings-memory-empty">
                  Pick a project to edit, or create one with the field on the
                  left.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
