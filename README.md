# Prism

> Type N prompts. Get N parallel agents. Reconciled into one answer.

Prism is a desktop AI agent that wraps the Anthropic `claude` CLI in
an Electron app. It adds a chat UI, multi-chat persistence, silent
auto-profile memory, slash-command discovery, live tool-progress
rendering, an artifacts pane (HTML / SVG / Mermaid / Python / diff),
a heuristic auto-router, and an integrated token saver. Runs entirely
on your machine.

For the engineering ground truth, see
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Install

Download the latest `Prism-x.y.z-arm64.dmg` from
[Releases](https://github.com/rca6045407168/prism/releases/latest)
and drag to Applications.

First launch shows "Prism can't be opened because it's from an
unidentified developer" — right-click → Open → Open. One-time bypass;
code signing ships in v0.2.

Apple Silicon (M1+) is the supported install target. Intel Macs are
supported by the auto-update path (.zip), so once installed updates work
in both arches.

## Auto-update

Electron-updater checks GitHub Releases on every launch. When a new
version is available, a banner appears in the titlebar. One click
downloads + restarts — no reinstall.

## What's shipped

- **Chat** — multi-chat sidebar, search, rename, delete, edit-and-regenerate
- **Auto-profile** — silent learning of stable preferences (Settings → Memory)
- **Slash commands** — type `/` to autocomplete from `~/.claude/commands/` and `~/.claude/skills/`
- **Tool-progress rail** — live indicator of which MCP tools are firing per turn
- **Artifacts pane** — live HTML / SVG / Mermaid / diff / Python preview
- **Auto-router** — the "Auto" model picker option actually picks haiku/sonnet/opus per-prompt
- **Token saver** — RTK integration; Settings → Speed tab
- **Batch mode** (⌘B) — multi-prompt fan-out via the `batch-orchestrator` skill
- **Adversarial debate** — `/debate` runs 2-round critic/proposer/judge before shipping high-stakes drafts. See [docs/ARCHITECTURE.md § Adversarial debate](docs/ARCHITECTURE.md#adversarial-debate--prismskillsdebatemd).

## Develop

```bash
npm install
npm run dev          # vite dev server
npm start            # electron pointing at the dev server

npm run dist         # build local .dmg/.zip without publishing
```

## Cut a release

See [docs/ARCHITECTURE.md § Build, release, auto-update](docs/ARCHITECTURE.md#build-release-auto-update).

## Credits

Built on top of open-source components. See [ATTRIBUTION.md](ATTRIBUTION.md).

## License

MIT.

