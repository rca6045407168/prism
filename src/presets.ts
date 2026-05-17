/**
 * v0.1.51 — Profile presets (hermes-workspace pattern).
 *
 * One click swaps a bundle of settings (model + density + permission
 * mode + redaction) for a specific work mode. Reduces friction of
 * "pick the right model" + "pick the right safety level" per task.
 *
 * Adding a preset: append to PRESETS. The UI maps over it.
 *
 * Out of scope for v0.1.51: per-preset system prompts, per-preset
 * MCP allowlists, custom presets. We ship the 5 obvious ones and
 * keep the door open for user-defined presets in a future release.
 */
import type { Settings, Density } from "./Settings";

export type ProfilePreset = {
  id: string;
  label: string;
  emoji: string;
  description: string;
  patch: Partial<Settings> & { density?: Density };
};

export const PRESETS: ProfilePreset[] = [
  {
    id: "default",
    label: "Default",
    emoji: "✨",
    description:
      "Auto model routing, Ask-first permissions, normal verbosity. Safe everyday baseline.",
    patch: {
      model: "auto",
      density: "normal",
      permissionMode: "ask",
      redactBeforeVaultSave: false,
    },
  },
  {
    id: "deep-work",
    label: "Deep work",
    emoji: "🧠",
    description:
      "Opus + verbose tool strip + Ask-first. For the hard reasoning / architecture turns.",
    patch: {
      model: "opus",
      density: "verbose",
      permissionMode: "ask",
    },
  },
  {
    id: "quick-glance",
    label: "Quick glance",
    emoji: "⚡",
    description:
      "Haiku + summary density. Trivia, formatting, one-line answers. Cheapest tier.",
    patch: {
      model: "haiku",
      density: "summary",
      permissionMode: "ask",
    },
  },
  {
    id: "ship-it",
    label: "Ship it",
    emoji: "🚀",
    description:
      "Sonnet + Preview-mode snapshot + normal density. Move fast, snapshot first, roll back if wrong.",
    patch: {
      model: "sonnet",
      density: "normal",
      permissionMode: "preview",
    },
  },
  {
    id: "broadcast",
    label: "Public / broadcast",
    emoji: "📣",
    description:
      "Sonnet + vault-save redaction ON + Ask-first. For drafts that may sync to a cloud-backed vault.",
    patch: {
      model: "sonnet",
      density: "normal",
      permissionMode: "ask",
      redactBeforeVaultSave: true,
    },
  },
];

export function applyPreset(current: Settings, preset: ProfilePreset): Settings {
  return { ...current, ...preset.patch };
}

/** Best-effort: is this Settings object aligned with a known preset?
 *  Used to highlight the active preset in the UI. */
export function activePresetId(s: Settings): string | null {
  for (const p of PRESETS) {
    let match = true;
    for (const [k, v] of Object.entries(p.patch)) {
      // @ts-expect-error dynamic key
      if (s[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) return p.id;
  }
  return null;
}
