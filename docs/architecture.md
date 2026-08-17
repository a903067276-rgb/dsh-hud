# 实现说明（architecture）

dsh-hud 分两半，通过 HTTP 通信，互不感知对方内部：

```
┌─ Host（Node，cordis 插件）─────────────┐      ┌─ Browser（client bundle）──────┐
│  lib/index.js                          │      │  lib/client.js                 │
│                                        │      │                                │
│  inject: webServer / shell / sessions  │      │  inject: slots / timer         │
│  / agents / tools / skills / apiProxy  │      │                                │
│                                        │      │  seat 1: conversation.input.left│
│  webServer.register(prefix /api/dsh-hud)──fetch──▶  "📊 HUD" 按钮 + 角标        │
│    ├ /api/dsh-hud    git/mcp/skills/… │      │  seat 2: shell.overlay          │
│    └ /api/dsh-hud/diff 单文件 diff      │      │  右侧浮层面板                   │
└────────────────────────────────────────┘      └────────────────────────────────┘
```

## Host 半（lib/index.js）

- **数据路由**：`webServer.register({ kind: 'prefix', path: '/api/dsh-hud' })`，
  handler 内按 `url.pathname` 分流 `/diff` 与主查询。`?light=1` 只返回 git（按钮角标用，
  省去 MCP/skills 开销）。
- **Git 一次 shell 调用收全**：`git symbolic-ref` / `rev-parse` / `status --porcelain=v1 -b` /
  `diff --numstat` / `log` 拼进一条命令，用 `__HUD_[BHSLN]__` 分隔符分段，避免 4 次 shell
  启动延迟。非 git 仓库（分支与 hash 均为空）返回 `null`，界面灰显。
- **MCP 列表**：遍历 `tools.schemas()`，取 `mcp__<server>__<tool>` 前缀工具的第二段去重排序。
- **Skills 列表**：`skills.list({ cwd, scope: agent })` —— scope 必须传 agent 对象本身，
  不传只返回全局层。
- **当前模型**：`apiProxy.sessions.models({ payload: { sessionId } })`，注意入参是 RPC
  信封（`{ payload }`），返回值在 `res.result.value`。
- **官方余额**：`credentials.resolve("DEEPSEEK_API_KEY")`（凭据服务，返回
  `{ value, source }`）→ `GET https://api.deepseek.com/user/balance`（Bearer、5s 超时），
  60s 内存缓存防抖；任何失败返回 `null`（界面 `--`）。key 只在 host 侧使用，不出机器。
- **分模型用量投影单元 `perModelUsage`**：注册进 `ctx.sessionProjections`（与官方
  token-meter 同机制，经 `session/projection` 帧推给浏览器）：
  - `request/header` 事件标记"当前请求模型"（顺序生效，每次 +1 请求数）；
  - usage 事件（assistant/chunk 的 usage 块、assistant/message）按当前模型累计；
  - 同一 (轮,步) 重复样本**替换**而非累加（与 token-meter 同语义，防双计）；
  - 校验：`scripts/replay-permodel.mjs` 对真实会话日志重放，与独立参照折叠对账，
    且分模型之和 == 官方 tokenUsage 总量（已实测一致）。
- 只输出标量/数组，不序列化任何 live 对象；任何依赖缺失时静默跳过（HUD 是锦上添花）。

## Client 半（lib/client.js）

- **打包格式**：手写 `window.__ModuleLoader__.load({ id, factory })` 模块，factory 里
  `require('react')`，`exports.inject = ['slots', 'timer']`。这是当前 DSH web 的 client
  插件格式（无构建步骤，仓库里就是最终产物）。
- **跨组件共享状态**：模块级 store（不可变快照 + `useSyncExternalStore`）。按钮写开合，
  面板读开合 + 数据；投影数据也经它中转。
- **两个 seat**：
  - `conversation.input.left`（session 级 seat，有 `useProjection`）——按钮 + 角标；
    在此订阅官方投影：`plan` / `tokenUsage` / `sessionStats` / `contextPressure` /
    `perModelUsage`，提取标量后 `emit` 进共享 store。
  - `shell.overlay`（root 级 seat，**没有** `useProjection`）——浮层面板，从共享 store
    读投影数据。
- **轮询**：面板开 30s 全量刷新；面板关只轮询 git light 数据（角标常驻）。
- **交互细节**：面板宽度 200–480 可拖（左缘把手），`localStorage('dsh-hud-width')` 记忆；
  小节标题可折叠，带计数徽标；文件行点击按需拉 `/diff`，diff 缓存在组件 state。
- 样式全部走 DSW CSS 变量（`var(--dsw-alias-*, fallback)`），跟随宿主主题。

## 已知坑（给维护者）

1. `ctx.effect(fn)` 会**立即执行** `fn`：`ctx.effect(dispose)` 等于注册完立刻注销（404 根因）。
   必须用箭头函数包裹：`ctx.effect(() => webServer.register(...))`。
2. React hooks 必须在条件 return 之前全部声明（面板组件在 `!snap.open` 提前 return）。
3. `shell.run` 返回 `CollectedOutput`，`.text` 才是字符串；判定非 git 仓库用 `exitCode`。
4. `git log --pretty=format:%h|%s|%ct` 的 `|` 会被 bash 当管道，format 必须加引号。
5. 宿主组合（patch 层）变化必须重启 `dsh web`；client 侧改动经 HMR 热更。
6. 手动挂载（用户 patch 层）必须双 entry；官方 bundle 流程（仓库根 `cordis.patch.yml`）
   单 entry 包名挂载即可，无此问题。
