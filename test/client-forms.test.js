// 客户端形态注册冒烟测试（2026-09-10 新增）
//
// 背景：hud 1.4.0 起面板有两种穿法——官方右栏标签页（0.1.5+）与浮窗（旧宿主回退）。
// 本测试用「模拟 React + 假 ctx」把 lib/client.js 真正 apply 一遍，验证：
//   ① 形态裁决分支正确（tab 能力在 → 注册 tab；不在 → 回落浮窗；off → 都不注册）
//   ② 两段式注册参数正确（类型 id/kind + body 的 key 必须一致）
//   ③ 面板组件在两种 variant 下都能跑完（抓引用错误/未定义变量）
// 纯离线，不联网、不触碰任何运行中的 dsh 实例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(SRC, 'utf8')

/** 最小 React 替身：hooks 按调用顺序返回稳定值，createElement 产出可检查的树节点。 */
function mockReact() {
  let hookIndex = 0
  const state = []
  const effects = []
  const api = {
    Fragment: Symbol('Fragment'),
    // 与真实 React 一致：children 既挂在 props.children，也留一份 .children 方便断言
    createElement(type, props, ...children) {
      const flat = children.flat()
      const merged = Object.assign({}, props || {})
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      return { type, props: merged, children: flat }
    },
    // 支持写入：模拟 React 的 hook 槽位（同一组件重复渲染时按序复用）
    useState(initial) {
      const i = hookIndex++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next }]
    },
    useRef(initial) { hookIndex++; return { current: initial } },
    useEffect(fn) { hookIndex++; effects.push(fn) },
    useSyncExternalStore(_subscribe, getSnapshot) { hookIndex++; return getSnapshot() },
    __reset() { hookIndex = 0; effects.length = 0 },
  }
  return api
}

/** 造一个假 ctx，记录插件对它做了什么。 */
function fakeCtx({ withSidebar = true } = {}) {
  const calls = { tabTypes: [], injects: [], registrations: [], effects: [] }
  const slots = {
    // inject 是「等目标槽出现再注册」的惰性包装：测试里立即执行，只记录注入点
    inject(name, fn) { calls.injects.push(name); return fn() },
    register(options, component) {
      calls.registrations.push({ name: options.name, key: options.key, id: options.id, component })
      return () => {}
    },
  }
  const sidebarRightTabs = withSidebar
    ? { register(def) { calls.tabTypes.push(def); return () => {} } }
    : undefined
  const sidebarRight = withSidebar ? { openTab() {}, close() {} } : undefined
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'timer') return undefined
      if (name === 'sidebarRightTabs') return sidebarRightTabs
      if (name === 'sidebarRight') return sidebarRight
      return undefined
    },
    effect(fn) { calls.effects.push(fn); return fn() },
  }
  return { ctx, calls }
}

/** 把 lib/client.js 在受控的 window/document 下加载出来，拿到 { apply, inject }。 */
function loadClient({ panelMode, withSidebar = true } = {}) {
  const store = new Map()
  if (panelMode !== undefined) store.set('dsh-hud-panel-mode', panelMode)

  let captured = null
  const win = {
    __ModuleLoader__: { load(def) { captured = def } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true },
    innerWidth: 1440, innerHeight: 900,
  }
  const doc = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', style: {} }),
    head: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
  }

  const previous = { window: globalThis.window, document: globalThis.document, Event: globalThis.Event }
  globalThis.window = win
  globalThis.document = doc
  if (typeof globalThis.Event !== 'function') {
    globalThis.Event = class Event { constructor(type) { this.type = type } }
  }
  try {
    // 客户端 bundle 以 window.__ModuleLoader__.load({id, factory}) 形式注册自己
    new Function('window', 'document', source)(win, doc)
    assert.ok(captured !== null, '客户端模块没有通过 __ModuleLoader__ 注册')
    const react = mockReact()
    const mod = captured.factory((name) => {
      if (name === 'react') return react
      throw new Error('意外的 require: ' + name)
    })
    return { mod, react, calls: null }
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
  }
}

test('tab 能力可用 + auto：注册右栏标签页，且不注册浮窗', () => {
  const { mod } = loadClient({ withSidebar: true })
  const { ctx, calls } = fakeCtx({ withSidebar: true })

  mod.apply(ctx)

  assert.equal(calls.tabTypes.length, 1, '应注册 1 个标签页类型')
  const def = calls.tabTypes[0]
  assert.equal(def.id, 'dsh-hud', '类型 id 必须是 dsh-hud')
  assert.equal(def.kind, 'dsh-hud', 'kind 与 id 一致，openTab 才能按 kind 打开')
  assert.equal(typeof def.title, 'function')
  assert.ok(Array.isArray(def.guide) && def.guide.length === 1, '应提供一个引导页入口')

  const body = calls.registrations.find((r) => r.name === 'sidebar.right.pane.tab')
  assert.ok(body, '应把 body 注册进 sidebar.right.pane.tab')
  assert.equal(body.key, def.id, 'body 的 key 必须等于类型 id（官方两段式契约）')

  assert.equal(calls.registrations.some((r) => r.name === 'shell.overlay'), false,
    'tab 形态不应再注册浮窗')
})

test('旧宿主（无右栏服务）+ auto：回落浮窗', () => {
  const { mod } = loadClient({ withSidebar: false })
  const { ctx, calls } = fakeCtx({ withSidebar: false })

  mod.apply(ctx)

  assert.equal(calls.tabTypes.length, 0, '旧宿主不应注册标签页类型')
  const floats = calls.registrations.filter((r) => r.name === 'shell.overlay')
  assert.equal(floats.length, 1, '应注册 1 个浮窗')
  assert.equal(floats[0].id, 'dsh-hud-panel', '浮窗 id 保持 1.3.0 原值')
})

test('显式 float：即使有右栏也用浮窗', () => {
  const { mod } = loadClient({ withSidebar: true, panelMode: 'float' })
  const { ctx, calls } = fakeCtx({ withSidebar: true })

  mod.apply(ctx)

  assert.equal(calls.tabTypes.length, 0)
  assert.equal(calls.registrations.some((r) => r.name === 'shell.overlay'), true)
})

test('显式 off：两种形态都不注册', () => {
  const { mod } = loadClient({ withSidebar: true, panelMode: 'off' })
  const { ctx, calls } = fakeCtx({ withSidebar: true })

  mod.apply(ctx)

  assert.equal(calls.tabTypes.length, 0)
  assert.equal(calls.registrations.some((r) => r.name === 'shell.overlay'), false)
  assert.equal(calls.registrations.some((r) => r.name === 'sidebar.right.pane.tab'), false)
})

test('面板组件在 tab / float 两种 variant 下都能渲染完', () => {
  for (const variant of ['tab', 'float']) {
    // float 分支必须显式选 float：有右栏时 auto 会走 tab
    const { mod } = loadClient({ withSidebar: true, panelMode: variant === 'float' ? 'float' : 'tab' })
    const { ctx, calls } = fakeCtx({ withSidebar: true })
    mod.apply(ctx)

    // float 形态面板默认关闭，先"点一下"输入框左侧的开关按钮把它打开
    if (variant === 'float') {
      const toggleReg = calls.registrations.find((r) => r.name === 'conversation.input.left')
      assert.ok(toggleReg, 'float：应注册输入框开关按钮')
      const btn = toggleReg.component({
        sessionId: 'session-test',
        useSessions: (sel) => sel({ current: 'session-test' }),
        useProjection: () => undefined,
      })
      assert.equal(typeof btn.props.onClick, 'function', 'float：开关按钮应可点击')
      btn.props.onClick()
    }

    const body = calls.registrations.find((r) =>
      variant === 'tab' ? r.name === 'sidebar.right.pane.tab' : r.name === 'shell.overlay')
    assert.ok(body && typeof body.component === 'function', variant + '：拿不到面板组件')

    // 注册的是「包装组件」（createElement(HudPanel, {...})），先展开一层再真正渲染，
    // React 替身会跑完整个渲染体，未定义变量/引用错误在此暴露
    const props = {
      variant,
      sessionId: 'session-test',
      useSessions: (sel) => sel({ current: 'session-test' }),
      useProjection: () => undefined,
    }
    let tree = body.component(props)
    if (tree && typeof tree.type === 'function') tree = tree.type(tree.props)
    assert.ok(tree && typeof tree === 'object', variant + '：组件没有产出节点')
    assert.equal(tree.props.style.position === 'fixed', variant === 'float',
      variant + '：外壳样式不对（tab 不应是 fixed 浮层、也不应铺满定位）')
    // 两种形态都要能拿到同一份面板内容（Git 标题）
    const flat = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
    assert.ok(flat.includes('Git'), variant + '：面板主体没有渲染出 Git 区块')
  }
})

test('设置卡片能渲染（官方 field 排布：标签 + 控件 + 操作行）', () => {
  // 必须复用同一次 loadClient 的 react（每次 loadClient 都会新建一个替身实例）
  const { mod, react } = loadClient({ withSidebar: true })
  const { ctx, calls } = fakeCtx({ withSidebar: true })
  mod.apply(ctx)

  const card = calls.registrations.find((r) => r.name === 'settings.plugin.item')
  assert.ok(card && typeof card.component === 'function', '应注册设置卡片')
  const render = () => {
    react.__reset()
    const wrapper = card.component()                   // createElement(SettingsCardShell, ...)
    return typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper
  }
  let shell = render()
  assert.equal(shell.type, 'li', '卡片外壳应是 li 元素')
  assert.equal(shell.children.some((c) => c && c.type === 'div'), false, '默认应是折叠的')

  // 点标题行展开（模拟 React 的 setState 会真正落进 hook 槽位）
  react.__reset()
  const wrapper2 = card.component()
  const shellEl = wrapper2.type(wrapper2.props)
  const head = shellEl.children.find((c) => c && c.type === 'button')
  assert.ok(head && typeof head.props.onClick === 'function', '卡片应有可点击的标题行')
  head.props.onClick()

  shell = render()
  const inner = shell.children.find((c) => c && c.type === 'div')
  assert.ok(inner, '展开后应渲染卡片体')
  let tree = inner.children[0]
  if (tree && typeof tree.type === 'function') tree = tree.type(tree.props)

  const flat = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
  for (const needle of ['dsh-hud-field', 'dsh-hud-field-label', '面板形态', '关注仓库', 'dsh-hud-input', 'dsh-hud-btn']) {
    assert.ok(flat.includes(needle), '卡片里应有 ' + needle)
  }
  assert.ok(flat.includes('dsh-hud-actions'), '字段操作行应右对齐（dsh-actions）')
})
