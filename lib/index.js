/**
 * dsh-hud — HUD status panel (host half)
 *
 * Serves two JSON endpoints to the browser:
 *   1. /api/dsh-hud          — git status (branch / ahead-behind / grouped files / diff summary / commit history), MCP servers, skills, current model, official account balance
 *   2. /api/dsh-hud/diff     — full diff of a single file (fetched on demand when a file row is clicked)
 *
 * Also registers the `perModelUsage` session projection unit (per-model token
 * buckets for the current session, mirroring token-meter's replace semantics).
 *
 * Transport: the webServer service registers a prefix route; the client fetches JSON.
 * Only scalars/arrays are serialized — no live objects.
 */
import { existsSync, readdirSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-hud'
// Dependencies must be declared via `inject` (ctx.get may return undefined for them)
export const inject = ['webServer', 'shell', 'sessions', 'agents', 'tools', 'skills', 'apiProxy', 'sessionProjections', 'credentials']

/** 注册数据路由；任何依赖服务缺失时静默跳过（HUD 是锦上添花，不阻塞宿主）。 */
export function apply(ctx) {
  const webServer = ctx.webServer
  const shell = ctx.shell
  const sessions = ctx.sessions
  const agents = ctx.agents
  const tools = ctx.tools
  const skills = ctx.skills
  const apiProxy = ctx.apiProxy
  const sessionProjections = ctx.sessionProjections
  const credentials = ctx.credentials
  if (webServer === undefined || shell === undefined) return

  // 分模型用量投影单元：注册进官方 sessionProjections 注册表（与 token-meter 同机制），
  // 缺失注册表的环境静默跳过。注册是 effect，卸载时自动注销。
  if (sessionProjections !== undefined) {
    try {
      ctx.effect(() => sessionProjections.register(perModelUsageProjection), 'dsh-hud: perModelUsage unit')
    } catch (error) {
      console.error('[dsh-hud] perModelUsage register failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // ── 事件驱动刷新（2026-08-19，替代轮询）：fs.watch 监听工作区/关注仓库 → SSE 推送 tick → client 刷新 ──
  const sseClients = new Set()
  let sseDirty = false
  function broadcastTick() {
    if (sseDirty) return
    sseDirty = true
    setTimeout(() => {
      sseDirty = false
      const tick = 'data: tick\n\n'
      for (const res of sseClients) {
        try { res.write(tick) } catch (error) { /* ignore */ }
      }
    }, 400) // 合并 400ms 内的连续变化（git 命令会密集写 .git）
  }
  function watchRootsFor(cwd, extraRepos) {
    const roots = []
    if (typeof cwd === 'string' && cwd !== '' && existsSync(cwd)) roots.push(cwd)
    if (Array.isArray(extraRepos)) {
      for (const e of extraRepos) {
        if (typeof e === 'string' && e !== '' && existsSync(e)) roots.push(e)
      }
    }
    const watchers = []
    for (const root of roots) {
      try {
        watchers.push(watch(root, { recursive: true }, () => broadcastTick()))
      } catch (error) { /* 目录不可 watch（权限/删除）时忽略 */ }
    }
    return watchers
  }

  try {
    // prefix 单路由（官方 client-modules 同款模式）：/api/dsh-hud 与 /api/dsh-hud/diff 在 handler 内分流。
    // 注意：ctx.effect 会立即执行传入的函数，注册必须用箭头函数包裹（直接传 dispose 会被立即注销）。
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/dsh-hud',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          const sessionId = url.searchParams.get('session')
          // SSE 事件流（事件驱动刷新）：必须在 prefix 内分流（exact 路由会被 prefix 抢先匹配）
          if (url.pathname === '/api/dsh-hud/events') {
            // 同源校验（内联实现；isSameOrigin 是 perm-guard 的函数，本插件没有）
            const origin = req.headers.origin || ''
            const sameOrigin = origin === ''
              ? /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')
              : /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
            if (!sameOrigin) {
              res.writeHead(403, { 'Content-Type': 'text/plain' })
              res.end('forbidden')
              return
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
            res.write(': connected\n\n')
            sseClients.add(res)
            let watchers = []
            try {
              const extraRepos = url.searchParams.get('repos')
                ? String(url.searchParams.get('repos')).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
                : null
              const cwd = getSessionCwd(sessions, sessionId)
              watchers = watchRootsFor(cwd, extraRepos)
            } catch (error) { /* 解析失败则不 watch，仅保留连接 */ }
            req.on('close', () => {
              sseClients.delete(res)
              for (const w of watchers) { try { w.close() } catch (error) { /* ignore */ } }
            })
            return
          }
          if (url.pathname === '/api/dsh-hud/diff') {
            const path = url.searchParams.get('path') ?? ''
            if (typeof sessionId !== 'string' || path === '') {
              writeJson(res, 400, { diff: '' })
              return
            }
            if (isThrottled(sessionId, 'diff')) {
              writeJson(res, 429, { diff: '' })
              return
            }
            const session = sessions.get(sessionId)
            const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
            if (cwd === null) {
              writeJson(res, 200, { diff: '' })
              return
            }
            // 越权防护：path 必须属于该会话最近一次状态里的变更文件清单（防读任意 tracked 文件 diff）
            const allowed = diffAllowlist.get(sessionId)
            if (allowed === undefined || !allowed.has(path)) {
              writeJson(res, 403, { diff: '' })
              return
            }
            const diff = await runGit(shell, cwd, 'git diff HEAD -- ' + shq(path), MAX_DIFF_BYTES)
            writeJson(res, 200, { diff: diff.text === '' ? '(无 diff)' : diff.text })
            return
          }
          const light = url.searchParams.get('light') === '1'
          // light/full 分窗口：client 侧两类请求是分开节流的，共用窗口会误拦打开面板时的 full 请求
          if (isThrottled(sessionId, light ? 'status-light' : 'status-full')) {
            writeJson(res, 429, { error: 'throttled' })
            return
          }
          const cwd = getSessionCwd(sessions, sessionId)
          // 关注仓库（localStorage 配置，请求时携带）：换行分隔的绝对路径列表（2026-08-20 由逗号改，
          // 逗号要分中英文；解析仍兼容逗号，防旧客户端）
          let extraRepos = null
          try {
            const raw = req.url && req.url.includes('repos=') ? decodeURIComponent(req.url.split('repos=')[1].split('&')[0]) : ''
            if (raw !== '') extraRepos = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          } catch { /* ignore */ }
          const payload = light
            ? { count: cwd === null ? [] : await collectGitCount(shell, cwd, extraRepos) }
            : {
                version: await collectVersion(shell),
                git: await collectGit(shell, sessions, sessionId, extraRepos),
                mcp: collectMcp(tools),
                skills: await collectSkills(skills, agents, sessionId),
                model: await collectModel(apiProxy, sessionId),
                // 计费显示（2026-08-18 恢复）：1.2.1 曾按安全审计脱敏为 null（显示 "--"），
                // 用户拍板完整恢复——本地面板泄露风险极低，密钥本就存在于本机
                balance: await collectBalance(credentials),
              }
          writeJson(res, 200, payload)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-hud: data route')
    console.error('[dsh-hud] routes registered')
  } catch (error) {
    console.error('[dsh-hud] register failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** bash 单引号转义（路径安全拼接）。 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 单条 git 命令的超时（ms）。Windows 上杀毒软件扫描可能拖慢，必要时调大。 */
const GIT_TIMEOUT_MS = 5000

/** 单文件 diff 输出的最大字节数（防超大 diff 拖垮面板/内存）。 */
const MAX_DIFF_BYTES = 524288

/** git 状态组合命令输出的最大字节数（防超大仓库 status 拖垮面板/内存）。 */
const MAX_STATUS_BYTES = 2097152

/**
 * host 侧请求节流窗口（ms）：同一会话的 status-light/status-full/diff 请求在各自窗口内
 * 只放行一次，防恶意循环高频触发 git 子进程。正常客户端轮询间隔 ≥ 30s，远大于窗口；
 * light/full 分窗口（与 client 节流一致），避免面板打开时紧跟 light 轮询被误拦。
 */
const REQUEST_THROTTLE_MS = 200
const lastRequestAt = new Map() // sessionId → { 'status-light': ts, 'status-full': ts, diff: ts }

/** 返回 true 表示该会话该类型请求落在节流窗口内，应直接拒绝（429）。 */
function isThrottled(sessionId, kind) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const now = Date.now()
  const entry = lastRequestAt.get(sessionId) || {}
  if (now - (entry[kind] || 0) < REQUEST_THROTTLE_MS) return true
  entry[kind] = now
  lastRequestAt.set(sessionId, entry)
  return false
}

/**
 * diff 端点白名单：sessionId → 该会话最近状态里的变更文件路径集合。
 * collectGit 每次刷新时并入当前状态文件路径；diff 端点只允许读取白名单内的路径，
 * 防止越权读取任意 tracked 文件的未提交 diff（P1 审计项）。
 * 集合上限防止长期会话无界增长（超大 status 本身已被 MAX_STATUS_BYTES 截断）。
 */
const DIFF_ALLOWLIST_MAX = 5000
const diffAllowlist = new Map()

/** 记录该会话的变更文件路径（并入式，容忍状态刷新与点击之间的竞态窗口）。 */
function rememberDiffPaths(sessionId, files) {
  if (typeof sessionId !== 'string') return
  let set = diffAllowlist.get(sessionId)
  if (set === undefined || set.size > DIFF_ALLOWLIST_MAX) set = new Set()
  for (const file of files) {
    if (file && typeof file.path === 'string' && file.path !== '') set.add(file.path)
  }
  diffAllowlist.set(sessionId, set)
}

async function runGit(shell, cwd, command, maxBytes) {
  const res = await shell.run(shell.resolve({ command, workdir: cwd, timeoutMs: GIT_TIMEOUT_MS, stdoutMaxBytes: maxBytes }))
  return {
    text: res.stdout && res.stdout.text ? res.stdout.text : '',
    exitCode: res.exitCode,
  }
}

/**
 * 极简 schema（零依赖）：注册表只调用 `.parse`；结构与类型错误在此暴露，防止脏数据进客户端。
 */
const perModelSchema = {
  parse(view) {
    if (typeof view !== 'object' || view === null || !Array.isArray(view.models)) {
      throw new TypeError('perModelUsage view must be { models: [...] }')
    }
    return view
  },
}

/**
 * perModelUsage 投影单元：本会话各模型的 token 用量（输入/缓存/输出/请求数）。
 *
 * - `request/header` 事件标记"当前请求模型"（顺序生效，每次 +1 请求数）；
 * - usage 事件（assistant/chunk 的 usage 块与 assistant/message）按当前模型累计；
 * - 同一 (轮,步) 的用量是**替换**而非累加（与 token-meter 同语义：chunk 是早期样本、
 *   message 是最终样本，重复样本不得双计）。
 */
// 导出供 scripts/replay-permodel.mjs 重放验证引用（cordis 插件只消费 name/inject/apply，额外导出无副作用）
export const perModelUsageProjection = {
  key: 'perModelUsage',
  schema: perModelSchema,
  init: () => ({ currentModel: null, last: null, models: {} }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const config = event.data && event.data.header && event.data.header.config
      const model = config && typeof config.model === 'string' && config.model !== '' ? config.model : null
      if (model === null) return state
      const prev = state.models[model]
      // 纯不可变更新：新 entry 对象，绝不改旧状态里的引用
      const entry = {
        requests: (prev ? prev.requests : 0) + 1,
        uncachedInput: prev ? prev.uncachedInput : 0,
        cacheRead: prev ? prev.cacheRead : 0,
        output: prev ? prev.output : 0,
      }
      return { currentModel: model, last: state.last, models: { ...state.models, [model]: entry } }
    }
    let usage = null
    let turn = null
    let step = null
    if (event.type === 'assistant/chunk') {
      const chunk = event.data && event.data.chunk
      if (chunk && chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage
        turn = event.data.turn
        step = event.data.step
      }
    } else if (event.type === 'assistant/message') {
      usage = event.data && event.data.usage
      turn = event.data.turn
      step = event.data.step
    }
    if (!usage) return state
    const model = state.currentModel ?? 'unknown'
    const input = typeof usage.inputTokens === 'number' && usage.inputTokens > 0 ? usage.inputTokens : 0
    const cache = typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0 ? usage.cacheReadTokens : 0
    const output = typeof usage.outputTokens === 'number' && usage.outputTokens > 0 ? usage.outputTokens : 0
    if (input === 0 && cache === 0 && output === 0) return state
    // 同一 (轮,步) 重复样本：先从上一份样本的模型桶里扣掉，再按新样本累计（替换语义，
    // 与 token-meter 一致：chunk 是早期样本、message 是最终样本，不得双计）
    const prev = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
    const models = { ...state.models }
    if (prev !== null) {
      const p0 = models[prev.model]
      models[prev.model] = {
        requests: p0 ? p0.requests : 0,
        uncachedInput: Math.max(0, (p0 ? p0.uncachedInput : 0) - prev.input),
        cacheRead: Math.max(0, (p0 ? p0.cacheRead : 0) - prev.cache),
        output: Math.max(0, (p0 ? p0.output : 0) - prev.output),
      }
    }
    const e0 = models[model]
    models[model] = {
      requests: e0 ? e0.requests : 0,
      uncachedInput: (e0 ? e0.uncachedInput : 0) + input,
      cacheRead: (e0 ? e0.cacheRead : 0) + cache,
      output: (e0 ? e0.output : 0) + output,
    }
    return { currentModel: state.currentModel, last: { turn, step, model, input, cache, output }, models }
  },
  view: (state) => {
    const models = Object.entries(state.models)
      .map(([model, m]) => {
        const billed = m.uncachedInput + m.cacheRead
        return {
          model,
          requests: m.requests,
          uncachedInput: m.uncachedInput,
          cacheRead: m.cacheRead,
          output: m.output,
          cacheHitPct: billed > 0 ? Math.round(m.cacheRead / billed * 100) : null,
        }
      })
      .sort((a, b) => (b.uncachedInput + b.cacheRead + b.output) - (a.uncachedInput + a.cacheRead + a.output))
    return { models }
  },
  stateVersion: 1,
}

/** 官方余额拉取：解析 DEEPSEEK_API_KEY 凭据 → 调 /user/balance；失败返回 null。60s 缓存。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_CACHE_MS = 60000
let balanceCache = { at: 0, value: undefined } // value: undefined=未取过 null=失败/不可用
async function collectBalance(credentials) {
  if (credentials === undefined) return null
  const now = Date.now()
  if (balanceCache.value !== undefined && now - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value
  try {
    const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
    const key = resolved && typeof resolved.value === 'string' && resolved.value !== '' ? resolved.value : null
    if (key === null) {
      balanceCache = { at: now, value: null }
      return null
    }
    const res = await fetch(BALANCE_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : undefined
    const value = info && typeof info.total_balance === 'string'
      ? {
          currency: typeof info.currency === 'string' ? info.currency : 'CNY',
          total: Number(info.total_balance) || 0,
          granted: Number(info.granted_balance) || 0,
          toppedUp: Number(info.topped_up_balance) || 0,
        }
      : null
    balanceCache = { at: Date.now(), value }
    return value
  } catch (error) {
    console.warn('[dsh-hud] balance failed: ' + (error instanceof Error ? error.message : String(error)))
    balanceCache = { at: Date.now(), value: null }
    return null
  }
}

/** DSH 版本号（面板状态行显示，2026-08-20）：shell 跑 `dsh --version`，60s 缓存；失败返回 null。 */
let versionCache = { at: 0, value: undefined } // value: undefined=未取过 null=失败/不可用
async function collectVersion(shell) {
  if (shell === undefined) return null
  const now = Date.now()
  if (versionCache.value !== undefined && now - versionCache.at < 60000) return versionCache.value
  try {
    const res = await shell.run(shell.resolve({
      command: 'dsh --version',
      workdir: homedir(),
      timeoutMs: 5000,
      stdoutMaxBytes: 4096,
    }))
    const text = res.stdout && res.stdout.text ? res.stdout.text.trim() : ''
    versionCache = { at: now, value: text !== '' ? text : null }
    return versionCache.value
  } catch (error) {
    console.warn('[dsh-hud] version failed: ' + (error instanceof Error ? error.message : String(error)))
    versionCache = { at: now, value: null }
    return null
  }
}

/** 单仓库 Git 状态收集（collectGit 与子仓库聚合共用）；非 git 仓库、超时一律返回 null。
 *  sessionId 传入时登记 diff 白名单（仅当前仓库——子仓库条目不参与 diff 点击）。 */
// 非仓库警告限速（2026-08-19，issue #4）：8 秒一次的刷屏改为 60 秒最多一条
let lastNonRepoWarnAt = 0

async function collectGitAt(shell, cwd, sessionId, quietNonRepo) {
  try {
    // 一次 shell 调用跑完全部 git 命令（省 4 次 shell 启动，切项目刷新更快），分隔符分段。
    // 跨平台安全：DSH 的 shell 服务在所有平台上都以 `bash -c` 执行（Windows 为 Git Bash），
    // git porcelain 输出本身也与平台无关。若 bash/git 不可用或命令失败，输出只剩分隔符，
    // branch/hash 均为空 → 返回 null，界面灰显，不抛错。
    const command = [
      'echo "__HUD_B__"',
      'git symbolic-ref --quiet --short HEAD',
      'echo "__HUD_H__"',
      'git rev-parse --short HEAD 2>/dev/null',
      'echo "__HUD_S__"',
      'git status --porcelain=v1 -b',
      'echo "__HUD_N__"',
      'git diff --numstat HEAD --',
      'echo "__HUD_L__"',
      "git log -5 --pretty=format:'%h|%s|%ct' --",
    ].join('; ')
    const res = await runGit(shell, cwd, command, MAX_STATUS_BYTES)
    const segs = res.text.split(/__HUD_[BHSLN]__/)
    // segs: ['', branch, hash, status, numstat, log]
    const branchRaw = (segs[1] || '').trim()
    const hashRaw = (segs[2] || '').trim()
    if (branchRaw === '' && hashRaw === '') {
      // 日志区分"不是 git 仓库"与"目录不存在"；多仓库工作区根目录非仓库是正常场景
      // （子仓库聚合仍工作），有子仓库时静默；无子仓库时警告但 60 秒限速（issue #4 降噪）
      if (!existsSync(cwd)) {
        console.warn('[dsh-hud] git unavailable — cwd does not exist: ' + cwd)
      } else if (!quietNonRepo) {
        const now = Date.now()
        if (now - lastNonRepoWarnAt > 60000) {
          lastNonRepoWarnAt = now
          console.warn('[dsh-hud] not a git repository: ' + cwd)
        }
      }
      return null
    }
    const branch = branchRaw !== '' ? branchRaw : 'detached@' + hashRaw
    const parsed = parseStatus(branch, segs[3] || '')

    // diff 摘要（+N/-N）：numstat 按路径匹配
    const counts = parseNumstat(segs[4] || '')
    for (const file of parsed.files) {
      const count = counts.get(file.path)
      file.add = count ? count.add : 0
      file.del = count ? count.del : 0
      file.new = file.untracked === true
    }

    // 最近 5 条提交
    parsed.commits = parseLog(segs[5] || '')
    // diff 白名单：仅当前仓库登记（sessionId 非 null 时）
    if (sessionId !== undefined) rememberDiffPaths(sessionId, parsed.files)
    return parsed
  } catch (error) {
    console.warn('[dsh-hud] git status failed: ' + (error instanceof Error ? error.message : String(error)))
    return null
  }
}

/** 扫描 cwd 一级子目录中的独立 git 仓库（多仓库工作台用，如 plugin-dev 下的各插件目录）。 */
function scanSubRepos(cwd) {
  try {
    const out = []
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name.startsWith('.')) continue
      if (existsSync(join(cwd, entry.name, '.git'))) out.push(entry.name)
    }
    return out.sort()
  } catch {
    return []
  }
}

function getSessionCwd(sessions, sessionId) {
  if (typeof sessionId !== 'string') return null
  const session = sessions.get(sessionId)
  return session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
}

/** 轻量未提交计数（角标轮询用，2026-08-18）：一次 shell 统计当前仓库 + 全部子仓库，
 *  返回 [{name, count}]——7 个仓库 1 次调用，支撑 8s 级高频轮询。 */
async function collectGitCount(shell, cwd, extraRepos) {
  try {
    // 工作区根 + 子仓库 + 关注仓库，一次 bash 循环统计（每行 name:count）
    const dirs = ['.']
    // 去重（2026-08-20）：关注仓库与会话目录/子仓库指向同一目录时不再重复统计（角标防双计）
    const seen = new Set([cwd.replace(/\/+$/, '')])
    try {
      for (const entry of readdirSync(cwd, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(cwd, entry.name, '.git'))) {
          dirs.push(entry.name)
          seen.add(join(cwd, entry.name).replace(/\/+$/, ''))
        }
      }
    } catch { /* ignore */ }
    if (Array.isArray(extraRepos)) {
      for (const extra of extraRepos) {
        if (typeof extra !== 'string' || extra === '' || !existsSync(extra)) continue
        const key = extra.replace(/\/+$/, '')
        if (seen.has(key)) continue
        seen.add(key)
        dirs.push("'" + extra.replace(/'/g, "'\\''") + "'")
      }
    }
    const command = "for d in " + dirs.join(' ') + "; do [ -d \"$d/.git\" ] && { c=$(git -C \"$d\" status --porcelain 2>/dev/null | wc -l | tr -d ' '); echo \"$d:$c\"; }; done"
    const res = await runGit(shell, cwd, command, 65536)
    const out = []
    for (const line of (res.text || '').split('\n')) {
      if (line === '') continue
      const i = line.lastIndexOf(':')
      if (i <= 0) continue
      const raw = line.slice(0, i)
      const name = raw === '.' ? '' : raw.replace(/\/$/, '').replace(/^'|'$/g, '')
      const count = Number(line.slice(i + 1)) || 0
      out.push({ name: name === '' ? '' : (name.includes('/') ? name.split('/').pop() : name), count })
    }
    return out
  } catch {
    return []
  }
}

/** Git 状态收集（含子仓库聚合）：当前仓库 + 一级子目录独立 git 仓库 + 关注仓库（extraRepos）；
 *  非 git 仓库、超时、会话缺失一律返回 null（由界面灰显）。 */
async function collectGit(shell, sessions, sessionId, extraRepos) {
  const cwd = getSessionCwd(sessions, sessionId)
  if (cwd === null) return null
  const subNames = scanSubRepos(cwd)
  const hasExtra = Array.isArray(extraRepos) && extraRepos.length > 0
  // 有子仓库或关注仓库时，根目录非仓库是正常场景，静默（60s 限速警告只留给真·空目录）
  const current = await collectGitAt(shell, cwd, sessionId, subNames.length > 0 || hasExtra)
  // 多仓库聚合（2026-08-18）：当前仓库 active，子仓库/关注仓库折叠条目
  // 根目录非仓库时（issue #4）：不整体返回 null——有子仓库则正常聚合显示，active 条目省略
  const repos = []
  // 去重（2026-08-20）：会话目录与关注目录相同（或关注仓库嵌套子仓库与会话目录/子仓库撞车）
  // 时不再重复显示——按规范化路径（去尾部斜杠）判重，谁先收集谁保留
  // （当前仓库 > 子仓库 > 关注仓库），重复者整条跳过（含其嵌套子仓库）
  const seenPaths = new Set()
  const normPath = (p) => String(p).replace(/\/+$/, '')
  const pushRepo = (r, path) => {
    const key = normPath(path)
    if (seenPaths.has(key)) return
    seenPaths.add(key)
    repos.push(r)
  }
  if (current !== null) pushRepo({ ...current, name: basename(cwd), active: true }, cwd)
  for (const name of subNames) {
    const r = await collectGitAt(shell, join(cwd, name))
    if (r !== null) pushRepo({ ...r, name, active: false }, join(cwd, name))
  }
  if (hasExtra) {
    for (const extra of extraRepos) {
      if (typeof extra !== 'string' || extra === '' || !existsSync(extra)) continue
      const r = await collectGitAt(shell, extra)
      if (r !== null) pushRepo({ ...r, name: basename(extra), active: false, extra: true }, extra)
      // 关注仓库内部的多仓库工作区（嵌套子仓库，缩进一级显示）
      for (const sub of scanSubRepos(extra)) {
        const sr = await collectGitAt(shell, join(extra, sub))
        if (sr !== null) pushRepo({ ...sr, name: sub, active: false, extra: true, parent: basename(extra) }, join(extra, sub))
      }
    }
  }
  // 空判断必须在关注仓库聚合之后（2026-08-20 修复）：会话目录非 git 且无子仓库时，
  // 关注仓库是唯一数据源，提前 return null 会把它们整块丢掉（面板只剩"不是 Git 仓库"）
  if (repos.length === 0) return null
  return { ...current, repos }
}

/**
 * 解析 `git status --porcelain=v1 -b` 输出：
 * 首行 `## 分支... [ahead N, behind M]`；其余行 `XY 路径`（重命名带 `->`）。
 * 保留 X/Y 双列以支持暂存/未暂存分组，状态码归并为界面用单符号。
 */
function parseStatus(branch, stdout) {
  let ahead = 0
  let behind = 0
  const files = []
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF 混入路径
    if (line.startsWith('## ')) {
      const m = /ahead (\d+)/.exec(line)
      const n = /behind (\d+)/.exec(line)
      if (m !== null || n !== null) {
        ahead = m === null ? 0 : Number(m[1])
        behind = n === null ? 0 : Number(n[1])
      }
      continue
    }
    const index = line[0]
    const worktree = line[1]
    let path = line.length > 3 ? line.slice(3) : ''
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    files.push({
      x: index,
      y: worktree,
      status: mergeStatus(index, worktree),
      staged: index !== ' ' && index !== '?',
      unstaged: worktree !== ' ',
      untracked: index === '?' && worktree === '?',
      path,
    })
  }
  return { branch, ahead, behind, files }
}

/** XY 双列状态码归并为单个展示符号。 */
function mergeStatus(index, worktree) {
  if (index === '?' && worktree === '?') return '??'
  if (index === 'U' || worktree === 'U') return 'U'
  if (index === 'A' || worktree === 'A') return 'A'
  if (index === 'D' || worktree === 'D') return 'D'
  if (index === 'R' || worktree === 'R') return 'R'
  return 'M'
}

/** numstat 解析：`added\tdeleted\tpath`，兼容重命名（`old => new` / `{old => new}`）。 */
function parseNumstat(text) {
  const map = new Map()
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const add = parts[0] === '-' ? 0 : Number(parts[0])
    const del = parts[1] === '-' ? 0 : Number(parts[1])
    let path = parts.slice(2).join('\t')
    const arrow = path.indexOf(' => ')
    if (arrow >= 0) {
      let after = path.slice(arrow + 4)
      if (after.endsWith('}')) after = after.slice(0, -1)
      path = after
    }
    map.set(path, { add, del })
  }
  return map
}

/** `git log --pretty=format:%h|%s|%ct` 解析。 */
function parseLog(text) {
  const out = []
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF
    const i = line.indexOf('|')
    const j = line.indexOf('|', i + 1)
    if (i < 0 || j < 0) continue
    out.push({ hash: line.slice(0, i), subject: line.slice(i + 1, j), time: Number(line.slice(j + 1)) || 0 })
  }
  return out
}

/** MCP 服务器名：工具名 `mcp__<server>__<tool>` 的第二段去重排序。 */
function collectMcp(tools) {
  if (tools === undefined) return []
  try {
    const servers = new Set()
    for (const schema of tools.schemas()) {
      const raw = schema && typeof schema.name === 'string' ? schema.name : ''
      if (!raw.startsWith('mcp__')) continue
      const part = raw.split('__')[1]
      if (part !== undefined && part !== '') servers.add(part)
    }
    return [...servers].sort()
  } catch (error) {
    return []
  }
}

/** 当前生效模型（与界面模型选择器同一数据源）。注意 models 入参是 RPC 信封 { payload: {...} }。 */
async function collectModel(apiProxy, sessionId) {
  if (apiProxy === undefined || typeof sessionId !== 'string') return null
  try {
    const res = await apiProxy.sessions.models({ payload: { sessionId } })
    const current = res && res.result && res.result.ok ? res.result.value.current : undefined
    if (!current || typeof current.model !== 'string') return null
    return {
      provider: typeof current.provider === 'string' ? current.provider : '',
      model: current.model,
      reasoningEffort: typeof current.reasoningEffort === 'string' ? current.reasoningEffort : '',
    }
  } catch (error) {
    return null
  }
}

/** 技能按 agent scope 挂载：scope 传 agent 对象本身，cwd 用于项目层技能。 */
async function collectSkills(skills, agents, sessionId) {
  if (skills === undefined || typeof sessionId !== 'string') return []
  try {
    const agent = agents.get(sessionId)
    const lookup = {
      cwd: agent && agent.session && agent.session.header && typeof agent.session.header.cwd === 'string'
        ? agent.session.header.cwd
        : undefined,
      scope: agent,
    }
    const list = await skills.list(lookup)
    if (!Array.isArray(list)) return []
    return list.map((item) => item && typeof item.name === 'string' ? item.name : '').filter((item) => item !== '')
  } catch (error) {
    console.error('[dsh-hud] skills failed: ' + (error instanceof Error ? error.message : String(error)))
    return []
  }
}

/** 统一 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
