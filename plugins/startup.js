/**
 * KingCode 启动插件：解析任务位置参数与 --help，发布 headlessStartup 服务
 * （沿用 dsh-headless runner 的注入名，runner 行无需改动）。
 * 参照上游 @deepseek-ai/dsh-headless/startup，换品牌命名。
 */

import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'kingcode-startup'
export const inject = ['cmdlineArgs']

function kingcodeCommand() {
  return new Command()
    .name('kingcode')
    .description('KingCode — a coding agent built on DeepSeek Harness. Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    // 任务文本里带 - 开头的词（如 `kingcode fix the --verbose flag`）不该被当成未知选项拒收
    .passThroughOptions()
    .addHelpText('after', `
Examples:
  kingcode "run the tests and fix any failure"
  kingcode --config ./other.cordis.yml "explain this repo"

Quote the whole task when it contains words starting with "-".
`)
}

export function apply(ctx) {
  const program = kingcodeCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: kingcode "run the tests"')
    ctx.provide('headlessStartup', { task })
  })
  parseCmdline(ctx, program)
}
