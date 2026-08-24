/**
 * KingCode 自定义工具：multi_edit —— 一次调用做多处字面替换，可跨文件。
 *
 * 为什么要自写：上游 edit 一次只改一处，一个跨 5 个文件、12 处的重命名
 * 重构 = 12 个模型 round trip，中途失败还留半改状态；而 npm 上没有任何
 * multi-edit/patch 类的 dsh 工具包。ctx.fs 的原语（readText +
 * writeText(写意图守卫)）足以支撑「读进内存 → 顺序替换并逐处校验 →
 * 单次原子写回」。
 *
 * 原子性契约（render 与 description 都要说清）：**按文件原子**——同一文件的
 * 全部替换要么全部落盘、要么一处不改；跨文件不回滚，哪个文件写了、哪个
 * 失败在哪一处，逐条如实报告。
 *
 * 文件身份 = resolve 出来的 targetKey，不是路径原文。`a.js`、`./a.js`、绝对
 * 路径、经符号链接的路径指的是同一个文件，就必须落进同一组、走同一次
 * 读-改-写；否则「按文件原子」是假的：render 会对同一条路径既报「已更新」
 * 又报「未改动」，而磁盘上留着改坏一半的重命名。模型自然就会踩到——read
 * 工具返回绝对路径，任务文本给的是相对路径。targetKey 是 FsTarget 契约里
 * 的稳定身份（realpath 派生，见 dsh-fs/lib/types/types.d.ts:54 与
 * dsh-fs-local/lib/index.js:159）。
 *
 * 行尾：上游 edit 走 readForEdit → applyLiteralEdit → restoreLineEndings
 * （dsh-fs-local/lib/index.js:570 / :647 / :802-806），即「读进来归一成 LF、
 * old/new 也归一、写回前还原成原文件的风格」。本工具用的是裸 readText
 * （byte-for-byte 不归一，同文件 :349）+ writeText（同样不碰行尾），所以必须
 * 自己补上这三件套——三个函数上游没导出，这里照抄其规则（阈值见
 * detectLineEndings 的注释）。不补的话同一份输入两个工具结果相反：多行
 * old_string 打 CRLF 文件永远不匹配，单行匹配 + new_string 含 \n 则**静默**
 * 写出混合行尾。
 *
 * 与 fs-observation-policy 的配合：写回走 'fs/write-intent' 瀑布拿守卫，
 * 「先读后写」与陈旧检测（FS_STALE_VERSION）照常生效；本工具内部的
 * readText 不发 fs/observed，所以不会替模型「垫读」——模型自己必须先 read。
 *
 * Loader 插件必须具名导出（default export 会丢 inject）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'kingcode-multi-edit'
export const inject = ['tools', 'fs', 'systemPrompt']

/** 统计 haystack 里 needle 的出现次数（字面、不重叠）。 */
export function countOccurrences(haystack, needle) {
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

/**
 * 把 CRLF 折成 LF —— 匹配与替换统一在这个规范形上做。
 * 与 dsh-fs-local/lib/index.js:533 逐字同义：只动 `\r\n` 对，孤立的 `\r`
 * （老 Mac 行尾）原样保留。
 * @param content - 任意行尾风格的文本。
 * @returns 每个 `\r\n` 都换成 `\n` 的文本。
 */
export function normalizeLineEndings(content) {
  return content.replaceAll('\r\n', '\n')
}

/**
 * 检测一份**未归一**文本的行尾风格。规则照抄 dsh-fs-local/lib/index.js:536-540：
 * 只看前 4096 个字符，CRLF 数量严格大于裸 LF 数量才算 CRLF 文件（平手算 LF，
 * 空文件也算 LF）。阈值与采样窗口刻意与上游一致——同一份文件被 edit 和
 * multi_edit 判成两种风格，就等于换了个工具行尾就变。
 * @param raw - 读进来的原始文本（不要先归一，否则永远判成 LF）。
 * @returns 'CRLF' 或 'LF'。
 */
export function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}

/**
 * 把 LF 规范形还原成原文件的行尾风格，供写回。与 dsh-fs-local/lib/index.js:549
 * 一致：LF 原样返回；CRLF 先再归一一次，保证已是 `\r\n` 的序列不会被撑成
 * `\r\r\n`。副作用与上游相同——混合行尾的文件会被整体统一成检测到的多数派。
 * @param content - 已归一（LF）的编辑后文本。
 * @param lineEndings - detectLineEndings 在读时给出的原风格。
 * @returns 原风格的文本。
 */
export function restoreLineEndings(content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/**
 * 对一份文件内容按顺序应用一组替换，逐处校验；任一处不合格就整体失败。
 * 纯函数，便于无头测试。
 *
 * 行尾：content 与每条 old/new 都先归一成 LF 再比对（同上游 applyLiteralEdit，
 * dsh-fs-local/lib/index.js:647-650），所以模型照 read 出来的逐行文本写 `\n`
 * 也能打中 CRLF 文件。返回的 content 是 LF 规范形，**调用方负责
 * restoreLineEndings 后再写盘**。
 * @param content - 文件当前内容（可以是原始风格，内部会归一）。
 * @param edits - [{oldString, newString, replaceAll}]，按数组顺序应用，
 *   后面的替换看到的是前面替换之后的内容。
 * @returns {{ok: true, content: string, replacements: number} | {ok: false, error: string}}
 */
export function applyEdits(content, edits) {
  let current = normalizeLineEndings(content)
  let replacements = 0
  for (let i = 0; i < edits.length; i++) {
    const oldString = normalizeLineEndings(edits[i].oldString)
    const newString = normalizeLineEndings(edits[i].newString)
    const { replaceAll } = edits[i]
    const occurrences = countOccurrences(current, oldString)
    if (occurrences === 0) {
      // 「前面的替换改写了它」只有真有前面的替换时才可能——在组内第 1 处
      // 说这句是把模型推去查一个不存在的原因。
      return {
        ok: false,
        error: i === 0
          ? '第 1 处替换的 old_string 没有匹配（行尾已归一，请核对缩进与不可见字符）'
          : `第 ${i + 1} 处替换的 old_string 没有匹配（注意前面的替换可能已改写了它）`,
      }
    }
    if (!replaceAll && occurrences > 1) {
      return { ok: false, error: `第 ${i + 1} 处替换的 old_string 出现 ${occurrences} 次；给出更长的唯一上下文，或设 replace_all` }
    }
    current = current.split(oldString).join(newString)
    replacements += occurrences
  }
  return { ok: true, content: current, replacements }
}

/**
 * 校验 schema 表达不了的约束。抛错 = 整次调用失败（校验先于任何 IO）。
 * @param edits - schema 校验后的原始参数。
 */
export function validateEdits(edits) {
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (e.file_path.trim().length === 0) throw new Error(`edits[${i}].file_path 不能为空`)
    if (e.old_string.length === 0) throw new Error(`edits[${i}].old_string 不能为空`)
    if (e.old_string === e.new_string) throw new Error(`edits[${i}] 的 old_string 与 new_string 相同，是保证无效的编辑`)
  }
}

/**
 * 校验并按「文件身份」分组（保持首次出现的组序与组内编辑序）。
 *
 * 身份由 keyOf 给出：execute 传的是 resolve 出来的 targetKey，所以 `a.js` 与
 * `./a.js` 归一到同一组；默认的 `file_path` 原文只够单测/调试用——路径原文
 * 不是文件身份。
 * @param edits - schema 校验后的原始参数。
 * @param keyOf - (edit, index) => string，该条编辑所属文件的稳定身份。
 * @returns Map<key, {key, paths: string[], edits: [{oldString, newString, replaceAll}]}>
 *   paths 是落进该组的全部路径写法，按首现序（用于把别名如实报给模型）。
 */
export function groupEdits(edits, keyOf = e => e.file_path) {
  validateEdits(edits)
  const byKey = new Map()
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    const key = keyOf(e, i)
    const group = byKey.get(key) ?? { key, paths: [], edits: [] }
    if (!group.paths.includes(e.file_path)) group.paths.push(e.file_path)
    group.edits.push({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all ?? false })
    byKey.set(key, group)
  }
  return byKey
}

/**
 * 给两个受守卫的失败码补上正确的补救动作（与上游 tool-fs 的口径一致）：
 * 裸的 FS_STALE_VERSION/FS_NOT_OBSERVED 只说了条件，没说唯一正确的恢复方式。
 * @param error - 捕获到的异常。
 * @returns 面向模型的错误文案。
 */
export function remediateMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error?.code
  if (code === 'FS_STALE_VERSION') return `${message} — re-read the file, then retry`
  if (code === 'FS_NOT_OBSERVED') return `${message} — read the file, then retry`
  return message
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:multi_edit',
    order: 106,
    text: 'Use multi_edit instead of repeated edit calls when a change spans several replacements or several files (renames, signature changes, moving code). Edits are applied in order; each file is atomic — all of its edits land or none do, and files are reported individually. Edits are grouped by the file they resolve to, so different spellings of one path (relative, absolute, through a symlink) are one file, not two. The same read-before-write rule applies to every file touched.',
  })

  ctx.tools.register(defineTool({
    name: 'multi_edit',
    description: 'Apply several literal text replacements in one call, possibly across files. '
      + 'Edits are applied in array order; within a file, later edits see the result of earlier ones. '
      + 'Each old_string must match exactly once unless replace_all is set. '
      + 'Per-file atomic: if any edit in a file fails, that whole file is left untouched; other files are still processed and every file\'s outcome is reported. '
      + 'Edits are grouped by the file each path resolves to, so "a.js", "./a.js" and the absolute path are the same file and share one atomic write. '
      + 'Line endings are handled for you: matching happens on LF-normalized text (write \\n in old_string/new_string even for CRLF files) and the file is written back in its original style. '
      + 'Read each file first — the write is version-guarded, and editing an unread or changed file fails with the usual read-then-retry remedy.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        description: 'The replacements to apply, in order. Group edits to the same file contiguously for readability (grouping is by the resolved file either way).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
            old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly once in the content as of this step, unless replace_all.' },
            new_string: { type: 'string', required: true, description: 'Literal replacement text. Empty string deletes the match.' },
            replace_all: { type: 'boolean', description: 'Replace all matches of old_string in this step. Defaults to false.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                written: { type: 'boolean', required: true },
                replacements: { type: 'integer', required: true },
                // 模型给的全部路径写法（>1 种时才有），它们归一到同一个文件
                aliases: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      // render 是模型唯一能看到的返回通道：每个文件的结局都要在这里说清
      render: (_args, value) => {
        const lines = value.files.map((f) => {
          // 只在模型真给了多种路径写法时才提——否则它会奇怪自己写的那条去哪了
          const alias = f.aliases?.length ? `（${f.aliases.join('、')} 归一为同一文件）` : ''
          return f.written
            ? `${f.path}: 已更新（${f.replacements} 处替换）${alias}`
            : `${f.path}: 未改动 —— ${f.error}${alias}`
        })
        const failed = value.files.filter(f => !f.written).length
        if (failed > 0) lines.push(`注意：${failed} 个文件未写入（按文件原子，失败文件一处未改）；已写入的文件不回滚。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      if (args.edits.length === 0) throw new Error('edits 不能为空')
      validateEdits(args.edits) // 校验先于任何 IO：参数有病就整体失败，别改一半

      // 第一轮：逐条 resolve 拿稳定身份。分组必须按 targetKey，不能按路径原文
      // ——否则同一文件的两种写法会被当成两个文件，各自读-改-写，
      // 「按文件原子」当场作废。
      const sessionCwd = exec.agent?.session.header.cwd
      const keys = []
      const targets = new Map() // key -> 首现的 FsTarget
      const resolveErrors = new Map() // key -> 面向模型的错误文案
      for (const edit of args.edits) {
        try {
          // 与上游 tool-fs 一致：路径按调用方会话的 cwd 解析（无会话时回落后端默认）
          const target = await ctx.fs.resolve(edit.file_path, {
            ...sessionCwd !== undefined ? { cwd: sessionCwd } : {},
            signal: exec.signal,
          })
          const key = `target:${String(target.targetKey)}`
          if (!targets.has(key)) targets.set(key, target)
          keys.push(key)
        } catch (error) {
          // resolve 不出身份就没法并组，单独记账：同一路径原文的多条合成一条
          const key = `unresolved:${edit.file_path}`
          if (!resolveErrors.has(key)) resolveErrors.set(key, remediateMessage(error))
          keys.push(key)
        }
      }

      const groups = groupEdits(args.edits, (_edit, i) => keys[i])
      const files = []
      for (const [key, group] of groups) {
        const target = targets.get(key)
        const record = { path: target?.displayPath ?? group.paths[0], written: false, replacements: 0 }
        // 同一文件被写成多种路径：如实列出全部写法，模型才知道它给的两条
        // 路径合成了这一行（少了一行不是漏报）
        if (group.paths.length > 1) record.aliases = [...group.paths]
        files.push(record)
        if (target === undefined) {
          record.error = `路径解析失败：${resolveErrors.get(key)}`
          continue
        }
        try {
          const raw = await ctx.fs.readText(target, exec.signal)
          // 先在原始文本上检测风格，再归一比对，写回时还原（同上游 edit）
          const lineEndings = detectLineEndings(raw)
          const applied = applyEdits(raw, group.edits)
          if (!applied.ok) {
            record.error = applied.error
            continue
          }
          // 写意图走瀑布：fs-observation-policy 在这里挂上「先读后写 + 版本守卫」
          const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
          const outcome = await ctx.fs.writeText(target, restoreLineEndings(applied.content, lineEndings), intent, exec.signal)
          ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          record.written = true
          record.replacements = applied.replacements
        } catch (error) {
          record.error = remediateMessage(error)
        }
      }
      return { files }
    },
  }))
}
