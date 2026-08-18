#!/usr/bin/env node
/**
 * KingCode 入口：`kingcode [--config path] "任务文本"`。
 * 组合树在 ../cordis.yml；boot 前先装 fail-loud、读调用目录的 .env
 * （DEEPSEEK_API_KEY 等），再把去掉自有旗标后的参数经 provideCmdline
 * 交给树内的 headless-startup 解析。stdout 是产品输出（最终回答），
 * 诊断一律走 stderr。
 */

import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const NAME = 'kingcode'

installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)

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
