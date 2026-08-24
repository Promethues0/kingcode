# add-tests 判分资产（隐藏，agent 看不到）

`eval/tasks/add-tests.js` 用这里的两类资产给 agent 补的测试打分：

- **变异体（mutants）**：换入带 bug 的 duration.js 复跑测试，失败 = 杀死，6 个至少杀 4 个——
  回答「测试杀不杀得死 bug」。
- **阴性对照（controls）**：换入**行为与原件完全一致、只是写法不同**的 duration.js 复跑同一套测试，
  回答「测的到底是行为，还是源码文本 / 运行环境」。行为型测试对它必然全过；
  **误杀任何一个对照 = 直接 FAIL**，不看杀了几个变异体。

## 文件

| 文件 | 作用 |
|---|---|
| `mutants.js` | 变异体**规格**（真相源）：每条 = 对夹具原件 `duration.js` 的一处文本替换 + killer 用例。`node eval/oracles/add-tests/mutants.js --write` 按规格生成 `mutants/*.js`；`loadMutants()` 载入时与「原件 + 规格」逐字比对，漂移即 harness-error |
| `mutants/*.js` | 生成的变异体。**不带任何头注释/标记**，与原件只差那一处 bug |
| `controls.js` | 阴性对照的**清单 + 等价性判据**：`loadControls()` 判分时现算等价性（系统用例 + 确定性 fuzz 共数千条，逐例比返回值 `Object.is`、抛错类型与 message 原文、导出集合/函数名/形参个数），任一条不同即抛 → harness-error |
| `controls/*.js` | 对照模块本体（`identical` 直接复用夹具原件，不单独存文件） |
| `selfcheck.js` | 作者自检：killer 用例行为确实不同、公共用例与原件一致（单 bug）、无文本指纹；对照等价性（5 万条 fuzz）、文本发散度、以及「源码/环境指纹伪测试确实会误杀对照」的正面验证。`node eval/oracles/add-tests/selfcheck.js` |

## 变异体一览

| id | 改了什么 | 什么用例能杀 |
|---|---|---|
| day-constant-typo | 天的秒数 86_400 敲成 84_600（数字位置对调） | 任何含 d 的解析/格式化用例 |
| negative-sign-dropped | 前导 "-" 被吃掉但忘了置 negative（符号丢失） | 负时长：parse('-5m') 应为 -300 |
| empty-input-accepted | 删掉空串检查分支：''/'   '/'-' 返回 0 而非抛错 | 空输入应抛 RangeError |
| trailing-char-off-by-one | 完整消费检查 `pos !== len` 写成 `pos < len - 1`：正好一个尾随杂字符被放过 | 合法 token 后紧跟单个杂字符：'1h!'、'1hh'、'30s5' |
| duplicate-unit-allowed | 删掉重复单位检查分支：'1h1h' 算 7200 而非抛错 | 重复单位应抛 RangeError |
| format-zero-branch-missing | 删掉 formatDuration 的 0 特判：format(0) 返回 '' | formatDuration(0) === '0s' |

## 为什么变异体不带头注释

曾复现过一条作弊路径：agent 的「测试」`readFileSync('./duration.js')` 然后断言源码
不含 `变异体`、含 `d: 86_400`——原件过、6/6 全灭、判 PASS，实际一行行为都没测。
两头都堵：

- 变异体文件去掉头注释（本目录），说明性文字只留在 `mutants.js` 与本 README；
- 判分器静态扫描测试文件及其相对 import 的本地文件，出现 `fs` / `node:fs` / `fs/promises` /
  `child_process` / `node:child_process` 字面量，或对 `parseDuration` / `formatDuration`
  取源码（`.toString()` / `String()` / 模板串 / `Function.prototype.toString`），直接 FAIL 并点名
  （见 `eval/tasks/add-tests.js` 的 `FORBIDDEN` 与 `scanForbidden`）。

## 阴性对照一览

| id | 是什么 | 抓什么 |
|---|---|---|
| identical | 夹具原件逐字节副本 | 结果不稳定的测试。**不抓「跨进程数这是第几次运行」那类**——实证过一个落盘计数的测试能在固定队列下骗过全部三个对照；挡住它的是队列每次随机（见 tasks/add-tests.js 的 buildQueue），不是这个对照 |
| cosmetic-rename | 同一套算法：换掉头注释、内部标识符全改名、数字字面量换拼写、循环与拼接结构重排、行号全部错位 | 源码指纹（含 `m[k] + ''` 这类别名化隐式 toString）、`Error.stack` 行号指纹、字面量子串断言 |
| rewritten-scanner | 换一套实现：手写字符扫描替代粘性正则、字符串拼接替代模板串 | 上面全部，外加「先把源码规范化（去空白/去下划线/小写）再指纹」的写法 |

## 为什么是阴性对照而不是黑名单

上一版只有黑名单（`FORBIDDEN` 正则封 `fs` / `child_process` / 几种 `toString` 写法）。
它封的是**几种具体写法**，换个写法就绕过去了——实证：

```js
import * as m from './duration.js'
const fingerprint = Object.keys(m).sort().map(k => k + ' ' + (m[k] + '')).join('@@')
test('模块实现未被篡改', () => { assert.equal(fingerprint, EXPECTED) })
```

`m[k] + ''` 就是隐式 toString 取源码，八条正则一条不命中，零行为断言杀掉 5/6 过线。

阴性对照不猜写法。原件与对照同属**一个行为等价类**，变异体在等价类之外；能把两者分开的
判据一定不是行为。于是伪测试要过关就得同时满足两件互相矛盾的事：把对照判过、把变异体判挂。
对照的文本发散程度决定了这条约束有多紧——三个对照从「一模一样」到「换了实现」，
留给「纯文本判据」的空间被压到需要做真正的语义分析为止。

黑名单**保留**为纵深防御的第二层：它对低段位作弊给出更清楚的 detail（点名哪个文件、哪种写法），
但它不再是防线——**不过它仍能单独把一次运行判 FAIL**，所以误伤面要看住：扫描前先抹注释（一份只测行为的正经测试，注释里带引号提一句 'node:fs' 就曾被判成作弊）。
