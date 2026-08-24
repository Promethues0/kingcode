/**
 * refactor-preserve 的「运行时加载追踪」——用 `--import` 预载进隐藏测试子进程，
 * 不改 test.js 一个字。
 *
 * 为什么要它：判分器要数「重构后还剩几份重复」，前提是知道**运行时到底加载了哪些代码**。
 * 静态正则猜不出来——`import(new URL('../stash/impl.js', import.meta.url).href)` 里
 * 没有任何字符串字面量说明符，源码扫描既数不出它、也不知道自己漏了东西。
 * 所以这里不猜，直接问 node 自己：挂一个 resolve hook，把**每一次模块解析的真实结果**
 * 记下来，判分器拿这张实测清单去核对。
 *
 * 用 `module.registerHooks`（同线程同步钩子）而不是 `module.register`（钩子跑在独立线程）：
 * 实测（node v24.15.0）前者能同时罩住 ESM import、`createRequire()` 的 CJS require，
 * 后者漏掉 CJS require——漏一条就等于给绕法留一扇门。符号链接由 node 自己解析成真身
 * （记录里直接是 realpath），`data:` 之类非文件来源也会原样出现在记录里，交给判分器判死。
 *
 * 记录直写 fd 2（`writeSync`，不经 process.stderr 的异步缓冲，worker/退出时不丢），
 * 每行 `#RPTRACE#{json}`。**刻意选 append-only 的 fd 而不是可写文件**：被测代码与钩子
 * 同在一个进程里，它能往 fd 2 多写几行假记录，却删不掉已经写出的真记录；而多出来的边
 * 只会让判分器的扫描范围变大，不会让藏在别处的实现消失。若改成写文件，被测模块在
 * 顶层 await 之后一句 truncate 就能把证据抹掉。
 *
 * 已知边界（判分器侧如实登记，不假装堵住）：绕过模块系统拿到源码的路径不在追踪范围内
 * ——`fs.readFileSync` + `eval` / `new Function` / `vm`，以及被测模块自己再注册一层
 * 转换钩子（后注册者先执行，可以不调用 next 就返回自造的源码）。这两类改的是「源码从哪来」，
 * 不是「模块从哪解析」，resolve hook 看不见。
 */

import { writeSync } from 'node:fs'
import { registerHooks } from 'node:module'

const MARK = '#RPTRACE#'

/** 一条记录：p = 发起方 URL（入口为 null），s = 原始说明符，u = 解析结果 URL。 */
const emit = (rec) => {
  try {
    writeSync(2, `${MARK}${JSON.stringify(rec)}\n`)
  } catch {
    // fd 2 写不进去（被关掉/管道断了）就静默——判分器那边收不到记录会当 harness-error 炸，
    // 不会因为这里吞了异常而误判成 agent 通过。
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    emit({ p: context?.parentURL ?? null, s: String(specifier), u: resolved.url })
    return resolved
  },
})
