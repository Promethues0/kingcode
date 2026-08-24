/**
 * multi_edit 工具的无头测试：不起 agent、不调模型，假 ctx 收下 defineTool
 * 定义直接驱动 execute（写法同仓库其他工具测试）。
 *
 * 守六件事：顺序替换与逐处校验的纯函数语义、行尾三件套（读时检测 / 归一后
 * 比对 / 写回还原，规则与上游 fs-local 一致）、按 resolve 出来的文件身份分组
 * （`a.js` 与 `./a.js` 是同一个文件）、按文件原子（失败文件一处不改、成功文件
 * 照常写入）、写意图瀑布与 fs/observed 的接线、render 承载全量结局（每个文件
 * 写没写、失败在哪、多个路径写法归一到了哪一行，模型只能从 render 看到）。
 *
 * 假 fs 的 resolve **必须归一路径**（这里用 node:path 的 resolve 冒充 realpath）：
 * 从前它直接回显参数原文，于是「按路径字符串分组」的缺陷在单测里根本看不见。
 *
 * 跑法：node test/test-multi-edit.js（失败退出码 1）
 */

import { resolve as resolvePath } from 'node:path'
import * as plugin from '../plugins/multi-edit.js'
import {
  applyEdits, countOccurrences, detectLineEndings, groupEdits,
  normalizeLineEndings, remediateMessage, restoreLineEndings, validateEdits,
} from '../plugins/multi-edit.js'

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
  // 组内第 1 处不可能被「前面的替换」改写——说这句是把模型推去查错误的方向
  const r = applyEdits('abc', [{ oldString: 'zzz', newString: 'y', replaceAll: false }])
  check(!r.ok, '第 1 处零匹配 → 失败')
  check(!r.error.includes('前面的替换'), '第 1 处的失败理由不甩锅给前面的替换', r.error)
}

// ---- 行尾三件套：规则与 dsh-fs-local 一致 ----

eq(normalizeLineEndings('a\r\nb\r\n'), 'a\nb\n', 'normalize 折 CRLF')
eq(normalizeLineEndings('a\rb\n'), 'a\rb\n', 'normalize 不碰孤立的 \\r')

eq(detectLineEndings('a\r\nb\r\n'), 'CRLF', 'detect：全 CRLF')
eq(detectLineEndings('a\nb\n'), 'LF', 'detect：全 LF')
eq(detectLineEndings(''), 'LF', 'detect：空文件算 LF')
eq(detectLineEndings('a\r\nb\n'), 'LF', 'detect：CRLF 不严格多于裸 LF 时算 LF（平手归 LF，同上游）')
eq(detectLineEndings('a\r\nb\r\nc\n'), 'CRLF', 'detect：CRLF 占多数算 CRLF')
// 只看前 4096 个字符：窗口内 CRLF 压倒，窗口外再多 LF 也不改判（同上游采样窗口）
eq(detectLineEndings('a\r\n'.repeat(2000) + 'b\n'.repeat(5000)), 'CRLF', 'detect：只采样前 4096 字符')

eq(restoreLineEndings('a\nb\n', 'LF'), 'a\nb\n', 'restore：LF 原样')
eq(restoreLineEndings('a\nb\n', 'CRLF'), 'a\r\nb\r\n', 'restore：还原成 CRLF')
eq(restoreLineEndings('a\r\nb\n', 'CRLF'), 'a\r\nb\r\n', 'restore：已是 CRLF 的不会被撑成 \\r\\r\\n')

{
  // 模型从 read 看到的是逐行文本，写 old_string 时必然用 \n；打 CRLF 文件也得中
  const r = applyEdits('function a() {\r\n  return 1\r\n}\r\n', [
    { oldString: 'function a() {\n  return 1\n}', newString: 'function a() {\n  return 111\n}', replaceAll: false },
  ])
  check(r.ok, 'applyEdits：\\n 的多行 old_string 打得中 CRLF 内容')
  eq(r.content, 'function a() {\n  return 111\n}\n', 'applyEdits 返回的是 LF 规范形（写回由调用方还原）')
}
{
  const r = applyEdits('a\nb\n', [{ oldString: 'a\r\nb', newString: 'p\r\nq', replaceAll: false }])
  check(r.ok && r.content === 'p\nq\n', 'applyEdits：old/new 里的 CRLF 也归一（同 applyLiteralEdit）')
}

// ---- groupEdits：身份由 keyOf 决定，不是路径原文 ----

{
  const grouped = groupEdits([
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
    { file_path: 'b.js', old_string: 'p', new_string: 'q' },
    { file_path: 'a.js', old_string: 'm', new_string: 'n' },
  ])
  eq(grouped.size, 2, 'groupEdits 按文件分组')
  eq(grouped.get('a.js').edits.length, 2, '同文件的编辑保持在一组')
  eq([...grouped.keys()][0], 'a.js', '文件序按首次出现')
  eq(grouped.get('a.js').paths.length, 1, '同一路径写法只记一次')
}

{
  // 生产路径上 keyOf 给的是 resolve 出来的 targetKey：两种写法归一到一组
  const edits = [
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
    { file_path: './a.js', old_string: 'm', new_string: 'n' },
  ]
  const grouped = groupEdits(edits, e => resolvePath('/repo', e.file_path))
  eq(grouped.size, 1, 'groupEdits：自定义 keyOf 把别名并成一组')
  eq(grouped.get('/repo/a.js').edits.length, 2, '别名的编辑并进同一组')
  eq(grouped.get('/repo/a.js').paths.join(','), 'a.js,./a.js', 'paths 如实记下全部路径写法（首现序）')
}

for (const [label, bad] of [
  ['空 file_path', { file_path: ' ', old_string: 'x', new_string: 'y' }],
  ['空 old_string', { file_path: 'a', old_string: '', new_string: 'y' }],
  ['old=new', { file_path: 'a', old_string: 'x', new_string: 'x' }],
]) {
  for (const [fnLabel, fn] of [['groupEdits', groupEdits], ['validateEdits', validateEdits]]) {
    let threw = false
    try { fn([bad]) } catch { threw = true }
    check(threw, `${fnLabel} 拒绝${label}`)
  }
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

const CWD = '/repo'
/** 路径 → 该假后端的稳定身份（冒充 fs-local 的 realpath 派生 targetKey）。 */
const at = p => resolvePath(CWD, p)

/**
 * 假 fs：内存文件表（键是归一后的绝对路径）+ 写入记录。
 * resolve 归一路径而不是回显原文——真后端的身份是 realpath 派生的 targetKey，
 * 回显原文会让「按路径字符串分组」的缺陷在单测里隐身。
 */
function makeFakeFs(files, { failWriteWith, failResolveFor } = {}) {
  const writes = []
  return {
    writes,
    async resolve(path) {
      if (failResolveFor && path === failResolveFor.path) throw failResolveFor.error
      const targetKey = at(path)
      return { targetKey, displayPath: targetKey }
    },
    async readText(target) {
      if (!(target.targetKey in files)) throw Object.assign(new Error(`no such file: ${target.targetKey}`), { code: 'FS_NOT_FOUND' })
      return files[target.targetKey]
    },
    async writeText(target, content) {
      if (failWriteWith && target.targetKey === at(failWriteWith.path)) throw failWriteWith.error
      writes.push(target.targetKey)
      files[target.targetKey] = content
      return { version: `v-${writes.length}` }
    },
  }
}

const exec = { signal: new AbortController().signal, agent: undefined }

// 场景 1：两文件全成功
{
  const files = { [at('a.js')]: 'foo bar\n', [at('b.js')]: 'foo baz\n' }
  const events = []
  const tool = loadTool(makeFakeFs(files), events)
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'foo', new_string: 'qux' },
    { file_path: 'b.js', old_string: 'foo', new_string: 'qux' },
  ] }, exec)
  check(value.files.every(f => f.written), '两文件都写入')
  eq(files[at('a.js')], 'qux bar\n', 'a.js 内容正确')
  eq(files[at('b.js')], 'qux baz\n', 'b.js 内容正确')
  check(events.filter(e => e === 'waterfall:fs/write-intent').length === 2, '每次写都过写意图瀑布')
  check(events.filter(e => e === 'emit:fs/observed:present').length === 2, '每次写都发 fs/observed')
  check(value.files.every(f => f.aliases === undefined), '只有一种路径写法时不报别名')
}

// 场景 2：按文件原子——B 文件第二处编辑失败，B 一处不改，A 照常写入
{
  const files = { [at('a.js')]: 'alpha\n', [at('b.js')]: 'one two one\n' }
  const events = []
  const tool = loadTool(makeFakeFs(files), events)
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'alpha', new_string: 'beta' },
    { file_path: 'b.js', old_string: 'two', new_string: 'TWO' },
    { file_path: 'b.js', old_string: 'one', new_string: 'ONE' }, // 出现 2 次 → 失败
  ] }, exec)
  const a = value.files.find(f => f.path === at('a.js'))
  const b = value.files.find(f => f.path === at('b.js'))
  check(a.written && !b.written, 'A 写入、B 拒写')
  eq(files[at('b.js')], 'one two one\n', 'B 文件一处未改（第一处编辑也没落盘）')
  check(b.error.includes('2 次'), 'B 的失败原因如实带出', b.error)
  const rendered = tool.output.render({}, value)[0].text
  check(rendered.includes(`${at('a.js')}: 已更新`) && rendered.includes(`${at('b.js')}: 未改动`), 'render 逐文件报告结局')
  check(rendered.includes('2 次') && rendered.includes('未写入'), 'render 带失败原因与原子性说明', rendered)
}

// 场景 3：写入期异常（如 FS_STALE_VERSION）落进该文件的 error 且带补救提示
{
  const files = { [at('a.js')]: 'x\n' }
  const stale = Object.assign(new Error('version mismatch'), { code: 'FS_STALE_VERSION' })
  const events = []
  const tool = loadTool(makeFakeFs(files, { failWriteWith: { path: 'a.js', error: stale } }), events)
  const value = await tool.execute({ edits: [{ file_path: 'a.js', old_string: 'x', new_string: 'y' }] }, exec)
  check(!value.files[0].written, '写守卫失败 → 未写入')
  check(value.files[0].error.includes('re-read the file, then retry'), '错误带补救提示', value.files[0].error)
  eq(files[at('a.js')], 'x\n', '内容未变')
}

// 场景 4：不存在的文件失败，不影响同批其他文件
{
  const files = { [at('a.js')]: 'x\n' }
  const tool = loadTool(makeFakeFs(files), [])
  const value = await tool.execute({ edits: [
    { file_path: 'missing.js', old_string: 'x', new_string: 'y' },
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
  ] }, exec)
  check(!value.files[0].written && value.files[1].written, '缺失文件失败、其余文件照常')
}

// 场景 5：别名归一——同一文件的两种写法是一个文件、一次原子写
{
  const files = { [at('a.js')]: 'const oldName = 1\nuse(oldName)\n' }
  const fakeFs = makeFakeFs(files)
  const tool = loadTool(fakeFs, [])
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'const oldName', new_string: 'const newName' },
    { file_path: './a.js', old_string: 'use(oldName)', new_string: 'use(newName)' },
  ] }, exec)
  eq(value.files.length, 1, '别名归一：同一文件只报一行')
  eq(fakeFs.writes.length, 1, '别名归一：只写一次盘')
  eq(value.files[0].replacements, 2, '两处替换都算进这一个文件')
  eq(files[at('a.js')], 'const newName = 1\nuse(newName)\n', '两处替换都落盘')
  eq(value.files[0].aliases.join(','), 'a.js,./a.js', '别名如实记账')
  const rendered = tool.output.render({}, value)[0].text
  eq(rendered.split('\n').length, 1, 'render 只有一行')
  check(rendered.includes('归一为同一文件') && rendered.includes('./a.js'), 'render 说清两种写法指的是同一个文件', rendered)
}

// 场景 6：别名归一后仍是按文件原子——任一处失败则该文件一处不改
{
  const files = { [at('a.js')]: 'const oldName = 1\nuse(oldName)\n' }
  const fakeFs = makeFakeFs(files)
  const tool = loadTool(fakeFs, [])
  const value = await tool.execute({ edits: [
    { file_path: 'a.js', old_string: 'const oldName', new_string: 'const newName' },
    { file_path: './a.js', old_string: 'MISSING', new_string: 'x' },
  ] }, exec)
  eq(value.files.length, 1, '别名失败：仍只报一行（不会同一路径既已更新又未改动）')
  eq(fakeFs.writes.length, 0, '别名失败：一次盘都没写')
  eq(files[at('a.js')], 'const oldName = 1\nuse(oldName)\n', '磁盘一处未改——render 的原子性断言是真的')
  const rendered = tool.output.render({}, value)[0].text
  check(!rendered.includes('已更新'), 'render 不会对同一文件同时报「已更新」', rendered)
}

// 场景 7：绝对路径与相对路径混用（模型 read 拿到绝对路径、任务文本给相对路径）
{
  const files = { [at('src/x.js')]: 'A\nB\n' }
  const fakeFs = makeFakeFs(files)
  const tool = loadTool(fakeFs, [])
  const value = await tool.execute({ edits: [
    { file_path: at('src/x.js'), old_string: 'A', new_string: 'AA' },
    { file_path: 'src/x.js', old_string: 'B', new_string: 'BB' },
  ] }, exec)
  eq(value.files.length, 1, '绝对/相对混用归一为一个文件')
  eq(files[at('src/x.js')], 'AA\nBB\n', '两处替换都落盘')
}

// 场景 8：CRLF 往返——读时检测、归一后比对、写回还原，不留混合行尾
{
  const CRLF = 'function a() {\r\n  return 1\r\n}\r\nfunction b() {\r\n  return 2\r\n}\r\n'
  const files = { [at('w.js')]: CRLF }
  const tool = loadTool(makeFakeFs(files), [])
  const value = await tool.execute({ edits: [
    // 多行 old_string 用 \n（模型从 read 看到的就是逐行文本）
    { file_path: 'w.js', old_string: 'function a() {\n  return 1\n}', new_string: 'function a() {\n  return 111\n}' },
    // new_string 含 \n：从前会静默写出混合行尾
    { file_path: 'w.js', old_string: '  return 2', new_string: '  const x = 2\n  return x' },
  ] }, exec)
  check(value.files[0].written, 'CRLF 文件：\\n 的多行 old_string 也能匹配并写入')
  const out = files[at('w.js')]
  eq(out, 'function a() {\r\n  return 111\r\n}\r\nfunction b() {\r\n  const x = 2\r\n  return x\r\n}\r\n', 'CRLF 往返：内容正确')
  eq((out.match(/(?<!\r)\n/g) ?? []).length, 0, 'CRLF 往返：没有裸 LF（不留混合行尾）')
}

// 场景 9：LF 文件不会被染成 CRLF（old/new 里带 \r\n 也一样）
{
  const files = { [at('l.js')]: 'a\nb\n' }
  const tool = loadTool(makeFakeFs(files), [])
  await tool.execute({ edits: [
    { file_path: 'l.js', old_string: 'a\r\nb', new_string: 'p\r\nq' },
  ] }, exec)
  eq(files[at('l.js')], 'p\nq\n', 'LF 文件保持 LF（不被 old/new 里的 CRLF 带偏）')
}

// 场景 10：resolve 失败单独记账，不拖累同批其他文件
{
  const files = { [at('a.js')]: 'x\n' }
  const boom = Object.assign(new Error('resolve aborted'), { code: 'FS_ABORTED' })
  const tool = loadTool(makeFakeFs(files, { failResolveFor: { path: 'bad.js', error: boom } }), [])
  const value = await tool.execute({ edits: [
    { file_path: 'bad.js', old_string: 'x', new_string: 'y' },
    { file_path: 'a.js', old_string: 'x', new_string: 'y' },
  ] }, exec)
  eq(value.files.length, 2, 'resolve 失败的路径单独成一条记录')
  check(!value.files[0].written && value.files[0].error.includes('路径解析失败'), 'resolve 失败如实说明', value.files[0].error)
  check(value.files[1].written, 'resolve 失败不拖累其他文件')
  const rendered = tool.output.render({}, value)[0].text
  check(rendered.includes('bad.js') && rendered.includes('路径解析失败'), 'render 里说清了解析失败的那条', rendered)
}

// 场景 11：参数校验先于任何 IO——有病的 edits 整体抛错，一处不改
{
  const files = { [at('a.js')]: 'x\n' }
  const fakeFs = makeFakeFs(files)
  const tool = loadTool(fakeFs, [])
  let threw = false
  try {
    await tool.execute({ edits: [
      { file_path: 'a.js', old_string: 'x', new_string: 'y' },
      { file_path: 'a.js', old_string: 'z', new_string: 'z' }, // old=new
    ] }, exec)
  } catch { threw = true }
  check(threw, '非法 edits 整体抛错')
  eq(fakeFs.writes.length, 0, '抛错前没有任何写入（校验先于 IO）')
  eq(files[at('a.js')], 'x\n', '磁盘未改')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
