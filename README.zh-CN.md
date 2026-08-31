# dsh-hud 📊

[English](README.md) | [简体中文](README.zh-CN.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）web 的 **HUD 状态面板**插件：输入框工具行一键按钮，可拖动浮层面板展示 Git 状态、MCP 服务器、技能列表、官方用量信息与余额。

*非官方项目：社区成员独立开发维护，非 DeepSeek 官方产品。*

## 截图

![dsh-hud 输入框仪表盘按钮](assets/hud-button.png)

![dsh-hud 面板](assets/hud-panel.png)

可拖动浮层面板：Git 状态、提交历史、MCP 服务器、技能列表，以及官方用量信息
（token 输入/输出、缓存命中率、轮数/步数、LLM 与工具耗时、上下文占用）。

## 功能

- **Git** —— 分支、ahead/behind、未暂存 / 已暂存 / 未跟踪文件（分组可折叠）、每文件
  `+N/-N` 摘要、点击文件展开 diff 全文、最近 5 条提交
- **MCP** —— 已挂载的 MCP 服务器（从 `mcp__<服务器>__<工具>` 工具名推导）
- **Skills** —— 当前 agent 可用的技能列表
- **官方信息聚合** —— 当前模型 + reasoning effort、plan 状态、token 用量（输入 / 输出 /
  缓存命中率）、会话统计（轮数、步数、LLM 与工具耗时、解码 tok/s、上下文占用 %）
- **官方余额** —— 自动调 `GET /user/balance`（用 `DEEPSEEK_API_KEY` 凭据，key 不出机器；
  不可用时显示 `--`）
- **分模型用量** —— 本会话按模型的 token 明细（请求数/输入/缓存/输出），切换
  flash/pro 后两个模型的用量都保留显示

按钮还带**未提交文件数角标**，不打开面板也能一眼看出项目有没有待提交改动。

## 安装

本仓库是官方 **bundle 插件**格式（根 `package.json` 的 `dsh.bundle` + `dsh.client`），
经官方 profile 管理一行安装：

```sh
dsh plugin --profile web add "github:a903067276-rgb/dsh-hud#main"
```

装完**重启 `dsh web`**（bundle 层在启动时合成，热更新无效）。需要 pnpm
（`dsh plugin` 是 pnpm 转发器）。

手动挂载兜底：见 [docs/install.md](docs/install.md)。

## 用法

点输入框工具行的仪表盘图标按钮（官方 dsw 风格，跟随深浅色主题）。面板默认在左侧展开（默认 240px，
避开官方右侧回合导航条），**拖标题栏可任意移动位置**（localStorage 记忆，重开面板按记忆位置显示）；
拖左边缘把手调整宽度（200–480px，localStorage 记忆）。带计数徽标的小节标题可点击折叠/展开。数据每 30 秒
自动刷新（面板关闭时只轮询轻量的 git 角标数据）。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | ✅ 开发环境，全功能实测 |
| Linux | ⚠️ 未实测；架构上预期可用，见 [docs/install.md](docs/install.md#平台支持) |
| Windows | ⚠️ 未实测；架构上预期可用，见 [docs/install.md](docs/install.md#平台支持) |

## 环境要求

- DSH web（≥ 0.1.1-rc.1）（`npx @deepseek-ai/dsh web` 启动）
- **版本对照**（分模型用量投影使用 0.1.1+ 契约；0.1.0-rc.7/rc.8 仍是旧契约）：
- **维护策略**：本插件将持续跟随 DSH 最新版本演进；对旧版 DSH 的兼容仅是尽力而为、不保证长期有效。

| 你的 DSH 版本 | 装这个 | 说明 |
|---|---|---|
| 0.1.1-rc.1 及以上 | `main`（v1.2.15+） | 全功能 |
| 0.1.0-rc.7 – 0.1.0-rc.8 | `v1.2.11` — `dsh plugin add github:a903067276-rgb/dsh-hud#v1.2.11` | 0.1.1 旧投影契约的最后一个版本 |
| 0.1.0-rc.6 及更早 | `rc6-compat` — `dsh plugin add github:a903067276-rgb/dsh-hud#rc6-compat` | 冻结，不再维护——建议升级 |

- PATH 里有 `git` 命令行
- 不需要额外装 shell：DSH 的 shell 服务在所有平台上都以 `bash -c` 执行（Windows 为
  Git Bash），DSH 能跑，本插件就跟着能跑

## 工作原理

```
┌─ Host（Node，cordis 插件）────────┐      ┌─ 浏览器（client bundle）───┐
│  lib/index.js                     │      │  lib/client.js             │
│                                   │      │                            │
│  webServer.register(/api/dsh-hud) │──fetch──▶  input.left seat：按钮   │
│    ├ /api/dsh-hud   git/mcp/…     │      │  shell.overlay seat：面板   │
│    └ /api/dsh-hud/diff  单文件 diff│      │                            │
└───────────────────────────────────┘      └────────────────────────────┘
```

Host 半经 `webServer` prefix 路由输出 JSON，全部 git 命令合并成**一次 `bash -c`
调用**（`__HUD_[BHSLN]__` 分隔符分段，切项目刷新快）。Client 半是手写的
`window.__ModuleLoader__.load(...)` bundle，零构建步骤；按钮与面板通过模块级 store
（`useSyncExternalStore`）共享状态。维护者请看 [docs/architecture.md](docs/architecture.md)
（含实现细节与踩坑记录）。

## 注意事项

- bundle 安装与手动挂载**二选一**，不要同时用。
- 所有数据都在本地从运行中的 `dsh` 实例读取；唯一的外呼是官方余额接口
  （用 `DEEPSEEK_API_KEY` 凭据，key 不出机器）。
- **`DSH_HUD_NO_WATCH=1` 可完全关闭文件监听**——HUD 改为纯 30s 轮询 + 手动/聚焦刷新。
  适合目录树极其庞大的机器（例如一个父目录下放几十个仓库的布局）——macOS 文件监听
  在这种规模下不稳定；监听器默认也设了 128 个上限，超出的深层目录变化会在 ~30s 内
  通过轮询发现。

## 开发

```
lib/index.js        host 半 —— 数据路由（git / mcp / skills / model）
lib/client.js       client 半 —— UI（按钮 + 面板），最终产物，无构建步骤
cordis.patch.yml    bundle patch —— 单 entry 包名挂载（官方 bundle 流程）
docs/               安装指南与实现说明
examples/           手动双 entry 挂载示例（兜底安装路径）
```

本地测试：软链（或 `dsh plugin --profile web link`）进 web profile 的 node_modules，
加两条挂载 entry，重启 `dsh web`。

## 设计路线（简洁优先）

dsh-hud 刻意保持最小：

- **零依赖** —— 无运行时依赖、无构建步骤，client bundle 就是仓库里的最终产物
- **纯只读** —— 只读 git 状态、MCP/Skills 列表和官方投影，不做任何 git 写操作、不改文件
- **一个按钮一个面板** —— 没有设置页、没有配置文件

**独立社区项目**：非 DeepSeek 官方出品，与任何其他 DSH 插件项目无关联、非衍生、无代码
共享。需要重操作（提交/推送 UI、文件树、git 图谱）的话，社区有其他插件覆盖；dsh-hud
刻意只做"扫一眼就懂"的状态面板，可与它们共存。

## 社区

本插件是 DeepSeek Harness 生态的一部分。更多插件见
[`dsh-plugin` 话题](https://github.com/topics/dsh-plugin)。

## 许可证

[MIT](LICENSE)
