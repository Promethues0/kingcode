# add-tests 判分资产（隐藏，agent 看不到）

`eval/tasks/add-tests.js` 用这里的变异体给 agent 补的测试打分：换入变异体复跑测试，
失败 = 杀死，6 个至少杀 4 个。

## 文件

| 文件 | 作用 |
|---|---|
| `mutants.js` | 变异体**规格**（真相源）：每条 = 对夹具原件 `duration.js` 的一处文本替换 + killer 用例。`node eval/oracles/add-tests/mutants.js --write` 按规格生成 `mutants/*.js`；`loadMutants()` 载入时与「原件 + 规格」逐字比对，漂移即 harness-error |
| `mutants/*.js` | 生成的变异体。**不带任何头注释/标记**，与原件只差那一处 bug |
| `selfcheck.js` | 作者自检：killer 用例行为确实不同、公共用例与原件一致（单 bug）、无文本指纹。`node eval/oracles/add-tests/selfcheck.js` |

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
