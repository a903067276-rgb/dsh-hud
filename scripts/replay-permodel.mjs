/**
 * perModelUsage 投影单元重放验证脚本（零依赖）
 *
 * 用法：node scripts/replay-permodel.mjs <session.jsonl 路径>
 *
 * 对真实会话日志重放 lib/index.js 里的 perModelUsageProjection，并与脚本内
 * 独立的参照折叠（同样的"同一轮步替换"语义）逐项对账，任何不一致即失败退出。
 */
import { readFileSync } from 'node:fs'
import { perModelUsageProjection } from '../lib/index.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/replay-permodel.mjs <session.jsonl 路径>')
  process.exit(2)
}

const events = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  try {
    events.push(JSON.parse(line))
  } catch { /* skip malformed */ }
}

// ── 参照折叠（独立实现，同一替换语义）──────────────────────────
const ref = { currentModel: null, last: null, models: {} }
function refAdd(model, key, delta) {
  const e = ref.models[model] ?? { requests: 0, uncachedInput: 0, cacheRead: 0, output: 0 }
  e[key] += delta
  ref.models[model] = e
}
for (const ev of events) {
  if (ev.type === 'request/header') {
    const model = ev.data?.header?.config?.model
    if (typeof model === 'string' && model !== '') {
      ref.currentModel = model
      refAdd(model, 'requests', 1)
    }
    continue
  }
  let usage = null
  let turn = null
  let step = null
  if (ev.type === 'assistant/chunk') {
    const chunk = ev.data?.chunk
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      usage = chunk.usage
      turn = ev.data.turn
      step = ev.data.step
    }
  } else if (ev.type === 'assistant/message') {
    usage = ev.data?.usage
    turn = ev.data.turn
    step = ev.data.step
  }
  if (usage === null) continue
  const model = ref.currentModel ?? 'unknown'
  const input = Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0
  const cache = Number.isFinite(usage.cacheReadTokens) && usage.cacheReadTokens > 0 ? usage.cacheReadTokens : 0
  const output = Number.isFinite(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0
  if (input + cache + output === 0) continue
  if (ref.last !== null && ref.last.turn === turn && ref.last.step === step) {
    refAdd(ref.last.model, 'uncachedInput', -ref.last.input)
    refAdd(ref.last.model, 'cacheRead', -ref.last.cache)
    refAdd(ref.last.model, 'output', -ref.last.output)
  }
  refAdd(model, 'uncachedInput', input)
  refAdd(model, 'cacheRead', cache)
  refAdd(model, 'output', output)
  ref.last = { turn, step, model, input, cache, output }
}

// ── 投影单元重放 ──────────────────────────────────────────────
let state = perModelUsageProjection.init()
for (const ev of events) {
  state = perModelUsageProjection.apply(state, ev)
}
const view = perModelUsageProjection.view(state)

// ── 对账 ──────────────────────────────────────────────────────
const refByName = Object.fromEntries(Object.entries(ref.models).map(([m, e]) => [m, {
  requests: e.requests, uncachedInput: e.uncachedInput, cacheRead: e.cacheRead, output: e.output,
}]))

let ok = true
const fail = (msg) => { ok = false; console.error('✗ ' + msg) }

const names = new Set([...view.models.map((m) => m.model), ...Object.keys(refByName)])
for (const name of names) {
  const a = view.models.find((m) => m.model === name) ?? { requests: 0, uncachedInput: 0, cacheRead: 0, output: 0 }
  const b = refByName[name] ?? { requests: 0, uncachedInput: 0, cacheRead: 0, output: 0 }
  for (const field of ['requests', 'uncachedInput', 'cacheRead', 'output']) {
    if (a[field] !== b[field]) fail(`${name}.${field}: 单元=${a[field]} 参照=${b[field]}`)
  }
}

// 总量打印
const totals = { uncachedInput: 0, cacheRead: 0, output: 0, requests: 0 }
for (const m of view.models) {
  totals.uncachedInput += m.uncachedInput
  totals.cacheRead += m.cacheRead
  totals.output += m.output
  totals.requests += m.requests
}
console.log('事件总数:', events.length)
console.log('分模型明细:')
for (const m of view.models) {
  console.log(`  ${m.model}: 请求 ${m.requests} | 未缓存输入 ${m.uncachedInput} | 缓存读 ${m.cacheRead} | 输出 ${m.output} | 缓存率 ${m.cacheHitPct}%`)
}
console.log('合计: 请求', totals.requests, '| 未缓存输入', totals.uncachedInput, '| 缓存读', totals.cacheRead, '| 输出', totals.output)

if (!ok) {
  console.error('\n✗ 对账失败')
  process.exit(1)
}
console.log('\n✓ 与参照折叠完全一致')
