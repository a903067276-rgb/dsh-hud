/**
 * dsh-hud — 官方余额拉取的策略与收集器（零依赖，可单测）
 *
 * 由 lib/index.js 抽取（2026-09-17，issue #10）：
 * 背景：余额接口地址硬编码为 DeepSeek 官方 `/user/balance`，凭据取 `DEEPSEEK_API_KEY`。
 * 当该 key 是中转/网关 key（如 `sk_tr_…`）时必然 401；旧实现失败后只缓存 60s，
 * 于是每 60s 重试一次、每次都 `console.warn` → 日志刷屏（面板关着时才不复现，
 * 因为余额只在 full 状态里取；详见 issue #10 的复现前提）。
 *
 * 现在的策略：
 *   1. `DSH_HUD_BALANCE=off` → 完全不请求、不告警（面板显示 `--`）
 *   2. 401/403 = 凭据不适用于官方端点 → 退避 30 分钟（不换 key 重试没有意义）
 *   3. 其他失败（网络 / 5xx / 超时）→ 退避 5 分钟
 *   4. 告警只在失败种类相对上次"翻转"时打一条（含首次），成功后退避状态复位
 *
 * 依赖（fetch / 时钟 / 环境 / 告警）全部可注入，所以单测能完整复现 issue #10 场景。
 */

/** 官方余额接口（下个版本再研究：如何支持非官方 / 中转 API 的余额显示）。 */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** 成功结果的常规缓存：60s（保持原行为）。 */
export const BALANCE_OK_CACHE_MS = 60 * 1000
/** 401/403（凭据不适用于官方端点）：长退避 30 分钟。 */
export const BALANCE_AUTH_BACKOFF_MS = 30 * 60 * 1000
/** 其他失败（网络 / 5xx / 超时）：5 分钟退避，别再每 60s 刷一遍日志。 */
export const BALANCE_ERROR_BACKOFF_MS = 5 * 60 * 1000
/** 单次请求超时。 */
export const BALANCE_TIMEOUT_MS = 5000

/**
 * 逃生开关：`DSH_HUD_BALANCE=off` → 完全不请求官方余额（面板显示 `--`），也不告警。
 * 大小写与首尾空白都容忍；其余值（含未设置）一律视为开启，保持向后兼容。
 */
export function isBalanceDisabled(env) {
  const raw = env === undefined || env === null ? undefined : env.DSH_HUD_BALANCE
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'off'
}

/**
 * 归类一次失败：401/403 = `'auth'`（凭据不适用于官方端点），其余（含无状态码的网络错误）= `'error'`。
 * 约定：调用方把 HTTP 状态码挂在 `error.status` 上。
 */
export function classifyBalanceFailure(error) {
  const status = error !== null && typeof error === 'object' ? error.status : undefined
  return status === 401 || status === 403 ? 'auth' : 'error'
}

/** 该失败种类对应的缓存 / 退避时长（毫秒）。 */
export function backoffFor(kind) {
  return kind === 'auth' ? BALANCE_AUTH_BACKOFF_MS : BALANCE_ERROR_BACKOFF_MS
}

/**
 * 是否打告警：只在失败种类相对上次"翻转"时打（首次失败也算，成功后再失败也算）。
 * @param {string|null|undefined} prevKind 上次状态：`undefined`=从未失败过、`'auth'`/`'error'`=上次失败种类
 * @param {'auth'|'error'} kind 本次失败种类
 */
export function shouldWarn(prevKind, kind) {
  return prevKind !== kind
}

/** 把 `/user/balance` 响应体解析成面板结构；形状不符返回 null（面板显示 `--`）。 */
export function parseBalance(data) {
  const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : undefined
  if (!info || typeof info.total_balance !== 'string') return null
  return {
    currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    total: Number(info.total_balance) || 0,
    granted: Number(info.granted_balance) || 0,
    toppedUp: Number(info.topped_up_balance) || 0,
    source: 'official',
  }
}

// ── 自定义（非官方）余额接口：2026-09-26 新增 ────────────────────────────────
// 背景：官方端点只认官方 key，用中转/网关 key 必然 401（issue #10）。用户要的
// 不是"换个写死的地址"，而是**自己能选**：关掉 / 官方 / 自定义。
// 自定义档只要求三件事：URL、token 放哪个头、余额在返回 JSON 的哪个位置。

/**
 * 按 `a.b[0].c` 形式的路径取 JSON 里的值；取不到返回 undefined。
 * 支持点号分段与数组下标，纯字符串键（不含特殊字符），够覆盖常见余额响应。
 */
export function getByPath(data, path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined
  const parts = []
  for (const rawSeg of path.trim().split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(rawSeg)
    if (m === null) return undefined
    if (m[1] !== '') parts.push(m[1])
    for (const idx of m[2].match(/\d+/g) ?? []) parts.push(Number(idx))
  }
  let cur = data
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[key]
  }
  return cur
}

/** 常见余额字段名（自定义档没给路径时，按这个顺序在顶层/一层里找第一个数字）。 */
const LOOSE_KEYS = [
  'total_available', 'total_balance', 'balance', 'totalBalance', 'total',
  'remain', 'remaining', 'available', 'credit', 'credits', 'quota', 'amount',
]

/** 没配路径时的宽松兜底：在 data / data.balance / data.data 里找第一个已知字段。 */
export function parseBalanceLoose(data) {
  const candidates = [data, data && data.data, data && data.balance, data && data.data && data.data.balance]
  for (const box of candidates) {
    if (box === null || typeof box !== 'object') continue
    if (Array.isArray(box) && box.length > 0) {
      const first = parseBalanceLoose(box[0])
      if (first !== null) return first
      continue
    }
    for (const key of LOOSE_KEYS) {
      const raw = box[key]
      const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
      if (Number.isFinite(num)) {
        return { currency: 'CNY', total: num, granted: 0, toppedUp: 0, source: 'custom' }
      }
    }
  }
  return null
}

/**
 * 自定义接口的响应解析：配了路径就按路径取（取到非数字返回 null，宁可显示 `--`
 * 也不显示错的数），没配路径就宽松找。
 * options.scale —— 单位换算：one-api 系 `data.quota` 是原始额度单位（每站不同，
 *   常见 500000 = 1 元或 1 美元），传 500000 就得到"元"。
 * options.subtractPath —— 再减去另一个字段：OpenRouter 余额 = total_credits − total_usage。
 */
export function parseBalanceCustom(data, path, options = {}) {
  const scaleRaw = Number(options.scale)
  const scale = Number.isFinite(scaleRaw) && scaleRaw !== 0 ? scaleRaw : 1
  const readNum = (p) => {
    const raw = getByPath(data, p)
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return Number.isFinite(num) ? num : undefined
  }
  if (typeof path === 'string' && path.trim() !== '') {
    let value = readNum(path)
    if (value === undefined) return null
    if (typeof options.subtractPath === 'string' && options.subtractPath.trim() !== '') {
      const sub = readNum(options.subtractPath)
      if (sub === undefined) return null
      value -= sub
    }
    return { currency: 'CNY', total: value / scale, granted: 0, toppedUp: 0, source: 'custom' }
  }
  const loose = parseBalanceLoose(data)
  return loose === null ? null : { ...loose, total: loose.total / scale }
}

/**
 * 常见服务的预设（2026-09-26 调研后加）：填一个名字就把 URL / 请求头 / 字段路径 /
 * 凭据变量 / 单位换算都带上——省得用户自己去翻各家文档。
 * 用户显式填的字段永远覆盖预设里的同名项。
 * 注意：one-api 系的 URL 每家不同（自建/中转站），必须自己填；它要的是**系统访问令牌**，
 * 不是 sk- 推理 key；`data.quota` 还得按站点的兑换比例换算（默认按 50 万/元）。
 */
export const BALANCE_PRESETS = {
  deepseek: { mode: 'official' },
  kimi: {
    mode: 'custom', url: 'https://api.moonshot.cn/v1/users/me/balance', header: 'authorization',
    path: 'data.available_balance', tokenEnv: 'MOONSHOT_API_KEY', currency: '$',
  },
  siliconflow: {
    mode: 'custom', url: 'https://api.siliconflow.cn/v1/user/info', header: 'authorization',
    path: 'data.totalBalance', tokenEnv: 'SILICONFLOW_API_KEY',
  },
  openrouter: {
    mode: 'custom', url: 'https://openrouter.ai/api/v1/credits', header: 'authorization',
    path: 'data.total_credits', subtractPath: 'data.total_usage', tokenEnv: 'OPENROUTER_API_KEY', currency: '$',
  },
  'one-api': {
    mode: 'custom', url: '', header: 'authorization', path: 'data.quota', scale: 500000,
  },
  zai: {
    mode: 'custom', url: 'https://api.z.ai/api/biz/account/query-customer-account-report', header: 'authorization',
    path: 'data.availableBalance', tokenEnv: 'ZAI_API_KEY',
  },
}

/** 失败告警文案（只在状态翻转时打一条，所以写清楚原因与出路）。 */
export function balanceFailureMessage(kind, error, context) {
  const detail = error instanceof Error ? error.message : String(error)
  const mins = Math.round(backoffFor(kind) / 60000)
  const where = context && context.mode === 'custom' && typeof context.url === 'string' && context.url !== ''
    ? '自定义余额接口（' + context.url + '）'
    : 'DeepSeek 官方余额接口'
  if (kind === 'auth') {
    return '[dsh-hud] balance unavailable: 凭据不适用于 ' + where + '（' + detail + '）——'
      + '官方余额只认官方 key；用中转/自建网关的话请在插件配置里把 balanceMode 设成 custom 并填 balanceUrl（或设成 off 不显示）。'
      + mins + ' 分钟内不再重试'
  }
  return '[dsh-hud] balance failed（' + where + '）: ' + detail + '（' + mins + ' 分钟内不再重试）'
}

/**
 * 余额收集器：内部持有缓存与退避状态。依赖可注入（fetch / 时钟 / 环境 / 告警），
 * 便于在单测里复现"中转 key 每 60s 刷屏"的 issue #10 场景。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 请求实现（默认全局 fetch）
 * @param {(message: string) => void} [options.warn] 告警出口（默认 console.warn）
 * @param {() => number} [options.now] 时钟（默认 Date.now）
 * @param {() => Record<string, string|undefined>} [options.env] 环境变量读取（默认 process.env）
 * @param {string} [options.url] 余额接口地址（默认官方地址）
 * @param {number} [options.timeoutMs] 单次请求超时
 */
export function createBalanceCollector(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const warn = options.warn ?? ((message) => console.warn(message))
  const now = options.now ?? (() => Date.now())
  const env = options.env ?? (() => process.env)
  const url = options.url ?? BALANCE_URL
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS

  // value: undefined=未取过 / null=失败或不可用 / 对象=成功值；ttl 随结果种类变化
  let cache = { at: 0, value: undefined, ttl: BALANCE_OK_CACHE_MS }
  let failKind // undefined=未失败过（或上次成功）；'auth'|'error'=上次失败种类
  let lastSignature = '' // 模式/地址/头/路径一变就作废旧缓存（换配置立即生效，不用等 TTL）
  const warnedOnce = new Set() // 配置类问题（地址不安全 / 路径解析不到）只唠叨一次
  const warnOnce = (key, message) => {
    if (warnedOnce.has(key)) return
    warnedOnce.add(key)
    warn(message)
  }

  /** 自定义地址安全闸：必须 https（本机 / 内网地址放行），免得明文把 key 送出去。 */
  function isSafeCustomUrl(target) {
    if (target.startsWith('https://')) return true
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(target)
  }

  /**
   * 取一次余额（命中缓存直接返回）。
   * @param {() => Promise<string|null>} resolveKey 解析凭据（无凭据返回 null）
   * @param {object} [call] 本次调用的模式与自定义参数（2026-09-26 新增）
   *   mode: 'off' | 'official' | 'custom'
   *   url: custom 模式的完整接口地址
   *   header: custom 模式放 token 的请求头名（默认 authorization → Bearer <key>）
   *   path: custom 模式取余额的 JSON 路径（留空则宽松找常见字段）
   *   currency: 显示用货币符号（留空沿用响应里的）
   */
  async function collect(resolveKey, call = {}) {
    const mode = call.mode === 'off' || call.mode === 'custom' || call.mode === 'official' ? call.mode : 'official'
    // off 档 + 老逃生开关（DSH_HUD_BALANCE=off）都不请求、不告警
    if (mode === 'off' || isBalanceDisabled(env())) return null
    const targetUrl = mode === 'custom' ? String(call.url ?? '') : url
    if (targetUrl === '') return null // custom 档没填地址 = 当关掉，不猜
    const headerName = mode === 'custom' && typeof call.header === 'string' && call.header.trim() !== ''
      ? call.header.trim()
      : 'authorization'
    const path = mode === 'custom' ? call.path : undefined
    // 签名要覆盖所有影响结果的自定义参数：少了换算/相减/额外头，改配置后 60 秒内会拿到旧缓存
    const signature = [mode, targetUrl, headerName, path ?? '', call.scale ?? '', call.subtractPath ?? '', call.extraHeader ?? ''].join('|')
    if (signature !== lastSignature) {
      lastSignature = signature
      cache = { at: 0, value: undefined, ttl: BALANCE_OK_CACHE_MS }
      failKind = undefined
    }
    const t = now()
    if (cache.value !== undefined && t - cache.at < cache.ttl) return cache.value
    if (mode === 'custom' && !isSafeCustomUrl(targetUrl)) {
      warnOnce('unsafe|' + targetUrl, '[dsh-hud] balance: 自定义余额地址必须是 https（本机/内网地址除外），'
        + '已跳过请求以免明文送出凭据：' + targetUrl)
      cache = { at: t, value: null, ttl: BALANCE_ERROR_BACKOFF_MS }
      return null
    }
    try {
      const key = await resolveKey()
      if (key === null || key === undefined || key === '') {
        cache = { at: t, value: null, ttl: BALANCE_OK_CACHE_MS }
        return null
      }
      const headers = { accept: 'application/json' }
      headers[headerName] = headerName.toLowerCase() === 'authorization' ? 'Bearer ' + key : key
      // 第二个自定义头（DMXAPI 这类要 `Dmx-Api-User: <用户ID>`）：写成 "Name: value"
      if (mode === 'custom' && typeof call.extraHeader === 'string' && call.extraHeader.includes(':')) {
        const at = call.extraHeader.indexOf(':')
        const name = call.extraHeader.slice(0, at).trim()
        const value = call.extraHeader.slice(at + 1).trim()
        if (name !== '') headers[name] = value
      }
      const res = await fetchImpl(targetUrl, {
        headers,
        // 安全（2026-09-26）：不跟随重定向——否则 302 能把 Authorization 带去别的域；
        // key 只走请求头，任何时候都不拼进 URL。
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const error = new Error('HTTP ' + res.status)
        error.status = res.status
        throw error
      }
      const body = await res.json()
      const value = mode === 'custom'
        ? parseBalanceCustom(body, path, { scale: call.scale, subtractPath: call.subtractPath })
        : parseBalance(body)
      if (value !== null && typeof call.currency === 'string' && call.currency !== '') value.currency = call.currency
      if (value === null) {
        // 200 但没有余额字段：one-api 系出错时会这么回（success:false），
        // 不告警的话排查看不到原因（2026-09-26 调研结论）
        warnOnce('parse|' + signature, '[dsh-hud] balance: 接口返回 200 但没解析出余额——检查 balancePath'
          + '（one-api 系失败时会返回 200 + success:false）；地址：' + targetUrl)
      }
      cache = { at: now(), value, ttl: BALANCE_OK_CACHE_MS }
      failKind = undefined // 成功 → 状态复位，之后再失败会重新告警一次
      return value
    } catch (error) {
      const kind = classifyBalanceFailure(error)
      if (shouldWarn(failKind, kind)) warn(balanceFailureMessage(kind, error, { mode, url: targetUrl }))
      failKind = kind
      cache = { at: now(), value: null, ttl: backoffFor(kind) }
      return null
    }
  }

  return { collect }
}
