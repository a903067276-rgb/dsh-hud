# dsh-hud

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）web 的 **HUD 状态面板**插件。
输入框工具行一键按钮，右侧浮层面板展示：

- **Git** —— 分支、ahead/behind、未暂存 / 已暂存 / 未跟踪文件（分组可折叠）、每文件
  `+N/-N` 摘要、点击文件展开 diff 全文、最近 5 条提交
- **MCP** —— 已挂载的 MCP 服务器（从 `mcp__<服务器>__<工具>` 工具名推导）
- **Skills** —— 当前 agent 可用的技能列表
- **官方信息聚合** —— 当前模型 + reasoning effort、plan 状态、token 用量（输入 / 输出 /
  缓存命中率）、会话统计（轮数、步数、LLM 与工具耗时、解码 tok/s、上下文占用 %）

按钮还带**未提交文件数角标**，不打开面板也能一眼看出项目有没有待提交改动。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | ✅ 开发环境，全功能实测 |
| Windows / Linux | ⚠️ 未实测；架构上预期可用，见 [docs/install.md](docs/install.md#平台支持) |

## 环境要求

- DSH web（`npx @deepseek-ai/dsh web` 启动）
- PATH 里有 `git` 命令行
- 不需要额外装 shell：DSH 的 shell 服务在所有平台上都以 `bash -c` 执行（Windows 为
  Git Bash），DSH 能跑，本插件就跟着能跑

## 安装

```bash
git clone https://github.com/a903067276-rgb/dsh-hud.git ~/dsh-plugins/dsh-hud
ln -s ~/dsh-plugins/dsh-hud ~/.dsh/profiles/web/node_modules/dsh-hud   # macOS / Linux
```

然后把 [`examples/cordis.patch.example.yml`](examples/cordis.patch.example.yml) 里的
两条挂载 entry 追加到 `~/.dsh/cordis.patch.yml`，**重启 `dsh web`**（宿主组合变化必须
重启，热更新无效）。

> 两条 entry 缺一不可（已实测）：文件路径挂载跑 host 半（数据路由），包名挂载供
> client 模块扫描发现（浏览器 UI）。Windows 用户建议用 `dsh plugin --profile web add dsh-hud`
> 代替 `ln -s`。完整步骤、验证方法、卸载：见 [docs/install.md](docs/install.md)。

## 使用

点输入框工具行的 **📊 HUD** 按钮。面板贴右侧展开（默认 240px），拖左边缘把手调整宽度
（200–480px，localStorage 记忆）。带计数徽标的小节标题可点击折叠/展开。数据每 30 秒
自动刷新（面板关闭时只轮询轻量的 git 角标数据）。

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

## 开发

```
lib/index.js    host 半 —— 数据路由（git / mcp / skills / model）
lib/client.js   client 半 —— UI（按钮 + 面板），最终产物，无构建步骤
docs/           安装指南与实现说明
examples/       cordis.patch.yml 挂载示例
```

本地测试：软链（或 `dsh plugin --profile web link`）进 web profile 的 node_modules，
加两条挂载 entry，重启 `dsh web`。

## 社区

本插件是 DeepSeek Harness 生态的一部分。更多插件见
[`dsh-plugin` 话题](https://github.com/topics/dsh-plugin)。

## 许可证

[MIT](LICENSE)
