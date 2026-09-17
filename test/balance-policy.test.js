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
  assert.match(h.warns[0], /不适用于 DeepSeek 官方余额接口/)
  assert.match(h.warns[0], /DSH_HUD_BALANCE=off/)
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
  assert.deepEqual(value, { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34 })
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
  assert.match(h.warns[0], /\[dsh-hud\] balance failed: fetch failed/)
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
  assert.deepEqual(await h.collector.collect(KEY), { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34 })
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
  assert.deepEqual(parseBalance(BALANCE_BODY), { currency: 'CNY', total: 12.34, granted: 1, toppedUp: 11.34 })
})

test('parseBalance：形状不符 → null（面板显示 --，不炸）', () => {
  assert.equal(parseBalance(undefined), null)
  assert.equal(parseBalance({}), null)
  assert.equal(parseBalance({ balance_infos: [] }), null)
  assert.equal(parseBalance({ balance_infos: [{ total_balance: 123 }] }), null)
})
