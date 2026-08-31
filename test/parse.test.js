import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, parseNumstat, parseLog } from '../lib/git-status-parse.js'

// ── parseStatus ──────────────────────────────────────────────────────────

test('LF clean repo → no files', () => {
  const r = parseStatus('main', '\n## main...origin/main\n')
  assert.equal(r.files.length, 0)
  assert.equal(r.ahead, 0)
  assert.equal(r.behind, 0)
})

test('CRLF clean repo → no phantom (issue #9 regression)', () => {
  // Windows shell CRLF: status 段以 \r\n 开头,旧实现在剥 \r 前判空会生成幻影 M 文件
  const r = parseStatus('main', '\r\n## main...origin/main\r\n')
  assert.equal(r.files.length, 0)
})

test('CRLF modified + untracked parsed correctly', () => {
  const r = parseStatus('main', '\r\n## main...origin/main\r\n M src/index.js\r\n?? new.txt\r\n')
  assert.equal(r.files.length, 2)
  assert.deepEqual(r.files[0], {
    x: ' ', y: 'M', status: 'M', staged: false, unstaged: true, untracked: false, path: 'src/index.js',
  })
  assert.deepEqual(r.files[1], {
    x: '?', y: '?', status: '??', staged: false, unstaged: true, untracked: true, path: 'new.txt',
  })
})

test('LF modified parsed correctly', () => {
  const r = parseStatus('main', '\n## main\n M a.txt\nA  b.txt\n')
  assert.equal(r.files[0].path, 'a.txt')
  assert.equal(r.files[0].unstaged, true)
  assert.equal(r.files[1].staged, true)
  assert.equal(r.files[1].status, 'A')
})

test('ahead/behind parsed', () => {
  const r = parseStatus('main', '\n## main...origin/main [ahead 2, behind 1]\n')
  assert.equal(r.ahead, 2)
  assert.equal(r.behind, 1)
})

test('rename R old -> new takes new path', () => {
  const r = parseStatus('main', '\nR  old.txt -> new.txt\n')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].path, 'new.txt')
  assert.equal(r.files[0].status, 'R')
})

test('malformed lines (empty / short) dropped — phantom guard', () => {
  const r = parseStatus('main', '\r\n\nM\nXY\n')
  assert.equal(r.files.length, 0)
})

test('path containing tabs survives (slice, not split)', () => {
  const r = parseStatus('main', '\n M weird\tname.txt\n')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].path, 'weird\tname.txt')
})

// ── parseNumstat ─────────────────────────────────────────────────────────

test('numstat LF + CRLF mixed', () => {
  const map = parseNumstat('1\t2\tsrc/index.js\r\n0\t0\tmode.sh')
  assert.deepEqual(map.get('src/index.js'), { add: 1, del: 2 })
  assert.deepEqual(map.get('mode.sh'), { add: 0, del: 0 })
})

test('numstat rename (both forms)', () => {
  const map = parseNumstat('0\t0\told.ts => new.ts\n3\t1\t{dir/a.ts => dir/b.ts}')
  assert.deepEqual(map.get('new.ts'), { add: 0, del: 0 })
  assert.deepEqual(map.get('dir/b.ts'), { add: 3, del: 1 })
})

test('numstat binary (-) → 0/0', () => {
  const map = parseNumstat('-\t-\timg.png')
  assert.deepEqual(map.get('img.png'), { add: 0, del: 0 })
})

test('numstat drops CRLF-only line (alignment with parseStatus)', () => {
  const map = parseNumstat('\r\n1\t2\tf.txt\r\n')
  assert.equal(map.size, 1)
})

// ── parseLog ─────────────────────────────────────────────────────────────

test('log parses lines, ignores malformed', () => {
  const out = parseLog('\nabc|fix stuff|1234567890\r\ndef|第二行|0\r\n')
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { hash: 'abc', subject: 'fix stuff', time: 1234567890 })
  assert.deepEqual(out[1], { hash: 'def', subject: '第二行', time: 0 })
})

test('log drops CRLF-only line', () => {
  assert.equal(parseLog('\r\n').length, 0)
})
