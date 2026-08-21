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
 * 对一份文件内容按顺序应用一组替换，逐处校验；任一处不合格就整体失败。
 * 纯函数，便于无头测试。
 * @param content - 文件当前内容。
 * @param edits - [{oldString, newString, replaceAll}]，按数组顺序应用，
 *   后面的替换看到的是前面替换之后的内容。
 * @returns {{ok: true, content: string, replacements: number} | {ok: false, error: string}}
 */
export function applyEdits(content, edits) {
  let current = content
  let replacements = 0
  for (let i = 0; i < edits.length; i++) {
    const { oldString, newString, replaceAll } = edits[i]
    const occurrences = countOccurrences(current, oldString)
    if (occurrences === 0) {
      return { ok: false, error: `第 ${i + 1} 处替换的 old_string 没有匹配（注意前面的替换可能已改写了它）` }
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
 * 校验 schema 表达不了的约束，并按 file_path 分组（保持首次出现的文件序
 * 与文件内的编辑序）。
 * @param edits - schema 校验后的原始参数。
 * @returns Map<filePath, [{oldString, newString, replaceAll}]>
 */
export function groupEdits(edits) {
  const byFile = new Map()
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (e.file_path.trim().length === 0) throw new Error(`edits[${i}].file_path 不能为空`)
    if (e.old_string.length === 0) throw new Error(`edits[${i}].old_string 不能为空`)
    if (e.old_string === e.new_string) throw new Error(`edits[${i}] 的 old_string 与 new_string 相同，是保证无效的编辑`)
    const list = byFile.get(e.file_path) ?? []
    list.push({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all ?? false })
    byFile.set(e.file_path, list)
  }
  return byFile
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
    text: 'Use multi_edit instead of repeated edit calls when a change spans several replacements or several files (renames, signature changes, moving code). Edits are applied in order; each file is atomic — all of its edits land or none do, and files are reported individually. The same read-before-write rule applies to every file touched.',
  })

  ctx.tools.register(defineTool({
    name: 'multi_edit',
    description: 'Apply several literal text replacements in one call, possibly across files. '
      + 'Edits are applied in array order; within a file, later edits see the result of earlier ones. '
      + 'Each old_string must match exactly once unless replace_all is set. '
      + 'Per-file atomic: if any edit in a file fails, that whole file is left untouched; other files are still processed and every file\'s outcome is reported. '
      + 'Read each file first — the write is version-guarded, and editing an unread or changed file fails with the usual read-then-retry remedy.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        description: 'The replacements to apply, in order. Group edits to the same file contiguously for readability (grouping is by file_path either way).',
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
                error: { type: 'string' },
              },
            },
          },
        },
      },
      // render 是模型唯一能看到的返回通道：每个文件的结局都要在这里说清
      render: (_args, value) => {
        const lines = value.files.map(f => f.written
          ? `${f.path}: 已更新（${f.replacements} 处替换）`
          : `${f.path}: 未改动 —— ${f.error}`)
        const failed = value.files.filter(f => !f.written).length
        if (failed > 0) lines.push(`注意：${failed} 个文件未写入（按文件原子，失败文件一处未改）；已写入的文件不回滚。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const byFile = groupEdits(args.edits)
      if (byFile.size === 0) throw new Error('edits 不能为空')
      const files = []
      for (const [filePath, edits] of byFile) {
        const record = { path: filePath, written: false, replacements: 0 }
        files.push(record)
        try {
          // 与上游 tool-fs 一致：路径按调用方会话的 cwd 解析（无会话时回落后端默认）
          const sessionCwd = exec.agent?.session.header.cwd
          const target = await ctx.fs.resolve(filePath, {
            ...sessionCwd !== undefined ? { cwd: sessionCwd } : {},
            signal: exec.signal,
          })
          record.path = target.displayPath ?? filePath
          const content = await ctx.fs.readText(target, exec.signal)
          const applied = applyEdits(content, edits)
          if (!applied.ok) {
            record.error = applied.error
            continue
          }
          // 写意图走瀑布：fs-observation-policy 在这里挂上「先读后写 + 版本守卫」
          const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
          const outcome = await ctx.fs.writeText(target, applied.content, intent, exec.signal)
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
