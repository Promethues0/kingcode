/**
 * multi_edit 工具的无头测试：不起 agent、不调模型，假 ctx 收下 defineTool
 * 定义直接驱动 execute（写法同仓库其他工具测试）。
 *
 * 守四件事：顺序替换与逐处校验的纯函数语义、按文件原子（失败文件一处不改、
 * 成功文件照常写入）、写意图瀑布与 fs/observed 的接线、render 承载全量结局
 * （每个文件写没写、失败在哪，模型只能从 render 看到）。
 *
 * 跑法：node test/test-multi-edit.js（失败退出码 1）
 */

import * as plugin from '../plugins/multi-edit.js'
import { applyEdits, groupEdits, countOccurrences, remediateMessage } from '../plugins/multi-edit.js'

let failed = 0
const check = (ok, label, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`)
}
const eq = (actual, expectedValue, label) =>
  check(actual === expectedValue, label, actual === expectedValue ? '' : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(actual)}`)

// ---- 纯函数：countOccurrences / applyEdits / groupEdits ----

eq(countOccurrences('aaa', 'aa'), 1, 'countOccurrences 不重叠计数')
eq(countOccurrences('abcabc', 'abc'), 2, 'countOccurrences 多次出现')
eq(countOccurrences('abc', 'x'), 0, 'countOccurrences 无匹配')

{
  const r = applyEdits('const a = 1\nconst b = a + 1\n', [
    { oldString: 'const a = 1', newString: 'const total = 1', replaceAll: false },
    { oldString: 'a + 1', newString: 'total + 1', replaceAll: false },
  ])
  check(r.ok, '顺序替换成功')
  eq(r.content, 'const total = 1\nconst b = total + 1\n', '后一处替换看到前一处的结果')
  eq(r.replacements, 2, '替换计数')
}

{
  const r = applyEdits('x y x', [{ oldString: 'x', newString: 'z', replaceAll: false }])
  check(!r.ok, '非唯一匹配整体失败')
  check(r.error.includes('2 次'), '错误信息带出现次数', r.error)
}

{
  const r = applyEdits('x y x', [{ oldString: 'x', newString: 'z', replaceAll: true }])
  check(r.ok && r.content === 'z y z' && r.replacements === 2, 'replace_all 全替换并计数')
}

{
  const r = applyEdits('abc', [
    { oldString: 'abc', newString: 'def', replaceAll: false },
    { oldString: 'abc', newString: 'ghi', replaceAll: false }, // 已被上一步改掉
  ])
  check(!r.ok, '被前面替换改写导致零匹配 → 失败')
  check(r.error.includes('前面的替换'), '错误信息提示了顺序语义', r.error)
}

{
  const grouped = groupEdits([
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
    { file_path: 'b.js', old_string: 'p', new_string: 'q' },
    { file_path: 'a.js', old_string: 'm', new_string: 'n' },
  ])
  eq(grouped.size, 2, 'groupEdits 按文件分组')
  eq(grouped.get('a.js').length, 2, '同文件的编辑保持在一组')
  eq([...grouped.keys()][0], 'a.js', '文件序按首次出现')
}

for (const [label, bad] of [
  ['空 file_path', { file_path: ' ', old_string: 'x', new_string: 'y' }],
  ['空 old_string', { file_path: 'a', old_string: '', new_string: 'y' }],
  ['old=new', { file_path: 'a', old_string: 'x', new_string: 'x' }],
]) {
  let threw = false
  try { groupEdits([bad]) } catch { threw = true }
  check(threw, `groupEdits 拒绝${label}`)
}

eq(remediateMessage(Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })),
  'stale — re-read the file, then retry', 'FS_STALE_VERSION 带补救提示')
eq(remediateMessage(Object.assign(new Error('unread'), { code: 'FS_NOT_OBSERVED' })),
  'unread — read the file, then retry', 'FS_NOT_OBSERVED 带补救提示')
eq(remediateMessage(new Error('other')), 'other', '其他错误原样透传')

// ---- execute：假 fs 驱动，验证按文件原子与接线 ----

/** 用假的 ctx 收下工具定义。 */
function loadTool(fakeFs, events) {
  let captured
  const sections = []
  plugin.apply({
    tools: { register: def => { captured = def } },
    systemPrompt: { section: s => { sections.push(s) } },
    fs: fakeFs,
    waterfall: async (name, _target, _exec, next) => {
      events.push(`waterfall:${name}`)
      return next()
    },
    emit: (name, _target, observation) => { events.push(`emit:${name}:${observation.kind}`) },
  })
  if (captured === undefined) throw new Error('插件没有注册工具')
  check(sections.some(s => s.name === 'tool:multi_edit' && s.order === 106), '注册了 tool:multi_edit 提示段（order 106）')
  return captured
}

/** 假 fs：内存文件表 + 写入记录。 */
function makeFakeFs(files, { failWriteWith } = {}) {
  const writes = []
  return {
    writes,
    async resolve(path) { return { displayPath: path, key: path } },
    async readText(target) {
      if (!(target.key in files)) throw Object.assign(new Error(`no such file: ${target.key}`), { code: 'FS_NOT_FOUND' })
      return files[target.key]
    },
    async writeText(target, content) {
      if (failWriteWith && target.key === failWriteWith.path) throw failWriteWith.error
      writes.push(target.key)
      files[target.key] = content
      return { version: `v-${writes.length}` }
    },
  }
}

const exec = { signal: new AbortController().signal, agent: undefined }

// 场景 1：两文件全成功
{
  const files = { 'a.js': 'foo bar\n', 'b.js': 'foo baz\n' }
  const events = []
  const tool = loadTool(makeFakeFs(files), events)
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'foo', new_string: 'qux' },
    { file_path: 'b.js', old_string: 'foo', new_string: 'qux' },
  ] }, exec)
  check(value.files.every(f => f.written), '两文件都写入')
  eq(files['a.js'], 'qux bar\n', 'a.js 内容正确')
  eq(files['b.js'], 'qux baz\n', 'b.js 内容正确')
  check(events.filter(e => e === 'waterfall:fs/write-intent').length === 2, '每次写都过写意图瀑布')
  check(events.filter(e => e === 'emit:fs/observed:present').length === 2, '每次写都发 fs/observed')
}

// 场景 2：按文件原子——B 文件第二处编辑失败，B 一处不改，A 照常写入
{
  const files = { 'a.js': 'alpha\n', 'b.js': 'one two one\n' }
  const events = []
  const tool = loadTool(makeFakeFs(files), events)
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'alpha', new_string: 'beta' },
    { file_path: 'b.js', old_string: 'two', new_string: 'TWO' },
    { file_path: 'b.js', old_string: 'one', new_string: 'ONE' }, // 出现 2 次 → 失败
  ] }, exec)
  const a = value.files.find(f => f.path === 'a.js')
  const b = value.files.find(f => f.path === 'b.js')
  check(a.written && !b.written, 'A 写入、B 拒写')
  eq(files['b.js'], 'one two one\n', 'B 文件一处未改（第一处编辑也没落盘）')
  check(b.error.includes('2 次'), 'B 的失败原因如实带出', b.error)
  const rendered = tool.output.render({}, value)[0].text
  check(rendered.includes('a.js: 已更新') && rendered.includes('b.js: 未改动'), 'render 逐文件报告结局')
  check(rendered.includes('2 次') && rendered.includes('未写入'), 'render 带失败原因与原子性说明', rendered)
}

// 场景 3：写入期异常（如 FS_STALE_VERSION）落进该文件的 error 且带补救提示
{
  const files = { 'a.js': 'x\n' }
  const stale = Object.assign(new Error('version mismatch'), { code: 'FS_STALE_VERSION' })
  const events = []
  const tool = loadTool(makeFakeFs(files, { failWriteWith: { path: 'a.js', error: stale } }), events)
  const value = await tool.execute({ edits: [{ file_path: 'a.js', old_string: 'x', new_string: 'y' }] }, exec)
  check(!value.files[0].written, '写守卫失败 → 未写入')
  check(value.files[0].error.includes('re-read the file, then retry'), '错误带补救提示', value.files[0].error)
  eq(files['a.js'], 'x\n', '内容未变')
}

// 场景 4：不存在的文件失败，不影响同批其他文件
{
  const files = { 'a.js': 'x\n' }
  const tool = loadTool(makeFakeFs(files), [])
  const value = await tool.execute({ edits: [
    { file_path: 'missing.js', old_string: 'x', new_string: 'y' },
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
  ] }, exec)
  check(!value.files[0].written && value.files[1].written, '缺失文件失败、其余文件照常')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
