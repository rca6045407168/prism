# Attribution

Prism wraps several open-source components. All are MIT-licensed unless
noted.

## Runtime layer

- **[Anthropic claude CLI](https://github.com/anthropics/claude-code)** —
  Prism spawns the `claude` binary per chat turn. The model, MCP
  protocol, skills/commands system, prompt caching, and session
  management all live in claude. Prism is a desktop client that consumes
  its `stream-json` output. (As of v0.1.9; earlier versions used a
  different runtime layer that has since been removed.)

## UI + rendering

- **[React](https://react.dev/)** · [Vite](https://vitejs.dev/) ·
  [Electron](https://www.electronjs.org/) — standard desktop stack.
- **[Shiki](https://shiki.style/)** — syntax highlighting for assistant
  code blocks (TextMate grammars; same engine VSCode uses on
  vscode.dev).
- **[react-markdown](https://github.com/remarkjs/react-markdown)** +
  **[remark-gfm](https://github.com/remarkjs/remark-gfm)** — markdown
  rendering for assistant messages.
- **[Mermaid](https://mermaid.js.org/)** (CDN, lazy-loaded) — diagram
  rendering inside the artifacts pane.
- **[Pyodide](https://pyodide.org/)** (CDN, lazy-loaded) — Python
  execution inside the artifacts pane.

## Engineering helpers

- **[gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)** —
  cl100k_base BPE tokenizer; lazy-loaded for the composer token counter.
- **[react-diff-viewer-continued](https://github.com/aeolun/react-diff-viewer-continued)**
  — dependency available for unified-diff rendering. (Current
  implementation is a simpler hand-rolled component.)
- **[electron-updater](https://www.electron.build/auto-update)** +
  **[electron-log](https://github.com/megahertz/electron-log)** —
  auto-update + logging.

## Token saver

- **[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk)** —
  open-source CLI proxy that compresses verbose tool output before it
  reaches the model. Prism detects RTK and surfaces stats; the actual
  hook lives in the user's `~/.claude/settings.json` and is wired into
  claude itself, not Prism.

## License preservation

All bundled or detected components retain their original copyright
notices and licenses. See each project's repository for the canonical
license text. Prism itself is MIT-licensed; see
[LICENSE](LICENSE) (if present) and [package.json](package.json).

