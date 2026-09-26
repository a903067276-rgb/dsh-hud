import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALANCE_OK_CACHE_MS,
  BALANCE_AUTH_BACKOFF_MS,
  BALANCE_ERROR_BACKOFF_MS,
  isBalanceDisabled,
  classifyBalanceFailure,
  backoffFor,
  shouldWarn,
  parseBalance,
  parseBalanceCustom,
  getByPath,
  BALANCE_PRESETS,
  createBalanceCollector,
} from '../lib/balance-policy.js'

// ── 测试替身 ──────────────────────────────────────────────────────────────

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1.00', topped_up_balance: '11.34' }],
}

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

function harness(impl, opts = {}) {
  const clock = fakeClock()
  const warns = []
  let fetches = 0
  const collector = createBalanceCollector({
    fetchImpl: async (...args) => { fetches++; return impl(...args) },
    warn: (m) => warns.push(m),
    now: clock.now,
    env: () => opts.env ?? {},
    timeoutMs: 50,
  })
  return { collector, clock, warns, fetchCount: () => fetches }
}

const KEY = async () => 'sk_tr_fake' // 中转 / 网关 key：打官方端点必然 401

// ── 逃生开关（issue #10 建议 1）───────────────────────────────────────────

test('DSH_HUD_BALANCE=off → 关闭（大小写与空白容忍）', () => {
  assert.equal(isBalanceDisabled({ DSH_HUD_BALANCE: 'off' }), true)
  assert.equal(isBalanceDisabled({ DSH_HUD_BALANCE: 'OFF' }), true)
  assert.equal(isBalanceDisabled({ DSH_HUD_BALANCE: '  off  ' }), true)
})

test('未设置或非 off → 保持开启（向后兼容）', () => {
  assert.equal(isBalanceDisabled({}), false)
  assert.equal(isBalanceDisabled({ DSH_HUD_BALANCE: 'on' }), false)
  assert.equal(isBalanceDisabled({ DSH_HUD_BALANCE: '' }), false)
  assert.equal(isBalanceDisabled(undefined), false)
})

test('DSH_HUD_BALANCE=off → 不请求、不告警、返回 null', async () => {
  const h = harness(async () => res(401, {}), { env: { DSH_HUD_BALANCE: 'off' } })
  assert.equal(await h.collector.collect(KEY), null)
  assert.equal(h.fetchCount(), 0)
  assert.equal(h.warns.length, 0)
})

// ── 失败归类与退避 ────────────────────────────────────────────────────────

test('401/403 → auth；其他状态与网络错误 → error', () => {
  assert.equal(classifyBalanceFailure({ status: 401 }), 'auth')
  assert.equal(classifyBalanceFailure({ status: 403 }), 'auth')
  assert.equal(classifyBalanceFailure({ status: 500 }), 'error')
  assert.equal(classifyBalanceFailure(new Error('fetch failed')), 'error')
  assert.equal(classifyBalanceFailure(undefined), 'error')
})

test('退避时长：auth 30 分钟 / error 5 分钟 / 成功 60 秒', () => {
  assert.equal(BALANCE_OK_CACHE_MS, 60 * 1000)
  assert.equal(backoffFor('auth'), BALANCE_AUTH_BACKOFF_MS)
  assert.equal(BALANCE_AUTH_BACKOFF_MS / 60000, 30)
  assert.equal(backoffFor('error'), BALANCE_ERROR_BACKOFF_MS)
  assert.equal(BALANCE_ERROR_BACKOFF_MS / 60000, 5)
})

test('shouldWarn：同类不重复、翻转才告警', () => {
  assert.equal(shouldWarn(undefined, 'auth'), true)
  assert.equal(shouldWarn('auth', 'auth'), false)
  assert.equal(shouldWarn('error', 'auth'), true)
  assert.equal(shouldWarn('auth', 'error'), true)
})

// ── 收集器：issue #10 的原始场景（面板开着 → 每 60s 一次 full 请求）─────────

test('回归（issue #10）：中转 key 每 60s 轮询 30 分钟，只 1 条告警、只 1 次请求', async () => {
  const h = harness(async () => res(401, { message: 'Authentication Fails' }))
  for (let i = 0; i < 30; i++) {
    assert.equal(await h.collector.collect(KEY), null)
    h.clock.advance(60 * 1000) // 客户端每 60s 拉一次 full（旧实现每次都 warn → 刷屏）
  }
  assert.equal(h.warns.length, 1, '30 分钟内只应告警一次')
  assert.equal(h.fetchCount(), 1, '退避期内不应重复请求')
  assert.match(h.warns[0], /凭据不适用于 DeepSeek 官方余额接口/)
  assert.match(h.warns[0], /balanceMode/)          // 2026-09-26：告警里给出路（改用 custom 或 off）
  assert.match(h.warns[0], /（或设成 off 不显示）/)
})

test('退避到期后才重试，且同类失败不再告警', async () => {
  const h = harness(async () => res(401, {}))
  await h.collector.collect(KEY) // t=1s，首次失败 → 告警 1
  h.clock.advance(BALANCE_AUTH_BACKOFF_MS - 1000)
  await h.collector.collect(KEY) // 仍在退避内
  assert.equal(h.fetchCount(), 1)
  h.clock.advance(2000) // 越过 30 分钟
  await h.collector.collect(KEY)
  assert.equal(h.fetchCount(), 2, '退避到期应重试')
  assert.equal(h.warns.length, 1, '同类失败不重复告警')
})

test('失败 → 成功 → 再失败：告警重新计一次，且成功后 60s 内走缓存', async () => {
  let mode = 'auth'
  const h = harness(async () => (mode === 'auth' ? res(401, {}) : res(200, BALANCE_BODY)))
  await h.collector.collect(KEY) // 401 → 告警 1
  assert.equal(h.warns.length, 1)
  h.clock.advance(BALANCE_AUTH_BACKOFF_MS) // 等退避到期
  mode = 'ok'
  const value = await h.collector.collect(KEY)
  assert.deepEqual(value, { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34, source: 'official' })
  assert.equal(h.warns.length, 1, '成功不告警')
  h.clock.advance(BALANCE_OK_CACHE_MS - 1000)
  await h.collector.collect(KEY)
  assert.equal(h.fetchCount(), 2, '成功值 60s 内走缓存')
  h.clock.advance(2000)
  mode = 'auth'
  await h.collector.collect(KEY) // 复位后再失败 → 重新告警
  assert.equal(h.warns.length, 2)
})

test('网络错误：5 分钟退避 + error 文案（与 401 区分）', async () => {
  const h = harness(async () => { throw new Error('fetch failed') })
  assert.equal(await h.collector.collect(KEY), null)
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0], /\[dsh-hud\] balance failed（DeepSeek 官方余额接口）: fetch failed/)
  assert.match(h.warns[0], /5 分钟内不再重试/)
  h.clock.advance(BALANCE_ERROR_BACKOFF_MS - 1000)
  await h.collector.collect(KEY)
  assert.equal(h.fetchCount(), 1, '5 分钟退避生效')
})

test('无凭据：不请求、不告警；60s 后可再试（用户可能刚配置好 key）', async () => {
  const h = harness(async () => res(200, BALANCE_BODY))
  assert.equal(await h.collector.collect(async () => null), null)
  assert.equal(h.fetchCount(), 0)
  assert.equal(h.warns.length, 0)
  h.clock.advance(BALANCE_OK_CACHE_MS + 1000)
  assert.deepEqual(await h.collector.collect(KEY), { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34, source: 'official' })
})

test('请求带上 Bearer 凭据', async () => {
  let seen
  const h = harness(async (url, init) => { seen = { url, init }; return res(200, BALANCE_BODY) })
  await h.collector.collect(KEY)
  assert.match(seen.url, /^https:\/\/api\.deepseek\.com\/user\/balance$/)
  assert.equal(seen.init.headers.authorization, 'Bearer sk_tr_fake')
})

// ── 响应解析 ──────────────────────────────────────────────────────────────

test('parseBalance：正常形状解析出数值', () => {
  assert.deepEqual(parseBalance(BALANCE_BODY), { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34, source: 'official' })
})

test('parseBalance：形状不符 → null（面板显示 --，不炸）', () => {
  assert.equal(parseBalance(undefined), null)
  assert.equal(parseBalance({}), null)
  assert.equal(parseBalance({ balance_infos: [] }), null)
  assert.equal(parseBalance({ balance_infos: [{ total_balance: 123 }] }), null)
})

// ── 自定义（非官方）余额接口（2026-09-26 新增）──────────────────────────────

test('getByPath：点号 + 数组下标取值', () => {
  const data = { data: { balance: 5, list: [{ total_available: '9.5' }] }, balance_infos: [{ total_balance: '1' }] }
  assert.equal(getByPath(data, 'data.balance'), 5)
  assert.equal(getByPath(data, 'data.list[0].total_available'), '9.5')
  assert.equal(getByPath(data, 'balance_infos[0].total_balance'), '1')
  assert.equal(getByPath(data, 'data.nope.deep'), undefined)
  assert.equal(getByPath(data, ''), undefined)
})

test('parseBalanceCustom：配了路径按路径取；非数字 → null（宁显示 -- 不显示错数）', () => {
  assert.deepEqual(parseBalanceCustom({ data: { balance: 12.34 } }, 'data.balance'),
    { currency: 'CNY', total: 12.34, granted: 0, toppedUp: 0, source: 'custom' })
  assert.deepEqual(parseBalanceCustom({ data: { credits: '7.00' } }, 'data.credits').total, 7)
  assert.equal(parseBalanceCustom({ data: { msg: 'no number' } }, 'data.balance'), null)
})

test('parseBalanceCustom：没配路径 → 宽松找常见字段（balance / total_available / data.balance）', () => {
  assert.equal(parseBalanceCustom({ balance: 3 }, '').total, 3)
  assert.equal(parseBalanceCustom({ data: { total_available: '8' } }, '').total, 8)
  // 只找一层嵌套（data / data.balance / data.data.balance），再深的组合不猜——宁可显示 --
  assert.equal(parseBalanceCustom({ data: { data: { balance: 4 } } }, ''), null)
  assert.equal(parseBalanceCustom({ nothing: 'here' }, ''), null)
})

test('collector：custom 档走自定义地址与请求头；off 档一次都不请求', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return { ok: true, status: 200, json: async () => ({ data: { balance: 42 } }) }
  }
  const c = createBalanceCollector({ fetchImpl, env: () => ({}) })
  const key = async () => 'gw-key'

  assert.equal(await c.collect(key, { mode: 'off' }), null)
  assert.equal(calls.length, 0, 'off 档不该发请求')

  const value = await c.collect(key, { mode: 'custom', url: 'https://gw.example.com/api/user/self', path: 'data.balance', header: 'x-api-key' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gw.example.com/api/user/self')
  assert.equal(calls[0].headers['x-api-key'], 'gw-key')
  assert.equal(value.total, 42)
  assert.equal(value.source, 'custom')

  // 没填地址 → 当关掉，不请求
  calls.length = 0
  assert.equal(await c.collect(key, { mode: 'custom', url: '' }), null)
  assert.equal(calls.length, 0)
})

test('parseBalanceCustom：单位换算（one-api 的 quota 要除以兑换比例）', () => {
  assert.equal(parseBalanceCustom({ data: { quota: 2500000 } }, 'data.quota', { scale: 500000 }).total, 5)
  assert.equal(parseBalanceCustom({ data: { quota: 2500000 } }, 'data.quota', { scale: 1000000 }).total, 2.5)
  assert.equal(parseBalanceCustom({ data: { quota: 2500000 } }, 'data.quota').total, 2500000) // 不填比例就不换算
})

test('parseBalanceCustom：两字段相减（OpenRouter 余额 = 总额 − 已用）', () => {
  assert.equal(parseBalanceCustom({ data: { total_credits: 30, total_usage: 12.5 } }, 'data.total_credits', { subtractPath: 'data.total_usage' }).total, 17.5)
  assert.equal(parseBalanceCustom({ data: { total_credits: 30 } }, 'data.total_credits', { subtractPath: 'data.total_usage' }), null) // 缺字段 → --，不糊弄
})

test('BALANCE_PRESETS：填了名字就能带出 URL / 路径 / 凭据变量（各家文档里的真实值）', () => {
  assert.equal(BALANCE_PRESETS.kimi.url, 'https://api.moonshot.cn/v1/users/me/balance')
  assert.equal(BALANCE_PRESETS.kimi.path, 'data.available_balance')
  assert.equal(BALANCE_PRESETS.kimi.tokenEnv, 'MOONSHOT_API_KEY')
  assert.equal(BALANCE_PRESETS.openrouter.subtractPath, 'data.total_usage')
  assert.equal(BALANCE_PRESETS['one-api'].scale, 500000)
  assert.equal(BALANCE_PRESETS['one-api'].url, '') // 每家地址不同，必须用户自己填
  assert.equal(BALANCE_PRESETS.deepseek.mode, 'official')
})
