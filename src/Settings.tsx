/**
 * Settings modal — model preference, theme override, gateway URL.
 * State persists to localStorage (settings.v1 key).
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

// Models exposed in the picker. Each maps to a backend tier or alias.
// "auto" lets the auto-model-select skill route per prompt.
export const MODEL_OPTIONS: Array<{ id: string; label: string; tier: string; vendor: string }> = [
  { id: "auto",       label: "Auto (smart routing)",      tier: "auto",       vendor: "—" },
  { id: "haiku",      label: "Claude Haiku 4.5 — fast",   tier: "cheap",      vendor: "Anthropic" },
  { id: "sonnet",     label: "Claude Sonnet 4.6 — default", tier: "standard", vendor: "Anthropic" },
  { id: "opus",       label: "Claude Opus 4.7 — reasoning", tier: "reasoning", vendor: "Anthropic" },
  { id: "nemotron-nano",  label: "Nemotron Nano — cheap OSS", tier: "cheap",   vendor: "NVIDIA NIM" },
  { id: "nemotron-super", label: "Nemotron Super 120B",       tier: "reasoning", vendor: "NVIDIA NIM" },
  { id: "ollama",     label: "Local (Ollama)",            tier: "varies",     vendor: "Local" },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onChange: (s: Settings) => void;
  current: Settings;
};

export function SettingsModal({ open, onClose, onChange, current }: Props) {
  const [draft, setDraft] = useState<Settings>(current);

  useEffect(() => {
    setDraft(current);
  }, [current]);

  if (!open) return null;

  const save = () => {
    saveSettings(draft);
    onChange(draft);
    onClose();
  };

  const reset = () => {
    setDraft(DEFAULTS);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

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

          {/* Gateway URL removed in v0.1.10 — chat now spawns claude CLI
              directly (not the WS gateway). The setting was dead. */}

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

        <div className="settings-footer">
          <button className="settings-secondary" onClick={reset}>Reset</button>
          <div style={{ flex: 1 }} />
          <button className="settings-secondary" onClick={onClose}>Cancel</button>
          <button className="settings-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
