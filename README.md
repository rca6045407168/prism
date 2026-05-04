# Prism

> Type N prompts. Get N parallel agents. Reconciled into one answer.

Prism is a desktop AI agent platform. Unlike chat-first tools, Prism is built
around **parallel batch input** — you submit multiple prompts at once, they
fan out to N parallel agents, and the results come back as one synthesized
answer. Auto-routes across multiple model vendors (Anthropic, OSS, local)
based on prompt complexity. Runs on your machine.

## Install

Download the latest `Prism-x.y.z.dmg` from
[Releases](https://github.com/rca6045407168/prism/releases/latest)
and drag to Applications.

First launch will show "Prism can't be opened because it's from an
unidentified developer" — Right-click → Open → Open. (One-time bypass;
code signing ships in v0.2.)

## Auto-update

Every launch checks Releases. When a new version is available, a banner
appears in the app. One click downloads + restarts. No reinstall needed.

## Status

**v0.1 (current):** chat window, batch mode (⌘B), auto-update, brand
shell. Requires manual one-time setup of the agent runtime — see
v0.2 below for the auto-installer.

**v0.2 (in progress):**

- One-click auto-installer for the agent runtime (no terminal commands)
- First-launch onboarding scanner that imports existing skills, memory,
  vault from your machine
- Stripe payment integration
- Streaming token deltas in chat

**v1.0:**

- Code signing + notarization (no Gatekeeper warning)
- Bundled runtime (zero external dependencies)
- Multi-tenant support (per-employee brain)
- Customer skill marketplace

## Develop

```bash
npm install
npm run dev          # vite dev server
npm start            # electron app pointing at dev server

npm run dist         # build .dmg locally without publishing
```

## Cut a release

```bash
# bump version in package.json
git tag v0.2.0
git push --tags
```

GitHub Actions builds the `.dmg` and publishes to Releases.
electron-updater on installed clients auto-discovers the next time
they check (within ~24h, or immediately on next launch).

## Credits

Built on top of open-source components. See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT.
