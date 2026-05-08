# Prism architecture

_Last updated: 2026-05-08 · covers v0.1.21_

This document describes how Prism is built and why. It's the authoritative
reference — the README is a marketing surface, this is the engineering
ground truth. Read top-to-bottom for orientation, jump to sections for
detail.

## Contents

1. [What Prism is (and isn't)](#what-prism-is-and-isnt)
2. [Process architecture](#process-architecture)
3. [Anatomy of a chat turn](#anatomy-of-a-chat-turn)
4. [Subsystems](#subsystems)
5. [On-disk layout](#on-disk-layout)
6. [IPC surface](#ipc-surface)
7. [Privacy posture](#privacy-posture)
8. [Build, release, auto-update](#build-release-auto-update)
9. [Version history](#version-history)
10. [Roadmap](#roadmap)

---

## What Prism is (and isn't)

**What Prism is:** a desktop AI agent built as an Electron app that wraps
the Anthropic `claude` CLI. It adds a chat UI, multi-chat persistence,
auto-profile memory, slash-command discovery, live tool-progress rendering,
an artifacts pane (HTML / SVG / Mermaid / Python / diff), a token saver,
and a heuristic auto-router — all on top of `claude` doing the actual
inference and tool execution.

**What Prism is not:**

- **Not a runtime.** The model isn't bundled. Prism doesn't run inference,
  doesn't host MCPs, doesn't manage skill execution. It spawns `claude`
  per chat turn and consumes its `stream-json` output.
- **Not a fork of claude CLI.** No patches to the claude binary. We sit
  alongside it.
- **Not a multi-vendor router.** The current auto-router picks a Claude
  tier (haiku/sonnet/opus) based on prompt features. There's no
  OpenAI/Mistral/Ollama path today — see V0.2_BACKLOG for why.
- **Not a hosted product.** Everything runs on the user's machine. No
  Prism backend. No telemetry.

The single most important architectural choice was made in v0.1.9: **drop
the hand-written WebSocket gateway client and spawn `claude` directly**.
This is why Prism inherits the user's MCPs, skills, and Anthropic auth
for free — we read the same `~/.claude/settings.json` claude itself does.

---

## Process architecture

Three processes per running Prism instance:

```
        ┌─────────────────────────────────────┐
        │  Electron main process (Node.js)             │
        │  electron/main.ts + claude-client.ts +       │
        │  profile-store + profile-extractor +         │
        │  commands + rtk + setup                      │
        │                                              │
        │  - owns IPC, file system, child processes    │
        │  - hosts BrowserWindow                       │
        │  - electron-updater (auto-update)            │
        └──────┬──────────────────────┬──────────────┘
               │ ipcMain                  │ spawn
     ┌────────▼────────────────────────▼──────────────────┐
     │ Renderer (Chromium)       │ claude CLI subprocess     │
     │ React 18 + Vite           │ ~/.openclaw/bin/claude    │
     │ src/App.tsx + components  │  → spawned per-turn       │
     │                           │  → stream-json on stdout  │
     │ - chat surface            │  → reads ~/.claude/...     │
     │ - artifacts pane          │    settings.json (MCPs,    │
     │ - settings tabs           │    skills, hooks, RTK)     │
     │ - composer + slash menu   │  → talks to Anthropic API  │
     │                           │  → talks to MCPs locally  │
     └────────────────────────────│──────────────────────────┘
                              │
                              ▼
           Anthropic API + MCPs + Bash (RTK-wrapped) +
           Filesystem + Network
```

### Why this shape

- **Renderer never sees the filesystem.** All FS / child-process /
  network work goes through the main process via `ipcMain.handle()`,
  exposed to the renderer via the `flexhaul` global created in
  `electron/preload.ts`. Renderer is `contextIsolation: true,
  nodeIntegration: false, sandbox: true`.

- **Spawn-per-turn for claude.** Each chat turn opens a fresh
  `claude --print --output-format stream-json --verbose` subprocess.
  Stateless from Prism's POV; multi-chat is supported by passing
  `--resume <session-uuid>` captured from the prior turn's `init` event.

- **No daemon.** v0.1.0–0.1.8 used a WebSocket client to a separate
  agent runtime daemon. This was the wrong abstraction — see commit
  history around v0.1.9 — because the daemon's protocol was effectively
  reverse-engineered, and Prism kept getting it wrong. Spawning the
  reference CLI binary made the protocol opaque-on-purpose.

---

## Anatomy of a chat turn

The critical path: user types a message and presses Enter.

```
  RENDERER (App.tsx)
    │
    │ 1. Composer onSubmit
    │    - resolve activeChat.claudeSessionId
    │    - send IPC: window.flexhaul.chat.send({ message, model, sessionId })
    ▼
  PRELOAD (preload.ts)
    │ ipcRenderer.invoke("prism:chat:send", …)
    ▼
  MAIN (claude-client.ts::send)
    │ 2. Build args:
    │    - --print --output-format stream-json --verbose
    │    - --permission-mode bypassPermissions
    │    - --allow-dangerously-skip-permissions
    │    - if model == "auto": route via routeModel(message)
    │         - returns haiku|sonnet|opus by heuristic
    │         - logs [auto-route] to electron-log
    │         - else passes through user's pick
    │    - --resume <sessionId> if present
    │    - --append-system-prompt <profile-render>
    │         - profile-store.renderForInjection() returns markdown
    │           summary of stable preferences (capped ~250 tokens)
    │    - <user message> as positional arg
    │ 3. Augment env:
    │    - HOME, PATH (Homebrew + npm-global + ~/bin appended;
    │      Finder-launched Electron has minimal PATH)
    │    - cwd: HOME (so claude's project-config discovery works)
    │ 4. spawn(claudeBin, args, opts) → ChildProcess
    │ 5. Parse stdout line-by-line as stream-json events
    ▼
  CLAUDE CLI subprocess
    │ a. Reads ~/.claude/settings.json
    │    → PreToolUse "Bash" hook → rtk hook claude (if installed)
    │    → MCP server list (Gmail, Calendar, Drive, Sentry, …)
    │    → skills + commands
    │ b. Initial "system"/"init" event — emits session_id, model name,
    │    cwd, mcp_servers list, tools list. Prism logs this as
    │    [claude-init] for diagnostics.
    │ c. Streams "assistant" message blocks (text + tool_use)
    │    plus "user" tool_result echoes
    │ d. Final "result" event with duration_ms, total_cost_usd,
    │    is_error flag, errors[] array
    ▼
  MAIN (claude-client.ts::processLine)
    │ 6. For each event, emit to renderer over webContents:
    │    - "prism:chat:start"  on init
    │    - "prism:chat:delta"  on assistant text (synthesized deltas
    │                            by diffing current vs accumulated)
    │    - "prism:chat:tool"   on tool_use / tool_result
    │    - "prism:chat:end"    on successful result
    │    - "prism:chat:error"  on is_error — reads errors[], detects
    │                            session-expired patterns, sets the
    │                            sessionExpired flag
    │ 7. On successful end:
    │    - profile-extractor.enqueueExtraction({turnId, userMessage,
    │      assistantText}) — fires a separate haiku claude --print
    │      to mine stable preferences. Fire-and-forget.
    │    - emit "prism:profile:pending" so the gear icon dot lights
    ▼
  RENDERER
    │ 8. App.tsx event handlers:
    │    - onStart: capture sessionId, save into chats[active]
    │    - onDelta: append text to last assistant message bubble
    │    - onTool: append/update tool entry on the message's tool list
    │    - onEnd: stop streaming spinner, persist final text
    │    - onError: if sessionExpired, clear claudeSessionId; show
    │               "Session expired — next prompt will start fresh"
    │ 9. Message.tsx renders markdown, ToolStrip, artifact chips
    │    - artifacts.ts::extractArtifacts scans for fenced blocks
    │      tagged html/svg/mermaid/diff/python
    │    - clicking an artifact chip opens ArtifactPane on the right
    ▼
  USER
    │ 10. Sees streamed reply, can open artifacts, edit prior messages
    │     to regenerate, copy code blocks, stop generation, etc.
```

Full-turn latency dominators (p50, on M-series Mac):
- Spawning claude + reading config + connecting to MCPs: ~800ms
- First token from Anthropic API: ~600ms
- Tail-end finalize (writing chat to localStorage, profile-extractor
  spawn): ~50ms

Nothing in the chat path blocks on the auto-profile extractor — it runs
in a separate spawned process and stays out of the critical path.

---

## Subsystems

Each lives in its own module. Source-of-truth file is listed.

### Chat client — `electron/claude-client.ts`

The core of Prism. Spawns claude per turn, parses stream-json, emits IPC.
Also owns:
- Session-expired detection (reads `errors[]` from result events)
- Aborted-flag tracking (suppresses spurious "exited code null" on
  user-initiated stop)
- Tool-use / tool-result event surfacing (powers the inline tool strip)
- Auto-profile injection via `--append-system-prompt`
- Auto-router (`routeModel(message)`) for the "Auto" model picker option

Key decisions documented inline as version-tagged comments
(`// v0.1.13: ...`, `// v0.1.18: ...`).

### Auto-profile (memory) — `electron/profile-store.ts` + `profile-extractor.ts`

Local-only learned preferences about the user. After every successful
turn, `enqueueExtraction({userMessage, assistantText})` fires a
separate `claude --print --model haiku --output-format json` call with
a strict extraction prompt that returns:

```json
{
  "updates": [
    {
      "dimension": "<one of 8>",
      "claim": "<single sentence>",
      "confidence": 0.0..1.0,
      "evidence": "<short verbatim quote>"
    }
  ]
}
```

Dimensions: `communication_style`, `role_context`, `tooling`, `naming`,
`decision_style`, `project_focus`, `anti_patterns`, `knowledge`. Capped
at 6 entries per dimension and 40 total; eviction by
confidence-then-recency.

Stored at `<userData>/profile.json`. Rendered as compact markdown for
injection into the next turn's system prompt via
`renderForInjection()`. The user sees it in `Settings → Memory`, with
per-entry Forget buttons + Pause toggle + Forget-everything.

**Privacy note:** the profile is stored locally and goes to Anthropic
only as part of the user's own prompts (system-prompt prefix), the same
path their messages already take. No telemetry.

### Slash commands & skills — `electron/commands.ts`

Discovers two sources at startup (cached 30s, refreshed on window focus):

- `~/.claude/commands/<name>.md` — user-level slash commands
- `~/.claude/skills/<name>/SKILL.md` — user-level skills (also
  symlinked entries are followed via `fs.statSync`)

Frontmatter parsed for `name` + `description`. Renderer shows them in
the `SlashCommandMenu` dropdown when the input begins with `/`. Selection
inserts `/<name> ` into the composer; the actual command resolution
happens inside claude itself — we just surface them.

### Tool-progress rail — `claude-client.ts` events → `Message.tsx::ToolStrip`

Every `tool_use` block in an assistant message and every `tool_result`
in the user-tool echo gets pushed to the renderer as
`prism:chat:tool`. The `ToolStrip` component aggregates them on the
active assistant message; collapsed pill shows live count, expanded list
shows provider / action / input preview / result preview. MCP names
humanized via `friendlyToolName` (`mcp__claude_ai_Gmail__search_threads`
→ "Gmail / search threads").

### Artifacts pane — `src/artifacts.ts` + `ArtifactPane.tsx`

`extractArtifacts(text, idPrefix)` scans assistant text for fenced code
blocks tagged with one of:
- `html` / `htm` — sandboxed iframe (no scripts by default; toggle to
  enable)
- `svg` — inline render with `<script>` stripped via DOMParser
- `mermaid` / `mmd` — lazy-loaded mermaid library renders to SVG
- `diff` / `patch` — line-level red/green coloring (hand-rolled, no dep)
- `python` / `py` — lazy-loaded Pyodide; manual Run button captures
  stdout/stderr/return; sandboxed (no fs/network)

Detected artifacts surface as inline chips below the assistant message;
click opens the right-side `ArtifactPane` (44% pane width, slides in).

### RTK token saver — `electron/rtk.ts`

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that compresses
verbose tool output (git, find, grep, gcloud) before it reaches the
LLM. It works through a Claude Code `PreToolUse` Bash hook in
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "rtk hook claude" }
        ]
      }
    ]
  }
}
```

Prism doesn't need to invoke RTK itself — the hook runs inside the
spawned claude. What Prism adds:

- Detection: probes `/usr/local/bin/rtk`, Homebrew, `~/.cargo/bin`,
  `~/.local/bin`
- Stats: `rtk gain --format json` → `Settings → Speed` tab
- One-click hook enable: patches `~/.claude/settings.json` with a
  timestamped backup; idempotent (returns `alreadyPresent: true` when
  no change needed)

Observed on the developer's machine: 121K+ tokens saved at 65% average
compression across 460+ commands.

### Auto-router — `claude-client.ts::routeModel`

When `model === "auto"`, classifies the prompt and passes the chosen
tier to claude. Heuristic, not a pre-flight LLM call:

| Signal | Routes to |
|---|---|
| `len < 30` (acks) | haiku |
| Reasoning regex match (implement, refactor, debug, design+system, code blocks, len > 1500) | opus |
| `len > 600` | sonnet |
| Short factual `?` (len < 140, ends with ?) | haiku |
| _default_ | sonnet |

Logs `[auto-route] {turnId, tier, messageLen, preview}` to electron-log
so the chosen tier is auditable.

### Setup wizard — `electron/setup.ts` + `src/SetupWizard.tsx`

First-launch detection of:
- claude CLI binary on PATH
- `~/.openclaw/devices/paired.json` (legacy runtime pairing, kept for
  back-compat with v0.1.0–0.1.8 users)
- daemon reachability (only relevant for old setups)

v0.2 backlog item: replace this with a real onboarding scanner that
imports skills, vault, memory from existing setups (see
`V0.2_BACKLOG.md`).

### Settings — `src/Settings.tsx`

Three tabs:
- **General** — default model, theme, show-cost toggle, MCP info
- **Memory** — auto-profile entries grouped by dimension; per-item
  Forget; Pause learning; Forget everything
- **Speed** — RTK install/hook status, live token-savings stats,
  one-click Enable hook

State persisted to localStorage under `prism.settings.v1`. Profile and
RTK state read fresh from main process via IPC each time the modal
opens.

### Auto-update — `electron-updater` + GitHub Releases

On launch (5s after `app.whenReady`), `autoUpdater.checkForUpdatesAndNotify()`
fires. The macOS path is **.zip** (Squirrel.Mac requires it; .dmg is
fresh-install-only — a critical fix from v0.1.8). When an update is
available:

1. Banner appears in the titlebar
2. Auto-download in background
3. "Restart to apply" button on the banner once downloaded

DMGs are arm64-only as of v0.1.16 (concurrent x64+arm64 DMG builds race
on `/Volumes/Prism` mount name; arm64 DMG covers fresh install on Apple
Silicon, which is the target market). Both arches are published as
.zip so auto-update works on Intel Macs too.

---

## On-disk layout

```
# Prism's own files
<userData>/
  ├── profile.json                # auto-profile entries
  ├── prism.chats.v1              # multi-chat persistence (renderer-side)
  ├── prism.chats.activeId        # last-active chat id
  ├── prism.settings.v1           # model/theme/toggle prefs
  └── IndexedDB / Local Storage   # standard Electron renderer storage

# What Prism inherits (NOT modified, just read)
~/.claude/settings.json          # MCPs, RTK hook, project list
~/.claude/skills/<name>/SKILL.md # discovered + listed in slash menu
~/.claude/commands/<name>.md     # discovered + listed in slash menu
~/.openclaw/bin/claude           # the trace-wrapper script (legacy);
                                 # the actual binary preferred is
                                 # ~/.local/bin/claude-arm64-orig or
                                 # /usr/local/bin/claude

# Logs
~/Library/Logs/Prism/main.log    # electron-log writes here
                                 # contains [claude-init], [auto-route],
                                 # [updater], [extractor] entries

# Backups (Prism-created, on hook-enable)
~/.claude/settings.json.bak.<epoch>
```

`<userData>` resolves to `~/Library/Application Support/Prism` on macOS.

---

## IPC surface

All renderer-to-main calls go through `window.flexhaul.*`, exposed by
`electron/preload.ts` via `contextBridge.exposeInMainWorld`. The shape
is typed in `src/global.d.ts`. (The `flexhaul` namespace is a historical
artifact — Prism was a fork from a FlexHaul prototype — and is kept for
stability of the renderer code.)

### Categories

```ts
window.flexhaul = {
  // App
  getAppVersion(): Promise<string>
  checkForUpdates(): Promise<{ currentVersion, updateAvailable, latestVersion }>
  onUpdateEvent(event, cb): unsubscribe

  // Setup wizard
  setup: { status(), initialSteps(), run(), onStep(cb) }

  // Chat — the main path
  chat: {
    probe(): Promise<{ found, path }>
    send({ message, model?, sessionId? }): Promise<{ turnId } | { error }>
    abort(turnId): Promise<{ ok }>
    onStart(cb), onDelta(cb), onEnd(cb), onError(cb), onTool(cb)
  }

  // Auto-profile
  profile: {
    get(): Promise<ProfileData>
    setPaused(paused): Promise<ProfileData>
    removeEntry(id): Promise<ProfileData>
    clearAll(): Promise<ProfileData>
    onPending(cb): unsubscribe
  }

  // Slash command discovery
  commands: {
    list(): Promise<DiscoveredCommand[]>
    refresh(): Promise<DiscoveredCommand[]>
  }

  // RTK token saver
  rtk: {
    status(): Promise<RtkStatus>
    enableHook(): Promise<{ ok, alreadyPresent?, backupPath?, error? }>
  }
}
```

Full TypeScript shapes: `src/global.d.ts`. Channel names follow the
`prism:<feature>:<verb>` convention internally.

---

## Privacy posture

Prism's pitch is local-first. The current state, audited honestly:

| What | Where it lives | Who sees it |
|---|---|---|
| Chat history | localStorage in renderer | Only this device |
| Auto-profile | `<userData>/profile.json` | Only this device + Anthropic (as system-prompt prefix on each turn) |
| Settings | localStorage | Only this device |
| Logs | `~/Library/Logs/Prism/main.log` | Only this device |
| User prompt | Sent to Anthropic API by claude CLI | Anthropic |
| Tool results | Sent back through claude to Anthropic | Anthropic + the MCP server contacted |
| Telemetry | None | — |
| Crash reports | None | — |

**Things Prism specifically does NOT do:**

- No phone-home on launch
- No "how are you using the app" analytics
- No syncing chat history to a cloud
- No collecting profile data centrally

**Things to be aware of:**

- Prism inherits whatever MCPs the user has configured in claude. Those
  can include tools that talk to Gmail / Calendar / Drive / etc. on the
  user's behalf. Permission-mode is `bypassPermissions`, so claude
  doesn't prompt for approval per-tool-call — this is required for
  headless `--print` mode but means the user is trusting their MCP
  fleet.
- The `--allow-dangerously-skip-permissions` flag is also passed. Prism
  is a desktop app you ran on your own machine; this matches the trust
  model of any locally-installed dev tool. Don't run Prism as a service
  account or expose it via remote access.

---

## Build, release, auto-update

### Local development

```bash
npm install
npm run dev          # vite dev server on http://localhost:5173
npm start            # electron pointing at the dev server, with HMR
```

### Production build

```bash
npm run build        # vite build + tsc -p tsconfig.electron.json
npm run dist         # electron-builder — produces release/Prism-x.y.z*
```

Bundle composition (after `npm run build`):
- `dist/index.html` — 600 bytes
- `dist/assets/index-*.css` — ~30 KB
- `dist/assets/index-*.js` — ~340 KB main
- Lazy chunks: `cl100k_base` (gpt-tokenizer), Shiki grammars
  (per-language), `mermaid` (CDN), Pyodide (CDN)

Critical-path JS for users who don't trigger heavy features stays
~340 KB.

### Cutting a release

```bash
# 1. bump version in package.json
# 2. commit
git add -A && git commit -F /tmp/release-notes.txt

# 3. tag + push
git tag vX.Y.Z
git push origin main --tags

# 4. build distributables
rm -rf release && npm run dist

# 5. publish to GitHub Releases
gh release create vX.Y.Z \
  --title "Prism vX.Y.Z — ..." \
  --notes-file /tmp/release-notes.md \
  --latest
gh release upload vX.Y.Z \
  release/Prism-X.Y.Z-arm64.dmg \
  release/Prism-X.Y.Z-arm64-mac.zip \
  release/Prism-X.Y.Z-mac.zip \
  release/latest-mac.yml \
  --repo rca6045407168/prism --clobber
```

The `latest-mac.yml` is the manifest electron-updater consumes to
decide if an update is available. If it's missing from the release,
auto-update will report "can't parse releases feed" — always upload it.

### Auto-update on installed clients

Electron-updater on each running Prism instance:
1. Checks `https://github.com/rca6045407168/prism/releases/latest` 5s
   after launch
2. If newer version exists: downloads `Prism-X.Y.Z-<arch>-mac.zip` in
   the background
3. Surfaces a banner in the renderer
4. "Restart to apply" → swaps app bundle in place

.dmg is **only** for fresh install. Macs use .zip for in-place updates
(Squirrel.Mac format requirement).

---

## Version history

A condensed timeline. Full diffs in git tags.

| Version | Highlights |
|---|---|
| v0.1.0–0.1.8 | WS gateway client (deprecated); .dmg-only releases |
| v0.1.9 | **Architectural pivot**: spawn `claude` CLI directly. No more hand-written WS protocol. |
| v0.1.10–0.1.14 | MCP availability fixes (PATH, cwd, settings inheritance). Permission-mode bypass for headless. |
| v0.1.15–0.1.16 | Diagnostic logging (`[claude-init]`); session-expired auto-recovery via `errors[]` parsing |
| v0.1.17 | **Auto-profile** (silent local memory, 8 dimensions, Memory tab) |
| v0.1.18 | Slash commands + tool-progress rail + artifacts pane (HTML/SVG/Mermaid) |
| v0.1.19 | RTK token saver integration + Speed tab + one-click hook enable |
| v0.1.20 | Diff viewer + Python (Pyodide) artifacts + composer token counter + Shiki highlighting |
| v0.1.21 | Real auto-routing + batch-orchestrator render economy |

---

## Roadmap

Detail in [V0.2_BACKLOG.md](../V0.2_BACKLOG.md). Highlights:

- **P0** — First-launch onboarding scanner (auto-import skills, memory,
  vault from existing claude setup)
- **P1** — Stripe payment wire (license key flow)
- **P1** — Streaming token deltas (currently we synthesize deltas from
  full assistant blocks; real per-token streaming when claude CLI
  exposes it)
- **P2** — Code signing + notarization (~$99/yr Apple Developer Program)
- **P2** — Multi-tenant skill state (per-customer brain)
- **P2** — **Prism-side batch orchestrator** — currently `/batch` is
  skill-owned and the parent's tier pays for the reduce step. Moving
  orchestration into Prism lets the reducer always run on Haiku
  regardless of chat tier. ~70-90% reduce-step cost reduction.
- **Deferred** — MLX local fallback, LiteLLM proxy, Promptfoo eval,
  WebContainers. Reasons in V0.2_BACKLOG § Deferred.

---

## Reading order for new contributors

1. This document, top-to-bottom
2. `electron/main.ts` — process bootstrap, IPC registration
3. `electron/claude-client.ts` — the chat path; understand `send()`
   and `processLine()` first
4. `electron/preload.ts` — the API surface
5. `src/App.tsx` — renderer state machine; chat events; composer
6. `src/Message.tsx` + `src/ArtifactPane.tsx` — rendering
7. `electron/profile-store.ts` + `profile-extractor.ts` — memory
8. `electron/commands.ts` — skill discovery
9. `electron/rtk.ts` — the Speed tab
10. `V0.2_BACKLOG.md` — what's next

The codebase is small (~3K lines TS across main + renderer) on purpose.
If a feature feels like it should be elsewhere, it probably should be —
file an issue.
