/**
 * dsh-hud — git 输出解析纯函数模块（零依赖，便于单测）
 *
 * 由 lib/index.js 抽取（2026-08-31，issue #9 修复）：
 * 解析 `git status --porcelain=v1 -b` / `git diff --numstat HEAD --` /
 * `git log --pretty=format:%h|%s|%ct` 的输出为结构数据。
 *
 * 2026-08-31 修复（issue #9，Windows 幻影"N 个未提交"）：
 * 旧实现在剥离 `\r` 之前判断空行，Windows 下 shell 输出 CRLF 时 status 段
 * 以 `\r\n` 开头 → split('\n') 首行是 `'\r'` → 剥 `\r` 后变空行却已落入
 * 文件分支 → line[0]/line[1] 为 undefined → 产生 path=''、+0/-0、status M 的
 * 幻影文件。现在统一"先剥 `\r` 再判空"，另加最小长度防御
 * （porcelain 条目至少 `XY 路径` 4 字符，畸形行直接丢弃）。
 */

/**
 * 解析 `git status --porcelain=v1 -b` 输出：
 * 首行 `## 分支... [ahead N, behind M]`；其余行 `XY 路径`（重命名带 `->`）。
 * 保留 X/Y 双列以支持暂存/未暂存分组，状态码归并为界面用单符号。
 */
export function parseStatus(branch, stdout) {
  let ahead = 0
  let behind = 0
  const files = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF 混入路径（先剥再判空，issue #9）
    if (line === '') continue
    if (line.startsWith('## ')) {
      const m = /ahead (\d+)/.exec(line)
      const n = /behind (\d+)/.exec(line)
      if (m !== null || n !== null) {
        ahead = m === null ? 0 : Number(m[1])
        behind = n === null ? 0 : Number(n[1])
      }
      continue
    }
    // 防御（issue #9 加固）：porcelain 条目至少 `XY 路径`（4 字符），
    // 畸形态/空路径行（剥 \r 后为空、或路径缺失）直接丢弃，杜绝幻影文件。
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    let path = line.slice(3)
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
export function parseNumstat(text) {
  const map = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF（先剥再判空，与 parseStatus 对齐）
    if (line === '') continue
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
export function parseLog(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r/g, '') // 防 Windows CRLF（先剥再判空，与 parseStatus 对齐）
    if (line === '') continue
    const i = line.indexOf('|')
    const j = line.indexOf('|', i + 1)
    if (i < 0 || j < 0) continue
    out.push({ hash: line.slice(0, i), subject: line.slice(i + 1, j), time: Number(line.slice(j + 1)) || 0 })
  }
  return out
}
