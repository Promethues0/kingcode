#!/usr/bin/env node
/**
 * KingCode 入口：`kingcode [--config path] "任务文本"`。
 * 组合树在 ../cordis.yml；boot 前先装 fail-loud、读调用目录的 .env
 * （DEEPSEEK_API_KEY 等），再把去掉自有旗标后的参数经 provideCmdline
 * 交给树内的 headless-startup 解析。stdout 是产品输出（最终回答），
 * 诊断一律走 stderr。
 *
 * 退出码：0=完成且有回答；3=完成但零输出；4=触到 KINGCODE_DEADLINE_MS；
 * 130=SIGINT、143=SIGTERM（Unix 惯例 128+信号号）；1=其余。0/3/1 出自
 * plugins/runner.js 的纯函数 exitCodeFor，4/130/143 出自同文件的 windDown
 * 收尾路径（那三种结局 stdout 为空——只有 0 才意味着 stdout 上有回答）。
 *
 * 运行时旋钮：KINGCODE_QUIET=1 关掉 stderr 进度流（默认开）；
 * KINGCODE_DEADLINE_MS=<正整数毫秒> 给整次调用一个墙钟上限；
 * DSH_HOME=<路径> 换掉 KingCode 的 harness home（默认 ~/.kingcode）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const NAME = 'kingcode'

installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)

// KingCode 自己的 harness home。dsh 的默认 home 是 ~/.dsh，而它**跨产品共用**：
// 同机上另一个 dsh 产品把自己的领域预设装在 $DSH_HOME/.agent-presets 下、把默认
// 预设写进 $DSH_HOME/settings.yaml，共用就意味着 KingCode 的设置、凭证、会话跟
// 别人搅在一起，Web 形态的新会话还会直接开在别人的预设上（设置层优先于组合层）。
// 兜底而非强制：显式的 DSH_HOME 优先——.env 里的也算，所以这行必须排在 loadEnv 之后。
// 判据用「非空」而不是 ??=：resolveDshHome 把空串当没设，这里同口径，免得
// DSH_HOME= 静默落回 ~/.dsh。
if (!process.env['DSH_HOME']) process.env['DSH_HOME'] = join(homedir(), '.kingcode')

// 只认自己的 --config/-c，其余参数原样透传给树内的应用插件
const argv = process.argv.slice(2)
const args = []
let configArg
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--config' || argv[i] === '-c') {
    configArg = argv[++i]
    continue
  }
  args.push(argv[i])
}

const defaultConfig = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const app = { current: undefined }
const ctx = await boot(
  NAME,
  resolveConfigPath(configArg ?? defaultConfig, snapshotMode),
  undefined,
  (hostCtx) => {
    app.current = hostCtx
    provideCmdline(hostCtx, {
      args,
      exit: (code) => {
        void app.current?.fiber.dispose()
          .catch(() => {})
          .finally(() => process.exit(code))
      },
    })
  },
)
app.current = ctx
