# dsh-hud

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A **HUD status panel** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web.
One button in the input toolbar opens a floating panel showing:

- **Git** — branch, ahead/behind, unstaged / staged / untracked files (collapsible groups),
  per-file `+N/-N` summaries, click a file to expand its full diff, last 5 commits
- **MCP** — connected MCP servers (derived from `mcp__<server>__<tool>` tool names)
- **Skills** — skills available to the current agent
- **Official info** — current model + reasoning effort, plan mode state, token usage
  (input / output / cache-hit rate), session stats (turns, steps, LLM & tool time, decode
  tok/s, context usage %)

The button also shows a live badge with the number of uncommitted files, so you can see
at a glance that a project has pending changes without opening the panel.

## Platform support

| Platform | Status |
|---|---|
| macOS | ✅ Fully tested (development environment) |
| Windows / Linux | ⚠️ Not yet tested — expected to work, see [docs/install.md](docs/install.md#平台支持) |

## Requirements

- DSH web (run with `npx @deepseek-ai/dsh web`)
- `git` CLI on PATH
- No extra shell needed: DSH's `shell` service executes everything via `bash -c` on all
  platforms (Git Bash on Windows), so if DSH runs, this plugin runs.

## Installation

```bash
git clone https://github.com/a903067276-rgb/dsh-hud.git ~/dsh-plugins/dsh-hud
ln -s ~/dsh-plugins/dsh-hud ~/.dsh/profiles/web/node_modules/dsh-hud   # macOS / Linux
```

Then append the two mount entries from
[`examples/cordis.patch.example.yml`](examples/cordis.patch.example.yml) to
`~/.dsh/cordis.patch.yml` and **restart `dsh web`** (host composition changes require a
full restart; HMR does not apply).

> The two entries are both required (verified): the file-path mount runs the host half
> (data routes), the package-name mount is what the client module scanner discovers
> (browser UI). Windows users: prefer `dsh plugin --profile web add dsh-hud` over
> `ln -s`. Full details, verification steps, and uninstall: [docs/install.md](docs/install.md).

## Usage

Click **📊 HUD** in the input toolbar. The panel opens on the right side (default 240px);
drag its left edge to resize (200–480px, remembered in `localStorage`). Section headers
with count badges are clickable to collapse/expand. Data auto-refreshes every 30s (when
the panel is closed, only the lightweight git badge keeps polling).

## How it works

```
┌─ Host (Node, cordis plugin) ──────┐      ┌─ Browser (client bundle) ──┐
│  lib/index.js                     │      │  lib/client.js             │
│                                   │      │                            │
│  webServer.register(/api/dsh-hud) │──fetch──▶  input.left seat: button │
│    ├ /api/dsh-hud   git/mcp/...   │      │  shell.overlay seat: panel  │
│    └ /api/dsh-hud/diff  per-file  │      │                            │
└───────────────────────────────────┘      └────────────────────────────┘
```

The host serves JSON over the `webServer` prefix route and runs all git commands in a
**single `bash -c` call** with `__HUD_[BHSLN]__` segment markers (fast project switches).
The client is a hand-written `window.__ModuleLoader__.load(...)` bundle with zero build
step, sharing state between the button and the panel through a module-level store
(`useSyncExternalStore`). Details and known pitfalls for maintainers:
[docs/architecture.md](docs/architecture.md).

## Development

```
lib/index.js    host half — data routes (git / mcp / skills / model)
lib/client.js   client half — UI (button + panel), final bundle, no build step
docs/           install guide & architecture notes
examples/       cordis.patch.yml mount example
```

To test locally: symlink (or `dsh plugin --profile web link`) into the web profile's
`node_modules`, add the two mount entries, restart `dsh web`.

## Community

This is a plugin for DeepSeek Harness. Find more plugins via the
[`dsh-plugin` topic](https://github.com/topics/dsh-plugin).

## License

[MIT](LICENSE)
