/**
 * DSH 版本号的来源链（2026-09-25 抽出，便于单测）
 *
 * 背景：官方桌面版（Electron App）由启动台拉起，PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin` —— 里面没有 `dsh` 命令（它装在用户自己的
 * npm-global 里，是命令行版在用的）。所以原实现"shell 跑 `dsh --version`"
 * 在桌面端必然失败 → 版本号空白。
 *
 * 现在按优先级取：
 *   ① 宿主自报（官方 `@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion()`）
 *   ② 回落 shell 跑 `dsh --version`（老路，命令行版宿主仍适用）
 *   ③ 都不行 → null（界面照旧不显示，绝不抛错拖垮其它数据）
 */

/** 规范化版本字符串：非字符串 / 空 / 纯空白一律 null。 */
function normalizeVersion(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 按优先级解析版本号；任一来源成功即短路。
 * 取数失败只告警（带来源标签，便于排查），不抛错。
 *
 * @param hostVersion 宿主自报取数函数（可缺省）
 * @param shellVersion shell 取数函数（可缺省）
 * @param warn 告警回调（默认丢弃）
 * @returns 版本字符串或 null
 */
export async function resolveDshVersion({ hostVersion, shellVersion, warn = () => {} } = {}) {
  const sources = [
    ['host', hostVersion],
    ['shell', shellVersion],
  ]
  for (const [label, read] of sources) {
    if (typeof read !== 'function') continue
    try {
      const value = normalizeVersion(await read())
      if (value !== null) return value
    } catch (error) {
      warn(`[dsh-hud] ${label} version failed: ` + (error instanceof Error ? error.message : String(error)))
    }
  }
  return null
}

/**
 * 带缓存的版本收集器（默认 60s）。
 * 失败结果（null）也缓存，避免每次都白跑一遍失败路径。
 *
 * @param hostVersion 宿主自报取数函数
 * @param shellVersion shell 取数函数；每次 collect(context) 的 context 原样透传给它
 * @param warn 告警回调
 * @param now 时钟（测试注入用）
 * @param cacheMs 缓存窗口
 */
export function createVersionCollector({
  hostVersion,
  shellVersion,
  warn,
  now = Date.now,
  cacheMs = 60000,
} = {}) {
  let cache = { at: 0, value: undefined } // value: undefined=没取过，null=失败/不可用
  return {
    /** @param context 原样透传给 shellVersion（index.js 传 shell 服务实例） */
    async collect(context) {
      const at = now()
      if (cache.value !== undefined && at - cache.at < cacheMs) return cache.value
      const value = await resolveDshVersion({
        hostVersion: typeof hostVersion === 'function' ? () => hostVersion() : undefined,
        shellVersion: typeof shellVersion === 'function' ? () => shellVersion(context) : undefined,
        warn,
      })
      cache = { at, value }
      return value
    },
  }
}
