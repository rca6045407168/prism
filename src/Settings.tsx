/**
 * Settings modal — model preference, theme override, auto-memory.
 * Settings persist to localStorage. Profile data is stored on disk by
 * the main process; this component just reads / mutates it via IPC.
 */
import { useEffect, useState } from "react";

export type Settings = {
  model: string;        // "auto" | "haiku" | "sonnet" | "opus" | <openclaw alias>
  theme: "system" | "light" | "dark";
  gatewayUrl: string;   // override default ws://127.0.0.1:18789 if needed
  showCost: boolean;
};

const DEFAULTS: Settings = {
  model: "auto",
  theme: "system",
  gatewayUrl: "ws://127.0.0.1:18789",
  showCost: false,
};

const STORAGE_KEY = "prism.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage may be full; ignore
  }
}

export const MODEL_OPTIONS: Array<{ id: string; label: string; tier: string; vendor: string }> = [
  { id: "auto",       label: "Auto (smart routing)",      tier: "auto",       vendor: "—" },
  { id: "haiku",      label: "Claude Haiku 4.5 — fast",   tier: "cheap",      vendor: "Anthropic" },
  { id: "sonnet",     label: "Claude Sonnet 4.6 — default", tier: "standard", vendor: "Anthropic" },
  { id: "opus",       label: "Claude Opus 4.7 — reasoning", tier: "reasoning", vendor: "Anthropic" },
  { id: "nemotron-nano",  label: "Nemotron Nano — cheap OSS", tier: "cheap",   vendor: "NVIDIA NIM" },
  { id: "nemotron-super", label: "Nemotron Super 120B",       tier: "reasoning", vendor: "NVIDIA NIM" },
  { id: "ollama",     label: "Local (Ollama)",            tier: "varies",     vendor: "Local" },
];

const DIMENSION_LABELS: Record<ProfileDimension, string> = {
  communication_style: "Communication",
  role_context: "Role",
  tooling: "Tooling",
  naming: "Vocabulary",
  decision_style: "Decision style",
  project_focus: "Current focus",
  anti_patterns: "Avoid",
  knowledge: "Domain knowledge",
};

const DIMENSION_ORDER: ProfileDimension[] = [
  "anti_patterns",
  "communication_style",
  "role_context",
  "decision_style",
  "tooling",
  "project_focus",
  "naming",
  "knowledge",
];

type Props = {
  open: boolean;
  onClose: () => void;
  onChange: (s: Settings) => void;
  current: Settings;
};

export function SettingsModal({ open, onClose, onChange, current }: Props) {
  const [draft, setDraft] = useState<Settings>(current);
  const [tab, setTab] = useState<"general" | "memory">("general");
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    setDraft(current);
  }, [current]);

  // Load profile lazily when the Memory tab opens (or modal opens).
  useEffect(() => {
    if (!open) return;
    window.flexhaul.profile.get().then(setProfile).catch(() => {});
  }, [open, tab]);

  if (!open) return null;

  const save = () => {
    saveSettings(draft);
    onChange(draft);
    onClose();
  };

  const reset = () => {
    setDraft(DEFAULTS);
  };

  const onTogglePaused = async () => {
    if (!profile) return;
    const next = await window.flexhaul.profile.setPaused(!profile.learning_paused);
    setProfile(next);
  };

  const onForget = async (id: string) => {
    const next = await window.flexhaul.profile.removeEntry(id);
    setProfile(next);
  };

  const onClearAll = async () => {
    const next = await window.flexhaul.profile.clearAll();
    setProfile(next);
    setConfirmingClear(false);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === "general" ? "active" : ""}`}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            className={`settings-tab ${tab === "memory" ? "active" : ""}`}
            onClick={() => setTab("memory")}
          >
            Memory
            {profile && profile.entries.length > 0 ? (
              <span className="settings-tab-count">{profile.entries.length}</span>
            ) : null}
          </button>
        </div>

        {tab === "general" ? (
          <div className="settings-body">
            <div className="settings-row">
              <label>Default model</label>
              <select
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="settings-hint">
                "Auto" routes per prompt: trivia → cheap, hard reasoning → opus.
              </span>
            </div>

            <div className="settings-row">
              <label>Appearance</label>
              <select
                value={draft.theme}
                onChange={(e) => setDraft({ ...draft, theme: e.target.value as any })}
              >
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>

            <div className="settings-row settings-row-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={draft.showCost}
                  onChange={(e) => setDraft({ ...draft, showCost: e.target.checked })}
                />
                Show estimated cost per turn
              </label>
            </div>

            <div className="settings-row">
              <label>Tools &amp; integrations</label>
              <span className="settings-hint">
                Prism inherits all MCP servers configured in your Claude CLI
                setup (Gmail, Drive, Calendar, Sentry, etc.). To add or remove
                servers, run <code>claude mcp</code> in your terminal — changes
                apply on the next chat turn.
              </span>
            </div>
          </div>
        ) : (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                Prism quietly learns stable preferences and facts about you as
                you chat — communication style, tooling you use, things you've
                asked it not to do — and uses them to bias future responses.
              </p>
              <p className="settings-hint">
                Stored locally on this device. Never uploaded. Sent to Claude
                only as part of your own prompts.
              </p>
            </div>

            {profile ? (
              <>
                <div className="settings-memory-stats">
                  <span>
                    <strong>{profile.entries.length}</strong> things learned
                  </span>
                  <span className="settings-memory-divider">·</span>
                  <span>
                    across <strong>{profile.turns_seen}</strong> turns
                  </span>
                </div>

                <div className="settings-row settings-row-toggle">
                  <label>
                    <input
                      type="checkbox"
                      checked={profile.learning_paused}
                      onChange={onTogglePaused}
                    />
                    Pause learning
                  </label>
                  <span className="settings-hint">
                    Existing entries stay, but new turns won't add to the
                    profile.
                  </span>
                </div>

                {profile.entries.length === 0 ? (
                  <div className="settings-memory-empty">
                    Nothing learned yet. Have a few chats and check back —
                    Prism will pick up your style automatically.
                  </div>
                ) : (
                  <div className="settings-memory-list">
                    {DIMENSION_ORDER.map((dim) => {
                      const items = profile.entries
                        .filter((e) => e.dimension === dim)
                        .sort((a, b) => b.confidence - a.confidence);
                      if (items.length === 0) return null;
                      return (
                        <div key={dim} className="settings-memory-group">
                          <div className="settings-memory-group-title">
                            {DIMENSION_LABELS[dim]}
                          </div>
                          {items.map((e) => (
                            <div key={e.id} className="settings-memory-item">
                              <div className="settings-memory-claim">
                                {e.claim}
                              </div>
                              {e.evidence ? (
                                <div className="settings-memory-evidence">
                                  "{e.evidence}"
                                </div>
                              ) : null}
                              <button
                                className="settings-memory-forget"
                                onClick={() => onForget(e.id)}
                                title="Forget this"
                              >
                                Forget
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}

                {profile.entries.length > 0 ? (
                  <div className="settings-memory-clear">
                    {confirmingClear ? (
                      <>
                        <span>Forget everything Prism has learned?</span>
                        <button
                          className="settings-memory-danger"
                          onClick={onClearAll}
                        >
                          Yes, wipe profile
                        </button>
                        <button
                          className="settings-secondary"
                          onClick={() => setConfirmingClear(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="settings-memory-danger-link"
                        onClick={() => setConfirmingClear(true)}
                      >
                        Forget everything…
                      </button>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="settings-memory-empty">Loading…</div>
            )}
          </div>
        )}

        <div className="settings-footer">
          {tab === "general" ? (
            <>
              <button className="settings-secondary" onClick={reset}>
                Reset
              </button>
              <div style={{ flex: 1 }} />
              <button className="settings-secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="settings-primary" onClick={save}>
                Save
              </button>
            </>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <button className="settings-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
