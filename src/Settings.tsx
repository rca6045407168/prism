/**
 * Settings modal — model preference, theme override, auto-memory.
 * Settings persist to localStorage. Profile data is stored on disk by
 * the main process; this component just reads / mutates it via IPC.
 */
import React, { useEffect, useMemo, useState } from "react";
import { SKILLS, CATEGORY_LABELS, type SkillCategory } from "./skill-registry";
import { PRESETS, applyPreset, activePresetId } from "./presets";
import { copyToClipboard } from "./clipboard";

export type Density = "verbose" | "normal" | "summary";

export type Settings = {
  model: string;        // "auto" | "haiku" | "sonnet" | "opus" | <openclaw alias>
  theme: "system" | "light" | "dark";
  gatewayUrl: string;   // override default ws://127.0.0.1:18789 if needed
  showCost: boolean;
  /** Tool-call + metadata visibility on assistant messages. v0.1.32.
   *  - verbose: tool strip expanded by default, full details
   *  - normal:  tool strip collapsed (default since v0.1.18)
   *  - summary: tool strip hidden entirely, just the final text */
  density: Density;
  /** Permission mode for the wrapped claude CLI (v0.1.41).
   *  - "ask": pass `--permission-mode plan` — claude reads + proposes,
   *           but never executes file-mutating tools without explicit
   *           per-turn approval. Safe default.
   *  - "preview": v0.1.44 — take an APFS local snapshot of / BEFORE the
   *              turn fires, then run claude with bypassPermissions.
   *              Post-turn, surface the snapshot ID + "review changes"
   *              notice so the user can roll back if anything was wrong.
   *              Sweet spot between Ask (no execution) and Bypass (no
   *              safety net). Pivoted from sandbox-VM design — see vault
   *              note 2026-05-16 — Prism v0.1.44 Sandbox-Backed Bypass.
   *  - "bypass": pass `--permission-mode bypassPermissions` +
   *              `--allow-dangerously-skip-permissions` — claude can
   *              run anything, no snapshot. Power-user / "I trust this
   *              turn" mode.
   *  Per MST-060, "ask" is the right default. Old behavior was bypass-
   *  on-every-turn which silently let claude rm -rf anywhere. */
  permissionMode: "ask" | "preview" | "bypass" | "watch";
  /** v0.1.46: scrub API keys + PII before vault saves. Default false —
   *  most users keep their vault local. Opt-in for users who sync vault
   *  to a cloud store (iCloud, Drive, Notion). Stolen from OpenClaw's
   *  pii-redaction.json5 (12 secret regexes + email/phone/SSN). */
  redactBeforeVaultSave: boolean;
  /** v0.1.48: per-server MCP allowlist — when populated, only these
   *  server names are surfaced as "active" in the MCP panel + only
   *  these tools count toward the titlebar MCP chip. Empty means
   *  "allow all" (backwards compat). Lifted from OpenClaw's
   *  hardening.json5 default-deny posture. */
  mcpAllowlist: string[];
  /** v0.1.48: directory scope for Preview-mode APFS snapshots + diff.
   *  Default $HOME. Restrict to e.g. ~/code or ~/FlexHaul to tighten
   *  blast radius + speed up diff. The snapshot itself is still of /,
   *  but the changed-files listing + revert is constrained. */
  previewScope: string;
};

const DEFAULTS: Settings = {
  model: "auto",
  theme: "system",
  gatewayUrl: "ws://127.0.0.1:18789",
  showCost: false,
  density: "normal",
  permissionMode: "ask", // v0.1.41: safety-first default. See MST-060.
  redactBeforeVaultSave: false, // v0.1.46: opt-in for cloud-synced vaults.
  mcpAllowlist: [], // v0.1.48: empty = allow all; populate for default-deny.
  previewScope: "", // v0.1.48: empty = $HOME default; user can scope tighter.
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

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

/**
 * v0.1.39: MCP-server template gallery. Each template is a copy-pasteable
 * snippet for `~/.claude.json` under `mcpServers`. Pattern lifted from
 * Agent TARS's "drop in any MCP" surface — we surface integration via
 * config, never bundle their runtimes.
 *
 * To add a template: append to this array. The UI renders via map.
 */
type McpTemplate = {
  id: string;
  title: string;
  url: string;
  urlLabel: string;
  description: React.ReactNode;
  snippet: string;
  note?: React.ReactNode;
};

const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "insforge",
    title: "InsForge",
    url: "https://insforge.dev",
    urlLabel: "insforge.dev",
    description: (
      <>
        Open-source backend-for-agents (Postgres + auth + storage + edge
        functions + model gateway). Run locally via Docker.
      </>
    ),
    snippet: `{
  "mcpServers": {
    "insforge": {
      "command": "npx",
      "args": ["-y", "@insforge/mcp-server"],
      "env": {
        "INSFORGE_API_URL": "http://localhost:7130",
        "INSFORGE_API_KEY": "<your-key>"
      }
    }
  }
}`,
    note: (
      <>
        Once connected, exposes <code>fetch-docs</code>,{" "}
        <code>deploy-edge-function</code>, <code>run-migration</code>, and
        the rest of the InsForge primitive surface to Claude as tools.
      </>
    ),
  },
  {
    id: "ui-tars",
    title: "UI-TARS Desktop",
    url: "https://github.com/bytedance/UI-TARS-desktop",
    urlLabel: "github.com/bytedance/UI-TARS-desktop",
    description: (
      <>
        ByteDance's vision-language-action GUI agent. Lets Claude take
        screenshots and control the mouse/keyboard via a purpose-trained
        VLM. Adds <em>actually drive my computer</em> to Prism without
        Prism owning the model.
      </>
    ),
    snippet: `{
  "mcpServers": {
    "ui-tars": {
      "command": "npx",
      "args": ["-y", "@ui-tars/mcp-server"],
      "env": {
        "UI_TARS_MODEL_ENDPOINT": "<your-endpoint>",
        "UI_TARS_API_KEY": "<your-key>"
      }
    }
  }
}`,
    note: (
      <>
        Requires UI-TARS-desktop installed locally + a model endpoint
        (their cloud or self-hosted). Pairs well with Prism for the
        chat-then-act loop: ask in Prism, UI-TARS executes.
      </>
    ),
  },
  {
    id: "cua",
    title: "Cua (background computer-use)",
    url: "https://github.com/trycua/cua",
    urlLabel: "github.com/trycua/cua",
    description: (
      <>
        <strong>Cua Driver</strong> — drives native macOS apps{" "}
        <em>in the background</em>, without stealing cursor / focus / Space.
        Works on Chromium content + canvas surfaces (Figma, Blender, DAWs)
        where AX trees don't exist. Every session records as a replayable
        trajectory.
      </>
    ),
    snippet: `{
  "mcpServers": {
    "cua": {
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}`,
    note: (
      <>
        Install first:{" "}
        <code>
          /bin/bash -c "$(curl -fsSL
          https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
        </code>
        . Pairs especially well with Prism's Ask → Approve flow — agent
        executes Bypass turns in the background while you keep working.
      </>
    ),
  },
  {
    id: "computer-use",
    title: "Anthropic Computer-Use",
    url: "https://docs.anthropic.com/en/docs/agents-and-tools/computer-use",
    urlLabel: "docs.anthropic.com",
    description: (
      <>
        Anthropic's official computer-use tool — screen reading + clicks +
        typing — wrapped as an MCP server. Built on the model Claude
        ships, no separate VLM. Best for tasks where you want Claude
        itself reasoning about the screen, not a specialized GUI model.
      </>
    ),
    snippet: `{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-computer-use"]
    }
  }
}`,
    note: (
      <>
        Sandboxed by default — won't act without explicit permission per
        action. Claude desktop ships a similar integration; this brings
        the same capability to Prism via MCP.
      </>
    ),
  },
  {
    id: "github",
    title: "GitHub",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    urlLabel: "modelcontextprotocol/servers",
    description: (
      <>
        Official GitHub MCP server. Read issues + PRs, search code across
        your repos, create issues, comment, manage branches.
      </>
    ),
    snippet: `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-pat>"
      }
    }
  }
}`,
    note: (
      <>
        Generate a PAT at{" "}
        <code>github.com/settings/tokens</code> with{" "}
        <code>repo</code> scope (and <code>read:org</code> if you need
        org-scoped repos).
      </>
    ),
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onChange: (s: Settings) => void;
  current: Settings;
  /** v0.1.37: optional initial tab to open on. Lets the titlebar MCP
   *  chip jump straight into MCP settings. */
  initialTab?: "general" | "memory" | "speed" | "skills" | "schedule" | "mcp" | "account";
};

export function SettingsModal({ open, onClose, onChange, current, initialTab }: Props) {
  const [draft, setDraft] = useState<Settings>(current);
  const [tab, setTab] = useState<"general" | "memory" | "speed" | "skills" | "schedule" | "mcp" | "account">(
    initialTab ?? "general",
  );
  // v0.1.51: scheduled jobs (LaunchAgents).
  type ScheduleResult = Awaited<ReturnType<typeof window.flexhaul.scheduled.list>>;
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  // v0.1.49: Skill registry browser — search + category filter state.
  const [skillQuery, setSkillQuery] = useState("");
  const [skillCategory, setSkillCategory] = useState<SkillCategory | "all">("all");
  const [copiedSkillSlug, setCopiedSkillSlug] = useState<string | null>(null);
  // When the host requests a specific tab (e.g. clicking the MCP chip),
  // honor it on each modal open.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [rtkStatus, setRtkStatus] = useState<RtkStatus | null>(null);
  const [enablingHook, setEnablingHook] = useState(false);
  const [hookFlash, setHookFlash] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // v0.1.37: MCP server inspection
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [copiedTemplateId, setCopiedTemplateId] = useState<string | null>(null);
  // v0.1.50: Ollama detection — surfaced in General tab.
  type OllamaStatus = Awaited<ReturnType<typeof window.flexhaul.providers.detectOllama>>;
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  // v0.1.61: vault path picker
  type VaultRootInfo = Awaited<ReturnType<typeof window.flexhaul.vault.getRoot>>;
  const [vaultInfo, setVaultInfo] = useState<VaultRootInfo | null>(null);
  const [vaultPickError, setVaultPickError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(current);
  }, [current]);

  // Load profile lazily when the Memory tab opens (or modal opens).
  useEffect(() => {
    if (!open) return;
    window.flexhaul.profile.get().then(setProfile).catch(() => {});
  }, [open, tab]);

  // Refresh RTK status when modal opens or Speed tab is selected.
  useEffect(() => {
    if (!open) return;
    if (tab !== "speed") return;
    window.flexhaul.rtk.status().then(setRtkStatus).catch(() => {});
  }, [open, tab]);

  // Load account state on first open + refresh when Account tab is selected.
  useEffect(() => {
    if (!open) return;
    window.flexhaul.account.status().then(setAccountStatus).catch(() => {});
  }, [open, tab]);

  // v0.1.50: probe Ollama once per General-tab visit. Cheap local HTTP
  // call so we can show "Ollama detected — N models available".
  useEffect(() => {
    if (!open) return;
    if (tab !== "general") return;
    window.flexhaul.providers.detectOllama().then(setOllamaStatus).catch(() => {});
  }, [open, tab]);

  // v0.1.61: load current vault root whenever General tab opens.
  useEffect(() => {
    if (!open) return;
    if (tab !== "general") return;
    window.flexhaul.vault.getRoot().then(setVaultInfo).catch(() => {});
  }, [open, tab]);

  // v0.1.63: Escape closes the Settings modal. Was missing — discovered
  // during the v0.1.62 live-test session when the X-button click didn't
  // reliably land under computer-use control.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pickVaultFolder = async () => {
    setVaultPickError(null);
    try {
      const res = await window.flexhaul.vault.pickFolder();
      if ("ok" in res && res.ok) {
        setVaultInfo({
          path: res.path,
          exists: res.exists,
          hasObsidianFolder: res.hasObsidianFolder,
          noteCount: res.noteCount,
        });
      } else if ("ok" in res && !res.ok && !res.canceled) {
        setVaultPickError(res.error ?? "Could not set vault path");
      }
    } catch (e: any) {
      setVaultPickError(e?.message ?? String(e));
    }
  };

  // v0.1.51: scan ~/Library/LaunchAgents/ for prism-scoped scheduled jobs.
  useEffect(() => {
    if (!open) return;
    if (tab !== "schedule") return;
    window.flexhaul.scheduled.list().then(setSchedule).catch(() => {});
  }, [open, tab]);

  // v0.1.37: MCP status — pull cached state when MCP tab opens + subscribe
  // to live updates that fire on every chat:start.
  useEffect(() => {
    if (!open) return;
    window.flexhaul.mcp.status().then(setMcpStatus).catch(() => {});
    const off = window.flexhaul.mcp.onStatus((s) => setMcpStatus(s));
    return off;
  }, [open]);

  const onSignIn = async (provider: "google") => {
    setSigningIn(true);
    setSignInError(null);
    try {
      const res = await window.flexhaul.account.signIn(provider);
      if (res.ok) {
        const next = await window.flexhaul.account.status();
        setAccountStatus(next);
      } else {
        setSignInError(res.error);
      }
    } finally {
      setSigningIn(false);
    }
  };

  const onSignOut = async () => {
    await window.flexhaul.account.signOut();
    const next = await window.flexhaul.account.status();
    setAccountStatus(next);
    setSignInError(null);
  };

  const onEnableHook = async () => {
    setEnablingHook(true);
    setHookFlash(null);
    try {
      const res = await window.flexhaul.rtk.enableHook();
      if (res.ok) {
        setHookFlash(
          res.alreadyPresent
            ? "Already enabled."
            : res.backupPath
            ? `Enabled. Settings backed up to ${res.backupPath}.`
            : "Enabled.",
        );
        const next = await window.flexhaul.rtk.status();
        setRtkStatus(next);
      } else {
        setHookFlash(res.error ?? "Failed to enable hook.");
      }
    } finally {
      setEnablingHook(false);
    }
  };

  // v0.1.49: filter the curated skill list against search query + category.
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return SKILLS.filter((s) => {
      if (skillCategory !== "all" && s.category !== skillCategory) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)) ||
        s.slug.toLowerCase().includes(q)
      );
    });
  }, [skillQuery, skillCategory]);

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
          <button
            className={`settings-tab ${tab === "speed" ? "active" : ""}`}
            onClick={() => setTab("speed")}
          >
            Speed
            {rtkStatus?.stats && rtkStatus.stats.totalSavedTokens > 0 ? (
              <span className="settings-tab-count">
                {formatTokens(rtkStatus.stats.totalSavedTokens)}
              </span>
            ) : null}
          </button>
          <button
            className={`settings-tab ${tab === "skills" ? "active" : ""}`}
            onClick={() => setTab("skills")}
          >
            Skills
            <span className="settings-tab-count">{SKILLS.length}</span>
          </button>
          <button
            className={`settings-tab ${tab === "schedule" ? "active" : ""}`}
            onClick={() => setTab("schedule")}
          >
            Schedule
            {schedule && schedule.jobs.length > 0 ? (
              <span className="settings-tab-count">{schedule.jobs.length}</span>
            ) : null}
          </button>
          <button
            className={`settings-tab ${tab === "mcp" ? "active" : ""}`}
            onClick={() => setTab("mcp")}
          >
            MCP
            {mcpStatus && mcpStatus.servers.length > 0 ? (
              <span className="settings-tab-count">
                {mcpStatus.servers.filter((s) => s.status === "connected").length}
              </span>
            ) : null}
          </button>
          <button
            className={`settings-tab ${tab === "account" ? "active" : ""}`}
            onClick={() => setTab("account")}
          >
            Account
            {accountStatus?.account ? (
              <span className="settings-tab-dot" aria-label="signed in" />
            ) : null}
          </button>
        </div>

        {tab === "general" ? (
          <div className="settings-body">
            <div className="settings-row">
              <label>Profile presets (v0.1.51)</label>
              <div className="preset-row">
                {PRESETS.map((p) => {
                  const isActive = activePresetId(draft) === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`preset-chip ${isActive ? "active" : ""}`}
                      onClick={() => setDraft(applyPreset(draft, p))}
                      title={p.description}
                    >
                      <span className="preset-chip-emoji">{p.emoji}</span>
                      <span className="preset-chip-label">{p.label}</span>
                    </button>
                  );
                })}
              </div>
              <span className="settings-hint">
                One-click bundles for switching between work modes — Deep
                work (Opus + verbose), Quick glance (Haiku + summary),
                Ship it (Sonnet + Preview snapshot), Public / broadcast
                (Sonnet + redact-before-vault-save). Click a chip to
                apply; the rows below update to match. Save to persist.
                Pattern lifted from hermes-workspace.
              </span>
            </div>

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
              <label>Agent permissions</label>
              <select
                value={draft.permissionMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    permissionMode: e.target.value as
                      | "ask"
                      | "preview"
                      | "bypass"
                      | "watch",
                  })
                }
              >
                <option value="ask">
                  Ask first — propose, don't act (safest)
                </option>
                <option value="preview">
                  Preview — snapshot first, then act (recoverable)
                </option>
                <option value="watch">
                  Watch — bypass-fast, pause on risky messages (v0.1.53)
                </option>
                <option value="bypass">
                  Bypass — full trust, no snapshot (fastest, riskiest)
                </option>
              </select>
              <span className="settings-hint">
                <strong>Ask</strong>: Claude reads files + proposes plans,
                but never modifies anything without explicit per-turn approval.
                <br />
                <strong>Preview</strong> (v0.1.44): before any turn that
                might modify files, take an APFS local snapshot. Run claude
                with full Bypass permissions. After the turn, you get the
                snapshot ID so you can review changes and roll back if
                needed. Best of both worlds — execution speed of Bypass +
                safety net of Ask.
                <br />
                <strong>Watch</strong> (v0.1.53 — calibrated escalation):
                runs every turn in Bypass for speed, BUT a 5ms regex
                preflight scans your message for destructive verbs (rm
                -rf, drop table, force-push), money mentions, named
                counterparties (Xinwen, Tyson, Saia, …), and production
                indicators. Risky messages pause and surface a banner —
                you click Proceed (one-shot Bypass) or Switch to Ask.
                Senior-employee analog: "just do most things, but stop
                and confirm before irreversible ones."
                <br />
                <strong>Bypass</strong>: Claude executes Bash / Edit / Write
                tools without prompting and without a snapshot. Every turn
                can <code>rm</code> / <code>mv</code> on your machine.
                <br />
                Toggle Ask ↔ Bypass with <code>⌘⇧P</code>. Pick Preview
                here in Settings. The titlebar shows the current mode at
                all times.
              </span>
            </div>

            <div className="settings-row">
              <label>Preview-mode scope dir</label>
              <input
                type="text"
                value={draft.previewScope}
                placeholder="(empty = $HOME default)"
                onChange={(e) =>
                  setDraft({ ...draft, previewScope: e.target.value })
                }
                style={{ fontFamily: "var(--mono)", fontSize: "12px" }}
              />
              <span className="settings-hint">
                <strong>v0.1.48</strong>: scope the changed-files diff for
                Preview mode (🧪) to a tighter dir than $HOME. E.g.{" "}
                <code>{`${draft.previewScope || "/Users/richardchen/code/prism"}`}</code>{" "}
                so a Bypass turn that modifies your code shows only those
                files, not noise from <code>~/Library/</code>. Snapshot
                itself still covers <code>/</code> (revert remains
                possible for anything claude touched), but the diff
                listing + revert UI is bounded to this directory.
              </span>
            </div>

            <div className="settings-row settings-row-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={draft.redactBeforeVaultSave}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      redactBeforeVaultSave: e.target.checked,
                    })
                  }
                />
                Redact secrets + PII before vault saves
              </label>
              <span className="settings-hint">
                <strong>v0.1.46</strong>: when ⌘⇧S writes a chat turn to
                your Obsidian vault, scrub API keys (sk-ant-*, nvapi-*,
                ghp_*, etc.), PEM private keys, emails, phone numbers,
                SSNs, and business-sensitive identifiers via regex
                first. Default off — most vaults are local. Turn this on
                if your vault syncs to cloud (iCloud, Drive, Notion).
                Logs ({" "}<code>~/Library/Logs/Prism/main.log</code>)
                are always redacted regardless of this setting.
              </span>
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

            <div className="settings-row">
              <label>Obsidian vault path (v0.1.61)</label>
              <div className="vault-picker-row">
                <code className="vault-picker-path">
                  {vaultInfo?.path ?? "(loading…)"}
                </code>
                <button
                  type="button"
                  className="vault-picker-btn"
                  onClick={pickVaultFolder}
                >
                  Pick folder…
                </button>
              </div>
              {vaultInfo ? (
                <div className="vault-picker-status">
                  {vaultInfo.exists ? (
                    <>
                      <span className="vault-picker-dot vault-picker-dot-on" />
                      <span>
                        {vaultInfo.noteCount} markdown note
                        {vaultInfo.noteCount === 1 ? "" : "s"} at root
                        {vaultInfo.hasObsidianFolder
                          ? " · .obsidian metadata present"
                          : " · no .obsidian/ — likely not a real Obsidian vault, but still works"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="vault-picker-dot vault-picker-dot-off" />
                      <span>Folder does not exist on disk.</span>
                    </>
                  )}
                </div>
              ) : null}
              {vaultPickError ? (
                <div className="vault-picker-error">{vaultPickError}</div>
              ) : null}
              <span className="settings-hint">
                Where Prism looks for your Obsidian notes — used for
                <code> [[wikilink]]</code> autocomplete, the ⌘⇧S save-turn
                command, vault saves, the Provenance Panel's vault hits
                (v0.1.52), and the Commitments writer (v0.1.54). Default is
                <code> ~/Documents/Obsidian Vault</code>. Pick a different
                folder for iCloud-synced vaults, team-shared vaults (e.g. a
                split FlexHaul vault), or to point Prism at a project-specific
                subdirectory.
              </span>
            </div>

            <div className="settings-row">
              <label>Local LLM (v0.1.50)</label>
              <div className="provider-row">
                <span className="provider-name">Ollama</span>
                {ollamaStatus === null ? (
                  <span className="provider-meta">checking…</span>
                ) : !ollamaStatus.installed ? (
                  <>
                    <span className="provider-dot provider-dot-off" />
                    <span className="provider-meta">not installed</span>
                    <a
                      className="provider-link"
                      href="https://ollama.com"
                      onClick={(e) => {
                        e.preventDefault();
                        window.open("https://ollama.com", "_blank");
                      }}
                    >
                      Install →
                    </a>
                  </>
                ) : !ollamaStatus.running ? (
                  <>
                    <span className="provider-dot provider-dot-warn" />
                    <span className="provider-meta">
                      installed{ollamaStatus.version ? ` v${ollamaStatus.version}` : ""},{" "}
                      daemon not running
                    </span>
                    <code className="provider-cmd">ollama serve</code>
                  </>
                ) : (
                  <>
                    <span className="provider-dot provider-dot-on" />
                    <span className="provider-meta">
                      running{ollamaStatus.version ? ` v${ollamaStatus.version}` : ""} —{" "}
                      <strong>
                        {ollamaStatus.models?.length ?? 0}
                      </strong>{" "}
                      {(ollamaStatus.models?.length ?? 0) === 1 ? "model" : "models"}
                    </span>
                  </>
                )}
              </div>
              <span className="settings-hint">
                Prism detects a local Ollama daemon at{" "}
                <code>127.0.0.1:11434</code>. Detection only in this release —
                a future build will let you route cheap turns (summaries,
                autocomplete) to Ollama instead of Claude. Models that are
                pulled but not yet wired:{" "}
                {ollamaStatus && ollamaStatus.installed && (ollamaStatus.models?.length ?? 0) > 0 ? (
                  <code>
                    {ollamaStatus.models!.slice(0, 6).map((m) => m.name).join(", ")}
                    {(ollamaStatus.models?.length ?? 0) > 6 ? ", …" : ""}
                  </code>
                ) : (
                  <em>none</em>
                )}
                .
              </span>
            </div>
          </div>
        ) : tab === "memory" ? (
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
        ) : null}

        {tab === "skills" ? (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                <strong>Skill registry (v0.1.49)</strong> — curated skills that
                extend Prism through your claude CLI. Each one installs into{" "}
                <code>~/.claude/skills/</code> or wires up an MCP server.
                Pattern lifted from{" "}
                <a
                  href="https://github.com/VoltAgent/awesome-openclaw-skills"
                  onClick={(e) => {
                    e.preventDefault();
                    window.open(
                      "https://github.com/VoltAgent/awesome-openclaw-skills",
                      "_blank",
                    );
                  }}
                >
                  awesome-openclaw-skills
                </a>{" "}
                (5,211 skills, 48k stars) — full registry is one click away.
                The selection below is the subset that meaningfully extends
                Prism for the contexts we actually run in.
              </p>
            </div>

            <div className="skill-toolbar">
              <input
                className="skill-search"
                type="text"
                value={skillQuery}
                onChange={(e) => setSkillQuery(e.target.value)}
                placeholder="Search skills, tags, descriptions…"
              />
              <div className="skill-category-row">
                <button
                  className={`skill-category-pill ${
                    skillCategory === "all" ? "active" : ""
                  }`}
                  onClick={() => setSkillCategory("all")}
                >
                  All <span className="skill-category-count">{SKILLS.length}</span>
                </button>
                {(Object.keys(CATEGORY_LABELS) as SkillCategory[]).map((cat) => {
                  const n = SKILLS.filter((s) => s.category === cat).length;
                  if (n === 0) return null;
                  return (
                    <button
                      key={cat}
                      className={`skill-category-pill ${
                        skillCategory === cat ? "active" : ""
                      }`}
                      onClick={() => setSkillCategory(cat)}
                    >
                      {CATEGORY_LABELS[cat]}{" "}
                      <span className="skill-category-count">{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {filteredSkills.length === 0 ? (
              <div className="settings-memory-empty">
                No skills match "{skillQuery}".
              </div>
            ) : (
              <div className="skill-card-grid">
                {filteredSkills.map((s) => (
                  <div className="skill-card" key={s.slug}>
                    <div className="skill-card-head">
                      <strong>{s.name}</strong>
                      <span className="skill-card-category">
                        {CATEGORY_LABELS[s.category]}
                      </span>
                    </div>
                    <p className="skill-card-desc">{s.description}</p>
                    <div className="skill-card-tags">
                      {s.tags.map((t) => (
                        <span className="skill-card-tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="skill-card-foot">
                      <code className="skill-card-cmd">{s.installCmd}</code>
                      <button
                        className="skill-card-copy"
                        onClick={async () => {
                          if (await copyToClipboard(s.installCmd)) {
                            setCopiedSkillSlug(s.slug);
                            setTimeout(() => setCopiedSkillSlug(null), 2000);
                          }
                        }}
                      >
                        {copiedSkillSlug === s.slug ? "Copied ✓" : "Copy"}
                      </button>
                      <a
                        className="skill-card-source"
                        href={s.source}
                        onClick={(e) => {
                          e.preventDefault();
                          window.open(s.source, "_blank");
                        }}
                      >
                        Source →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="settings-hint" style={{ marginTop: 12 }}>
              Looking for something specific? The full 5,211-skill registry is
              at{" "}
              <a
                href="https://github.com/VoltAgent/awesome-openclaw-skills"
                onClick={(e) => {
                  e.preventDefault();
                  window.open(
                    "https://github.com/VoltAgent/awesome-openclaw-skills",
                    "_blank",
                  );
                }}
              >
                VoltAgent/awesome-openclaw-skills
              </a>
              . Future Prism release will surface live search across that
              repo.
            </p>
          </div>
        ) : null}

        {tab === "schedule" ? (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                <strong>Scheduled jobs (v0.1.51)</strong> — read-only view
                of LaunchAgents under <code>~/Library/LaunchAgents/</code>{" "}
                with labels starting <code>com.prism.</code>,{" "}
                <code>com.claude.</code>, <code>com.openclaw.</code>, or{" "}
                <code>com.anthropic.</code>. Surface only — to create a
                job, write a plist directly and{" "}
                <code>launchctl bootstrap gui/$(id -u)</code> it. Full
                in-app writer ships in a later release.
              </p>
            </div>

            {schedule === null ? (
              <div className="settings-memory-empty">Scanning…</div>
            ) : schedule.jobs.length === 0 ? (
              <div className="settings-memory-empty">
                No prism / claude / openclaw / anthropic LaunchAgents found
                in <code>{schedule.dir}</code>.
                <pre className="schedule-empty-snippet">{`# Example: run a Claude prompt every weekday at 9:00am.
# Save as ~/Library/LaunchAgents/com.prism.morning-brief.plist
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.prism.morning-brief</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>claude -p "Write today's brief" > ~/Desktop/brief.txt</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
# Then: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.prism.morning-brief.plist`}</pre>
              </div>
            ) : (
              <div className="schedule-list">
                {schedule.jobs.map((j) => (
                  <div className="schedule-card" key={j.label}>
                    <div className="schedule-card-head">
                      <strong>{j.label}</strong>
                      <span
                        className={`schedule-card-status ${
                          j.enabled ? "ok" : "off"
                        }`}
                      >
                        {j.enabled ? j.scheduleSummary : "disabled"}
                      </span>
                    </div>
                    {j.programArguments && j.programArguments.length > 0 ? (
                      <pre className="schedule-card-cmd">
                        <code>{j.programArguments.join(" ")}</code>
                      </pre>
                    ) : j.program ? (
                      <pre className="schedule-card-cmd">
                        <code>{j.program}</code>
                      </pre>
                    ) : null}
                    <div className="schedule-card-path">{j.plistPath}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === "speed" ? (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                Prism speeds up Claude by piping verbose tool output (git,
                find, grep, gcloud, …) through{" "}
                <a
                  href="https://github.com/rtk-ai/rtk"
                  onClick={(e) => {
                    e.preventDefault();
                    window.open("https://github.com/rtk-ai/rtk", "_blank");
                  }}
                >
                  RTK
                </a>
                {" "}— an open-source CLI proxy that compresses output before it
                reaches the model. 60–90% fewer tokens on dev work; the model
                gets a cleaner signal too.
              </p>
              <p className="settings-hint">
                Runs locally. No data leaves your machine. Wired through the
                same Claude settings hook your terminal uses.
              </p>
            </div>

            {rtkStatus === null ? (
              <div className="settings-memory-empty">Checking…</div>
            ) : !rtkStatus.installed ? (
              <div className="settings-rtk-step">
                <div className="settings-rtk-step-title">
                  Step 1 — Install RTK
                </div>
                <div className="settings-rtk-step-body">
                  {rtkStatus.hint ?? "RTK isn't on your machine yet."}
                </div>
                <button
                  className="settings-secondary"
                  onClick={() =>
                    window.open("https://github.com/rtk-ai/rtk", "_blank")
                  }
                >
                  View install instructions
                </button>
              </div>
            ) : (
              <>
                <div className="settings-rtk-status">
                  <div className="settings-rtk-status-row">
                    <span className="settings-rtk-status-icon ok">✓</span>
                    <span className="settings-rtk-status-label">RTK installed</span>
                    {rtkStatus.version ? (
                      <span className="settings-rtk-status-meta">
                        {rtkStatus.version}
                      </span>
                    ) : null}
                  </div>
                  <div className="settings-rtk-status-row">
                    <span
                      className={`settings-rtk-status-icon ${
                        rtkStatus.hookEnabled ? "ok" : "warn"
                      }`}
                    >
                      {rtkStatus.hookEnabled ? "✓" : "!"}
                    </span>
                    <span className="settings-rtk-status-label">
                      {rtkStatus.hookEnabled
                        ? "Claude hook enabled — Prism is using RTK"
                        : "Claude hook not enabled — Prism is bypassing RTK"}
                    </span>
                    {!rtkStatus.hookEnabled ? (
                      <button
                        className="settings-rtk-enable"
                        onClick={onEnableHook}
                        disabled={enablingHook}
                      >
                        {enablingHook ? "Enabling…" : "Enable"}
                      </button>
                    ) : null}
                  </div>
                  {hookFlash ? (
                    <div className="settings-rtk-flash">{hookFlash}</div>
                  ) : null}
                </div>

                {rtkStatus.stats ? (
                  <div className="settings-rtk-stats">
                    <div className="settings-rtk-stats-grid">
                      <div className="settings-rtk-stat">
                        <div className="settings-rtk-stat-value">
                          {formatTokens(rtkStatus.stats.totalSavedTokens)}
                        </div>
                        <div className="settings-rtk-stat-label">tokens saved</div>
                      </div>
                      <div className="settings-rtk-stat">
                        <div className="settings-rtk-stat-value">
                          {rtkStatus.stats.avgSavingsPct.toFixed(0)}%
                        </div>
                        <div className="settings-rtk-stat-label">avg compression</div>
                      </div>
                      <div className="settings-rtk-stat">
                        <div className="settings-rtk-stat-value">
                          {rtkStatus.stats.totalCommands.toLocaleString()}
                        </div>
                        <div className="settings-rtk-stat-label">commands wrapped</div>
                      </div>
                    </div>
                    <div className="settings-hint" style={{ marginTop: 6 }}>
                      Stats from <code>rtk gain</code> — global across every
                      Claude session on this machine.
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {tab === "mcp" ? (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                <strong>MCP servers</strong> let your claude CLI talk to
                external services — databases, calendars, browsers, custom
                tools. Prism reads server status from the claude-init event
                on every turn, so this view refreshes as you chat.
              </p>
              {!mcpStatus ? (
                <p style={{ color: "var(--ink-mute)" }}>
                  No MCP data yet — send one chat turn to discover what's
                  connected.
                </p>
              ) : mcpStatus.servers.length === 0 ? (
                <p style={{ color: "var(--ink-mute)" }}>
                  No MCP servers configured. Edit{" "}
                  <code>~/.claude.json</code> or use the InsForge template
                  below to add one.
                </p>
              ) : null}
            </div>

            {mcpStatus && mcpStatus.servers.length > 0 ? (
              <div className="mcp-server-list">
                {mcpStatus.servers.map((s) => {
                  const allowlistActive = draft.mcpAllowlist.length > 0;
                  const allowed =
                    !allowlistActive || draft.mcpAllowlist.includes(s.name);
                  return (
                    <div
                      key={s.name}
                      className={`mcp-server-row mcp-server-${s.status}${
                        allowlistActive && !allowed
                          ? " mcp-server-not-allowed"
                          : ""
                      }`}
                    >
                      <span
                        className={`mcp-server-dot mcp-server-dot-${s.status}`}
                      />
                      <span className="mcp-server-name">{s.name}</span>
                      <span className="mcp-server-meta">
                        {allowlistActive && !allowed
                          ? "⚠ not in allowlist"
                          : s.status === "connected"
                            ? `${s.toolCount} ${s.toolCount === 1 ? "tool" : "tools"}`
                            : "failed"}
                      </span>
                    </div>
                  );
                })}
                <div className="mcp-server-summary">
                  Total: {mcpStatus.totalTools} tools available
                  {mcpStatus.mcpTools > 0
                    ? ` (${mcpStatus.mcpTools} from MCP)`
                    : ""}
                </div>
              </div>
            ) : null}

            <div className="mcp-template-section-head">
              <strong>Allowlist (v0.1.48)</strong>
              <span className="mcp-template-section-sub">
                Default-deny policy lifted from OpenClaw's{" "}
                <code>hardening.json5</code>. Leave empty to allow ALL MCP
                servers your claude CLI has configured. Populate to mark
                only specific servers as "trusted" — others appear with a
                yellow warning badge in the server list above. (Hard
                enforcement requires editing <code>~/.claude.json</code> —
                this is the visibility + soft-mark layer.)
              </span>
              <textarea
                value={draft.mcpAllowlist.join("\n")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    mcpAllowlist: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="one server name per line, e.g.&#10;insforge&#10;github&#10;wechat-mcp"
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "12px",
                  width: "100%",
                  minHeight: "80px",
                  resize: "vertical",
                  marginTop: "6px",
                  padding: "8px",
                  background: "var(--bg-input)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-1)",
                  color: "var(--ink)",
                }}
              />
            </div>

            <div className="mcp-template-section-head">
              <strong>Add MCP server</strong>
              <span className="mcp-template-section-sub">
                Drop any of these snippets into <code>~/.claude.json</code> under{" "}
                <code>mcpServers</code>. Restart Prism (or send one turn) to
                discover.
              </span>
            </div>
            {MCP_TEMPLATES.map((tpl) => (
              <div className="mcp-template-card" key={tpl.id}>
                <div className="mcp-template-head">
                  <strong>{tpl.title}</strong>
                  <a
                    href={tpl.url}
                    onClick={(e) => {
                      e.preventDefault();
                      window.open(tpl.url, "_blank");
                    }}
                  >
                    {tpl.urlLabel} →
                  </a>
                </div>
                <p className="mcp-template-desc">{tpl.description}</p>
                <pre className="mcp-template-snippet">
                  <code>{tpl.snippet}</code>
                </pre>
                <button
                  className="mcp-template-copy"
                  onClick={async () => {
                    if (await copyToClipboard(tpl.snippet)) {
                      setCopiedTemplateId(tpl.id);
                      setTimeout(() => setCopiedTemplateId(null), 2000);
                    }
                  }}
                >
                  {copiedTemplateId === tpl.id ? "Copied ✓" : "Copy config"}
                </button>
                {tpl.note ? (
                  <p className="mcp-template-note">{tpl.note}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {tab === "account" ? (
          <div className="settings-body">
            <div className="settings-memory-intro">
              <p>
                Sign in to associate Prism with your identity. Used for
                upcoming licensing — does not sync your chats, profile,
                or settings to any server.
              </p>
              <p className="settings-hint">
                The OAuth handshake goes to the provider you pick. Your
                email, name, and avatar URL stay on this device at{" "}
                <code>~/Library/Application&nbsp;Support/Prism/account.json</code>.
                We never store the access token.
              </p>
            </div>

            {accountStatus === null ? (
              <div className="settings-memory-empty">Loading…</div>
            ) : accountStatus.account ? (
              <div className="settings-account-card">
                {accountStatus.account.picture ? (
                  <img
                    className="settings-account-avatar"
                    src={accountStatus.account.picture}
                    alt={accountStatus.account.name}
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="settings-account-avatar settings-account-avatar-placeholder">
                    {accountStatus.account.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="settings-account-meta">
                  <div className="settings-account-name">
                    {accountStatus.account.name}
                  </div>
                  <div className="settings-account-email">
                    {accountStatus.account.email}
                  </div>
                  <div className="settings-account-provider">
                    via {accountStatus.account.provider} · since{" "}
                    {new Date(
                      accountStatus.account.signedInAt,
                    ).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="settings-secondary"
                  onClick={onSignOut}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <>
                <div className="settings-account-providers">
                  {accountStatus.providers.google.configured ? (
                    <button
                      className="settings-account-signin"
                      onClick={() => onSignIn("google")}
                      disabled={signingIn}
                    >
                      <span className="settings-account-signin-icon" aria-hidden="true">
                        G
                      </span>
                      <span>
                        {signingIn ? "Opening browser…" : "Sign in with Google"}
                      </span>
                    </button>
                  ) : (
                    <div className="settings-account-unconfigured">
                      <div className="settings-account-unconfigured-title">
                        Google OAuth not configured
                      </div>
                      <div className="settings-account-unconfigured-body">
                        Set the env var{" "}
                        <code>PRISM_GOOGLE_OAUTH_CLIENT_ID</code> before
                        launching Prism, or write the client id into{" "}
                        <code>~/Library/Application&nbsp;Support/Prism/oauth-config.json</code>
                        :
                        <pre className="settings-account-snippet">{`{ "google": { "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com" } }`}</pre>
                        Then quit + relaunch Prism. The client ID is for
                        a Google Cloud OAuth 2.0 "Desktop app" client —
                        PKCE flow, no client secret needed.
                      </div>
                    </div>
                  )}
                </div>
                {signInError ? (
                  <div className="settings-account-error">
                    Sign-in failed: {signInError}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

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
