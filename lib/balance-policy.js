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
  }
}

/** 失败告警文案（只在状态翻转时打一条，所以写清楚原因与出路）。 */
export function balanceFailureMessage(kind, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const mins = Math.round(backoffFor(kind) / 60000)
  if (kind === 'auth') {
    return '[dsh-hud] balance unavailable: 该凭据（DEEPSEEK_API_KEY）不适用于 DeepSeek 官方余额接口（'
      + detail + '）——官方余额仅支持官方 key，不影响面板其他信息；'
      + '不需要可设 DSH_HUD_BALANCE=off 关闭该请求。' + mins + ' 分钟内不再重试'
  }
  return '[dsh-hud] balance failed: ' + detail + '（' + mins + ' 分钟内不再重试）'
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

  /**
   * 取一次余额（命中缓存直接返回）。
   * @param {() => Promise<string|null>} resolveKey 解析凭据（无凭据返回 null）
   */
  async function collect(resolveKey) {
    if (isBalanceDisabled(env())) return null
    const t = now()
    if (cache.value !== undefined && t - cache.at < cache.ttl) return cache.value
    try {
      const key = await resolveKey()
      if (key === null || key === undefined || key === '') {
        cache = { at: t, value: null, ttl: BALANCE_OK_CACHE_MS }
        return null
      }
      const res = await fetchImpl(url, {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        const error = new Error('HTTP ' + res.status)
        error.status = res.status
        throw error
      }
      const value = parseBalance(await res.json())
      cache = { at: now(), value, ttl: BALANCE_OK_CACHE_MS }
      failKind = undefined // 成功 → 状态复位，之后再失败会重新告警一次
      return value
    } catch (error) {
      const kind = classifyBalanceFailure(error)
      if (shouldWarn(failKind, kind)) warn(balanceFailureMessage(kind, error))
      failKind = kind
      cache = { at: now(), value: null, ttl: backoffFor(kind) }
      return null
    }
  }

  return { collect }
}
