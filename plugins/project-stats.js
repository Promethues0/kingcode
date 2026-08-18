/**
 * KingCode 自定义工具示例：project_stats —— 按扩展名统计目录下的源文件。
 * Loader 插件必须用具名导出（default export 会丢 inject）。
 * 策略（权限/超时）不写进工具本体，由组合里的 hook 插件负责。
 */

import { readdir } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'kingcode-project-stats'
export const inject = ['tools']

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'lib', '.next', 'coverage', '__pycache__'])

async function walk(dir, depth, maxDepth, counts, state, signal) {
  if (signal.aborted || depth > maxDepth) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 无权限/已删除的目录直接跳过
  }
  for (const entry of entries) {
    if (signal.aborted) return
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await walk(join(dir, entry.name), depth + 1, maxDepth, counts, state, signal)
      }
    } else if (entry.isFile()) {
      state.total += 1
      const ext = extname(entry.name) || '(无扩展名)'
      counts.set(ext, (counts.get(ext) ?? 0) + 1)
    }
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'project_stats',
    description: 'Count files by extension under a directory (skips node_modules, .git, build output). Useful for a quick overview of an unfamiliar codebase.',
    parameters: {
      dir: { type: 'string', description: 'Directory to scan; defaults to the working directory.' },
      maxDepth: { type: 'integer', description: 'Recursion depth limit; defaults to 6.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          fileCount: { type: 'integer', required: true },
          byExtension: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                extension: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.root}: ${value.fileCount} files\n`
          + value.byExtension.map(row => `${row.extension}: ${row.count}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const root = resolve(args.dir ?? process.cwd())
      const counts = new Map()
      const state = { total: 0 }
      await walk(root, 0, args.maxDepth ?? 6, counts, state, exec.signal)
      const byExtension = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([extension, count]) => ({ extension, count }))
      return { root, fileCount: state.total, byExtension }
    },
  }))
}
