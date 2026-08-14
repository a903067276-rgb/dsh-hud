/**
 * dsh-hud — HUD status panel (host half)
 *
 * Serves two JSON endpoints to the browser:
 *   1. /api/dsh-hud          — git status (branch / ahead-behind / grouped files / diff summary / commit history), MCP servers, skills, current model
 *   2. /api/dsh-hud/diff     — full diff of a single file (fetched on demand when a file row is clicked)
 *
 * Transport: the webServer service registers a prefix route; the client fetches JSON.
 * Only scalars/arrays are serialized — no live objects.
 */
export const name = 'dsh-hud'
// Dependencies must be declared via `inject` (ctx.get may return undefined for them)
export const inject = ['webServer', 'shell', 'sessions', 'agents', 'tools', 'skills', 'apiProxy']

/** 注册数据路由；任何依赖服务缺失时静默跳过（HUD 是锦上添花，不阻塞宿主）。 */
export function apply(ctx) {
  const webServer = ctx.webServer
  const shell = ctx.shell
  const sessions = ctx.sessions
  const agents = ctx.agents
  const tools = ctx.tools
  const skills = ctx.skills
  const apiProxy = ctx.apiProxy
  if (webServer === undefined || shell === undefined) return

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
          if (url.pathname === '/api/dsh-hud/diff') {
            const path = url.searchParams.get('path') ?? ''
            if (typeof sessionId !== 'string' || path === '') {
              writeJson(res, 400, { diff: '' })
              return
            }
            const session = sessions.get(sessionId)
            const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
            if (cwd === null) {
              writeJson(res, 200, { diff: '' })
              return
            }
            const diff = await runGit(shell, cwd, 'git diff HEAD -- ' + shq(path), 524288)
            writeJson(res, 200, { diff: diff.text === '' ? '(无 diff)' : diff.text })
            return
          }
          const light = url.searchParams.get('light') === '1'
          const payload = light
            ? { git: await collectGit(shell, sessions, sessionId) }
            : {
                git: await collectGit(shell, sessions, sessionId),
                mcp: collectMcp(tools),
                skills: await collectSkills(skills, agents, sessionId),
                model: await collectModel(apiProxy, sessionId),
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

async function runGit(shell, cwd, command, maxBytes) {
  const res = await shell.run(shell.resolve({ command, workdir: cwd, timeoutMs: GIT_TIMEOUT_MS, stdoutMaxBytes: maxBytes }))
  return {
    text: res.stdout && res.stdout.text ? res.stdout.text : '',
    exitCode: res.exitCode,
  }
}

/** Git 状态收集；非 git 仓库、超时、会话缺失一律返回 null（由界面灰显）。 */
async function collectGit(shell, sessions, sessionId) {
  if (typeof sessionId !== 'string') return null
  const session = sessions.get(sessionId)
  const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
  if (cwd === null) return null
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
    const res = await runGit(shell, cwd, command, 2097152)
    const segs = res.text.split(/__HUD_[BHSLN]__/)
    // segs: ['', branch, hash, status, numstat, log]
    const branchRaw = (segs[1] || '').trim()
    const hashRaw = (segs[2] || '').trim()
    if (branchRaw === '' && hashRaw === '') return null // 非 git 仓库
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
    return parsed
  } catch (error) {
    return null
  }
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
