# 安装指南（dsh-hud）

## 官方余额功能说明

面板状态行的 💰 余额来自 DeepSeek 官方接口 `GET /user/balance`，自动拉取、无需配置——
它复用 DSH 的凭据服务，读取 `DEEPSEEK_API_KEY`（`~/.dsh/.credentials.yaml` 或环境变量，
DSH 本身也需要它才能调用模型，通常已存在）。key 只在 host 进程内使用，不会发给浏览器。

- 无该凭据 / 网络失败 / 非官方 baseURL 代理：余额显示 `--`，不影响其他功能
- 分模型用量为本地会话统计（与官方投影同源），不依赖任何凭据

## 安装（推荐：官方 bundle 一行安装）

本仓库是官方 **bundle 插件**格式（根 `package.json` 的 `dsh.bundle` + `dsh.client`），
经官方 profile 管理：

```sh
dsh plugin --profile web add "github:a903067276-rgb/dsh-hud#main"
```

装完**重启 `dsh web`**（bundle 层在启动时合成）。更新时
`dsh plugin --profile web update dsh-hud`（或换 git 源 ref），重启生效。

> **需要 pnpm**：`dsh plugin` 是 pnpm 转发器，PATH 里没有 pnpm 会直接失败。
> 未安装可用 `npm i -g pnpm`（或 corepack 启用）；pnpm 主版本需与 profile
> 现有 store 一致（本机为 v11，装 pnpm@10 会报 `ERR_PNPM_UNEXPECTED_STORE`）。

## 安装（兜底：手动挂载，macOS 实测路径）

> 手动方式**无需** `dsh plugin add`，但必须按下面的"双 entry"挂载（早期实测结论），
> 且与 bundle 安装**二选一**，不要同时用。

### 前置条件

- 已安装 DSH web（`dsh web` 命令可用）。
- 依赖 `git` 命令行（在 PATH 中）。
- DSH 的 shell 服务在所有平台上都以 `bash -c` 执行命令（Windows 为 Git Bash），
  因此本插件不需要额外安装 shell——DSH 能跑，它就跟着能跑。
- 插件按**包名**解析时，依赖 web profile 的 `node_modules`。npm 全局安装的 dsh 对应路径为
  `~/.dsh/profiles/web/node_modules`。

### 安装步骤

1. **把仓库放到本地**，例如 `~/dsh-plugins/dsh-hud`（克隆或直接拷贝均可）。

2. **让 web profile 能按包名解析到它**（client 半的发现机制用
   `require.resolve('dsh-hud/package.json')` 扫描，必须按包名可解析）：

   - macOS / Linux：

     ```bash
     ln -s ~/dsh-plugins/dsh-hud ~/.dsh/profiles/web/node_modules/dsh-hud
     ```

   - Windows：`ln -s` 需要管理员权限或开发者模式，直接用上面的官方 bundle 安装即可。

3. **在 `~/.dsh/cordis.patch.yml` 追加双 entry**（示例见
   [`examples/cordis.patch.example.yml`](../examples/cordis.patch.example.yml)）：

   - 文件路径挂载 → host 半（`apply` 执行，注册 `/api/dsh-hud` 数据路由）；
   - 包名挂载 → client 半（浏览器侧 UI，由 clientModules 扫描发现）。

   ```yaml
   - insert:
       - id: dsh-hud
         name: /Users/<you>/dsh-plugins/dsh-hud/lib/index.js
       - id: dsh-hud-client
         name: 'dsh-hud'
   ```

4. **重启 `dsh web`**。宿主组合（patch 层）变化必须重启才生效，热更新无效。

## 验证是否装好

- 输入框工具行出现「📊 HUD」按钮，右上角浮出面板；
- 浏览器访问 `/plugins/dsh-hud/client.js` 返回 200；
- 打开面板能拉到 Git 状态 / MCP 列表 / Skills 列表（非 git 仓库时 Git 段显示"不是 Git 仓库"，属正常）。

## 卸载

- bundle 安装：`dsh plugin --profile web remove dsh-hud`，重启 `dsh web`。
- 手动挂载：删除 `~/.dsh/cordis.patch.yml` 里的两条 entry、删除软链
  `~/.dsh/profiles/web/node_modules/dsh-hud`，重启 `dsh web`。
- 从手动挂载**迁移**到 bundle 安装：先卸载手动方式（上一条），再执行 bundle 安装命令，
  重启。两种方式不要同时存在。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | ✅ 开发环境，全功能实测 |
| Windows / Linux | ⚠️ 未实测；架构上预期可用，详见下方说明 |

**为什么预期可用**：DSH 的 shell 服务在所有平台上都以 `bash -c` 执行（Windows 为
Git Bash），git porcelain 输出本身与平台无关，解析器已做 CRLF 防御。已知边界：

- Windows 需要可用的 bash（DSH 本身的要求，非本插件额外要求）；
- Windows 上杀毒软件可能拖慢 git，如遇超时可将 `lib/index.js` 里的
  `GIT_TIMEOUT_MS`（默认 5000ms）调大；
- 非 UTF-8 文件名会以转义形式显示（git 默认 `core.quotepath` 行为，全平台一致）。

欢迎在 Windows / Linux 上验证后提交 issue 或 PR 补充实测结果。

## 已知注意事项（全部实测）

1. **手动挂载必须双 entry**：用户 patch 层里「包名挂载」host 的 `apply` 不执行；
   「文件路径挂载」clientModules 发现不了（bundle 404）。两条互补缺一不可。
   （官方 bundle 安装没有这个问题，单 entry 即可。）
2. **文件路径挂载的插件必须 `export const inject = [...]` 声明依赖**，否则
   `ctx.get()` 拿到的服务全是 `undefined`。
3. **旧副本遮蔽**：`~/.dsh/profiles/web/node_modules` 里如果残留旧拷贝（而非软链），
   会遮蔽源码改动。插件更新后请检查此处，确保指向源码的软链。
4. 面板宽度的记忆存在浏览器 `localStorage`（键 `dsh-hud-width`），清缓存不影响功能。
