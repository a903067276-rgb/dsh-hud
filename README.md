# dsh-hud 📊

[English](README.md) | [简体中文](README.zh-CN.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

A **HUD status panel** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web: one button in the input toolbar opens a floating panel with git status, MCP servers, skills, official usage info and balance.

*Unofficial project: independently developed and maintained by a community member, not an official DeepSeek product.*

## Screenshot

![dsh-hud gauge button in the input toolbar](assets/hud-button.png)

![dsh-hud panel](assets/hud-panel.png)

The gauge button in the input toolbar opens the floating panel showing git status, commit history, MCP servers, skills and official usage info (tokens, cache hit rate, turns/steps, LLM & tool time, context usage).

## Features

- **Git** — branch, ahead/behind, unstaged / staged / untracked files (collapsible groups),
  per-file `+N/-N` summaries, click a file to expand its full diff, last 5 commits
- **MCP** — connected MCP servers (derived from `mcp__<server>__<tool>` tool names)
- **Skills** — skills available to the current agent
- **Official info** — current model + reasoning effort, plan mode state, token usage
  (input / output / cache-hit rate), session stats (turns, steps, LLM & tool time, decode
  tok/s, context usage %)
- **Balance** — official DeepSeek account balance, auto-fetched from
  `GET /user/balance` using the `DEEPSEEK_API_KEY` credential (the key never leaves
  the host; shows `--` when unavailable)
- **Per-model usage** — current session's token buckets broken down by model
  (requests, input, cache, output), so flash/pro usage both remain visible after
  switching

The button also shows a live badge with the number of uncommitted files, so you can see
at a glance that a project has pending changes without opening the panel.

## Install

This repository is an official **bundle plugin** (`dsh.bundle` + `dsh.client` in the root
`package.json`), installed through the official profile manager:

```sh
dsh plugin --profile web add "github:a903067276-rgb/dsh-hud#main"
```

Then **restart `dsh web`** (bundle layers are composed at startup; HMR does not apply).
Requires `pnpm` on PATH (`dsh plugin` forwards to pnpm).

Manual mount fallback: see [docs/install.md](docs/install.md).

## Usage

Click the **gauge icon** in the input toolbar (official DSH design tokens, follows
dark/light theme). The panel opens on the right side (default 240px);
drag its left edge to resize (200–480px, remembered in `localStorage`). Section headers
with count badges are clickable to collapse/expand. Data auto-refreshes every 30s (when
the panel is closed, only the lightweight git badge keeps polling).

## Platform support

| Platform | Status |
|---|---|
| macOS | ✅ Fully tested (development environment) |
| Linux | ⚠️ Not yet tested — expected to work, see [docs/install.md](docs/install.md#平台支持) |
| Windows | ⚠️ Not yet tested — expected to work, see [docs/install.md](docs/install.md#平台支持) |

## Requirements

- DSH web (run with `npx @deepseek-ai/dsh web`)
- `git` CLI on PATH
- No extra shell needed: DSH's `shell` service executes everything via `bash -c` on all
  platforms (Git Bash on Windows), so if DSH runs, this plugin runs.

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

## Notes

- Use either the official bundle install or the manual mount — never both.
- All data is gathered locally from the running `dsh` instance; the only outbound call is
  the official balance API using the `DEEPSEEK_API_KEY` credential (the key never leaves
  the host).

## Development

```
lib/index.js        host half — data routes (git / mcp / skills / model)
lib/client.js       client half — UI (button + panel), final bundle, no build step
cordis.patch.yml    bundle patch — single package-name mount (official bundle flow)
docs/               install guide & architecture notes
examples/           manual double-mount example (fallback install path)
```

To test locally: symlink (or `dsh plugin --profile web link`) into the web profile's
`node_modules`, add the two mount entries, restart `dsh web`.

## Design philosophy

**Simple by design.** dsh-hud is deliberately minimal:

- **Zero dependencies** — no runtime packages, no build step; the client bundle is the
  final artifact in the repo
- **Read-only** — it only reads git status, MCP/skills listings and official projections;
  no git write operations, no file mutations
- **One button, one panel** — no settings pages, no config files

It is an **independent community project**: not an official DeepSeek product, and not
affiliated with, forked from, or sharing code with any other DSH plugin project. If your
workflow needs heavyweight SCM operations (commit/push UI, file trees, git graphs), other
plugins cover that; dsh-hud deliberately stays a glanceable status HUD and coexists with
them.

## Community

This is a plugin for DeepSeek Harness. Find more plugins via the
[`dsh-plugin` topic](https://github.com/topics/dsh-plugin).

## License

[MIT](LICENSE)
