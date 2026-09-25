// 版本来源链测试（2026-09-25）
//
// 背景：桌面版 App 的 PATH 里没有 `dsh`，"shell 跑 dsh --version" 那条老路在桌面端
// 必然失败（版本号空白）。新逻辑先问宿主（官方 getDshRuntimeVersion），拿不到才回落
// shell。本测试用测试替身覆盖整条优先级链与缓存语义。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDshVersion, createVersionCollector } from '../lib/version-source.js'

// ── 测试替身 ──────────────────────────────────────────────────────────────

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

function spy(value) {
  const calls = { count: 0 }
  return {
    calls,
    fn: async () => { calls.count++; return value },
  }
}

function failing(message) {
  const calls = { count: 0 }
  return {
    calls,
    fn: async () => { calls.count++; throw new Error(message) },
  }
}

// ── 优先级链 ──────────────────────────────────────────────────────────────

test('宿主自报成功时采用它，且不再回落 shell', async () => {
  const host = spy('0.1.7-rc.2')
  const shell = spy('9.9.9-shell')
  const value = await resolveDshVersion({ hostVersion: host.fn, shellVersion: shell.fn })
  assert.equal(value, '0.1.7-rc.2')
  assert.equal(host.calls.count, 1)
  assert.equal(shell.calls.count, 0, '宿主成功就不该再跑 shell（省一次子进程）')
})

test('宿主抛错时回落 shell，并对宿主失败告警一条', async () => {
  const host = failing('Cannot find module')
  const shell = spy('0.1.7-rc.2')
  const warnings = []
  const value = await resolveDshVersion({
    hostVersion: host.fn,
    shellVersion: shell.fn,
    warn: (message) => warnings.push(message),
  })
  assert.equal(value, '0.1.7-rc.2')
  assert.equal(shell.calls.count, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /host version failed/)
  assert.match(warnings[0], /Cannot find module/)
})

test('宿主返回空串或纯空白视为失败，继续回落', async () => {
  for (const bad of ['', '   ', '\n']) {
    const shell = spy('0.1.7-rc.2')
    const value = await resolveDshVersion({ hostVersion: async () => bad, shellVersion: shell.fn })
    assert.equal(value, '0.1.7-rc.2', `宿主返回 ${JSON.stringify(bad)} 时应回落`)
    assert.equal(shell.calls.count, 1)
  }
})

test('宿主返回非字符串视为失败，继续回落', async () => {
  for (const bad of [null, undefined, 42, {}]) {
    const shell = spy('0.1.7-rc.2')
    const value = await resolveDshVersion({ hostVersion: async () => bad, shellVersion: shell.fn })
    assert.equal(value, '0.1.7-rc.2')
  }
})

test('版本号两端空白被裁掉', async () => {
  const value = await resolveDshVersion({ hostVersion: async () => '  0.1.7-rc.2\n' })
  assert.equal(value, '0.1.7-rc.2')
})

test('两路都失败返回 null，且各告警一条', async () => {
  const warnings = []
  const value = await resolveDshVersion({
    hostVersion: failing('no module').fn,
    shellVersion: failing('command not found').fn,
    warn: (message) => warnings.push(message),
  })
  assert.equal(value, null)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /host version failed/)
  assert.match(warnings[1], /shell version failed/)
})

test('缺省的来源被跳过（没有 shell 服务时仍能靠宿主自报）', async () => {
  const value = await resolveDshVersion({ hostVersion: async () => '0.1.7-rc.2' })
  assert.equal(value, '0.1.7-rc.2')
  assert.equal(await resolveDshVersion({}), null)
})

// ── 缓存 ──────────────────────────────────────────────────────────────────

test('缓存窗口内不重复取数', async () => {
  const clock = fakeClock()
  const host = spy('0.1.7-rc.2')
  const collector = createVersionCollector({ hostVersion: host.fn, now: clock.now, cacheMs: 60000 })
  assert.equal(await collector.collect(), '0.1.7-rc.2')
  clock.advance(59999)
  assert.equal(await collector.collect(), '0.1.7-rc.2')
  assert.equal(host.calls.count, 1, '窗口内应命中缓存')
  clock.advance(2)
  assert.equal(await collector.collect(), '0.1.7-rc.2')
  assert.equal(host.calls.count, 2, '窗口过后应重新取数')
})

test('失败结果（null）同样缓存，避免反复空跑', async () => {
  const clock = fakeClock()
  const host = failing('no module')
  const shell = failing('command not found')
  const collector = createVersionCollector({ hostVersion: host.fn, shellVersion: shell.fn, now: clock.now })
  assert.equal(await collector.collect(), null)
  assert.equal(await collector.collect(), null)
  assert.equal(host.calls.count, 1)
  assert.equal(shell.calls.count, 1)
})

test('collect(context) 把 context 原样透传给 shell 取数函数', async () => {
  const seen = []
  const shellService = { tag: 'shell-service' }
  const collector = createVersionCollector({
    hostVersion: async () => { throw new Error('unavailable') },
    shellVersion: async (context) => { seen.push(context); return '0.1.7-rc.2' },
    now: fakeClock().now,
  })
  assert.equal(await collector.collect(shellService), '0.1.7-rc.2')
  assert.deepEqual(seen, [shellService])
})
