# Prism

Branded desktop client for the [OpenClaw](https://github.com/openclaw/openclaw)
gateway. Talks to a locally-running OpenClaw daemon over WebSocket.

Adds on top of the upstream dashboard:

- **Batch mode** — fan out N prompts to N parallel agents in one submit
- **Auto model selection** — cheap/standard/reasoning routing per prompt
- **Prism branding + auto-update** — versioned releases via GitHub, no
  manual upgrades required

## Install

Download the latest `.dmg` from
[Releases](https://github.com/rca6045407168/prism/releases/latest)
and drag to Applications.

First launch will say "Prism can't be opened because it's from
an unidentified developer" — Right-click → Open → Open. (Code signing
ships in v0.2.)

Requires OpenClaw to be installed and paired:

```bash
brew install openclaw
openclaw configure   # one-time pair
```

## Auto-update

Every launch checks GitHub Releases. When a new version is available,
a banner appears. One click downloads + restarts.

## Develop

```bash
npm install
npm run dev          # vite dev server (http://localhost:5173)
npm start            # electron app pointing at dev server

npm run dist         # build .dmg locally without publishing
```

## Build a release

```bash
# bump version in package.json, then:
git tag v0.2.0
git push --tags
```

GitHub Actions builds the `.dmg` and publishes to Releases.
electron-updater on installed clients auto-discovers within ~24h
(or immediately on next launch / manual "Check for Updates…").

## Upstream tracking

`.github/workflows/daily-upstream-watch.yml` opens an issue when the
[OpenClaw](https://github.com/openclaw/openclaw) repo cuts a new release
that we haven't tracked. We don't auto-rebase — daemon behavior changes
need human review. The current pinned upstream version lives in
`.upstream-version`.

## License

MIT. Built on top of OpenClaw (also MIT). See LICENSE and ATTRIBUTION.md.
