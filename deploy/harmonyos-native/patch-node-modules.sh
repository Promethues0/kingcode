#!/bin/sh
# KingCode 原生路线（鸿蒙 PC 的 HiShell，不经虚拟机）：给一棵 node_modules 打 openharmony 补丁。
#
#   sh deploy/harmonyos-native/patch-node-modules.sh                 # 仓库自己的 node_modules（CLI 形态，A 级）
#   sh deploy/harmonyos-native/patch-node-modules.sh --root <dir>    # 指定别的 node_modules，例如全局 dsh 的：
#                                                                    #   --root ~/.harmonybrew/lib/node_modules/@deepseek-ai/dsh/node_modules
#   sh deploy/harmonyos-native/patch-node-modules.sh [--root <dir>] --revert
#
# 幂等：每处补丁先看是否已打过；原件留 <file>.kc-orig，--revert 原样放回。
# 只动 node_modules，不动仓库源码；npm ci / npm install / npm i -g 之后要重跑一次。
#
# 每一处对应 2026-09-02 在真机（HUAWEI MateBook 14 / HarmonyOS 7.0.0.102 / API 26，
# HongMeng Kernel 1.13.0）上实测到的一个硬事实，见同目录 README.md：
#   ① koffi：dsh-subprocess-local 顶层 `import koffi` 且加载期调 `koffi.pointer("void")`；全局树里
#      dsh-win32-process 还在加载期断言两个 Win32 结构体的大小（DSH_STARTUPINFOW 104、
#      DSH_PROCESS_INFORMATION 24）。openharmony 没有原生产物，加载即炸；其余调用全在 win32 分支。
#      → 惰性桩：struct() 按名字查一张大小表让加载期断言过，win32 才用的 API 一律 throw，桩不碰 .node。
#   ② dsh-subprocess-local：同一文件里**两处** platform === "linux" 闸。createProcessInspector 对非
#      linux/darwin/win32 直接 throw（首次开终端时触发，响亮）；treeAlive 里「进程组只剩僵尸就判死」
#      那条精化不开则是静默降级（工具调用不收尾）。→ 两处都放开给 openharmony。
#   ③ dsh-session-persistence-jsonl：会话落盘用 link() 做原子发布；家目录（hmdfs）EPERM、
#      el2/base（hmfs）EACCES，鸿蒙全盘禁硬链接。→ link 失败即 open(wx)+rename，保住「不存在才创建」。
#   ④ dsh-fs-local：写工具新建文件同样走 link()。→ 同 ③。
#   ⑤ dsh-attachment-local（只在 Web 形态的全局树里）：附件落盘也走 link()。→ 同 ③，外加一处——
#      回退用 rename 搬走 temporary 后，紧跟的裸 unlink(temporary) 必抛 ENOENT，被外层翻成
#      ATTACHMENT_WRITE_FAILED（字节其实已落盘）。症状：新图第一次贴必失败、重贴一次就成功。
#   ⑥ @vscode/ripgrep：按 `@vscode/ripgrep-${platform}-${arch}/bin/rg` 解析平台包，没有
#      openharmony-arm64；fs-search 的 execPath 侧车只对 pkg 打包二进制生效。→ 放一个本地平台包，
#      bin/rg 软链到 Harmonybrew 的 ripgrep。
# 不在本脚本里但全局树还需要的：node-pty 现编（CC=clang CXX=clang++ npm rebuild node-pty）、
# sharp 的 WASM 后端（npm install --no-save @img/sharp-wasm32@<sharp 版本>）、DSH_PERMISSION_MODE=danger-full-access。
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$REPO/node_modules"
REVERT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --revert) REVERT=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done
[ -d "$ROOT/@deepseek-ai/dsh-subprocess-local" ] || { echo "patch: $ROOT 里没有 dsh 包（先 npm ci / npm install / npm i -g）"; exit 1; }
echo "node_modules：$ROOT"

if [ "$REVERT" = 1 ]; then
  n=0
  for f in "$ROOT/@deepseek-ai/dsh-subprocess-local/lib/index.js" \
           "$ROOT/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js" \
           "$ROOT/@deepseek-ai/dsh-fs-local/lib/index.js" \
           "$ROOT/@deepseek-ai/dsh-attachment-local/lib/index.js" \
           "$ROOT/koffi/index.js" "$ROOT/koffi/index.cjs"; do
    if [ -f "$f.kc-orig" ]; then mv -f "$f.kc-orig" "$f" && n=$((n+1)) && echo "REVERTED ${f#$ROOT/}"; fi
  done
  rm -rf "$ROOT/@vscode/ripgrep-openharmony-arm64" && echo "REMOVED  @vscode/ripgrep-openharmony-arm64"
  echo "revert: $n 个文件放回原件"
  exit 0
fi

KC_ROOT="$ROOT" node - <<'JS'
const fs = require('fs');
const path = require('path');
const ROOT = process.env.KC_ROOT;
let failed = 0;
function patch(rel, edits, { optional = false } = {}) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log((optional ? 'SKIP     ' : 'NOMATCH  ') + rel + (optional ? '（这棵树没有这个包）' : '（不存在）')); if (!optional) failed++; return; }
  const orig = file + '.kc-orig';
  let t = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [from, to, label] of edits) {
    if (t.includes(to)) { console.log(`ALREADY  ${label}`); continue; }
    if (!t.includes(from)) { console.log(`NOMATCH  ${label}  ← 上游文本变了，先核对 ${rel}`); failed++; continue; }
    t = t.replace(from, to); changed = true; console.log(`PATCHED  ${label}`);
  }
  if (changed) { if (!fs.existsSync(orig)) fs.copyFileSync(file, orig); fs.writeFileSync(file, t); }
}
const NM = '@deepseek-ai/';
const linkFallback = (from, to) => `try { await link(${from}, ${to}); } catch (error) { if (error.code !== "EPERM" && error.code !== "EACCES") throw error; const placeholder = await open(${to}, "wx"); await placeholder.close(); await rename(${from}, ${to}); }`;
// ② 终端检查器 + 进程树存活判定
// 这个文件里有**两处** `platform === "linux"` 闸，都要开给 openharmony：
//   :595 createProcessInspector —— 不开就在首次开终端时 throw（响亮）；
//   :882 treeAlive 的僵尸组精化 —— 不开是静默降级：判据退回只剩 kill(-pid, 0)，
//        进程组里只剩僵尸时 observeTreeExit 的 `while (treeAlive())` 不收敛，
//        表现为「bash 工具调用迟迟不收尾」，会被误诊成网络或模型问题。
patch(NM + 'dsh-subprocess-local/lib/index.js', [
  ['if (platform === "linux") return new LinuxProcessInspector(arch, internals);',
   'if (platform === "linux" || platform === "openharmony") return new LinuxProcessInspector(arch, internals);',
   'subprocess-local: openharmony → LinuxProcessInspector'],
  ['if (settled && platform === "linux" && linuxGroupHasLiveMembers(pid) === false) return false;',
   'if (settled && (platform === "linux" || platform === "openharmony") && linuxGroupHasLiveMembers(pid) === false) return false;',
   'subprocess-local: openharmony → 僵尸进程组判定（treeAlive）']]);
// ③ 会话落盘
patch(NM + 'dsh-session-persistence-jsonl/lib/index.js', [
  ['import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
   'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";',
   'persistence-jsonl: import rename'],
  ['\t\t\tawait link(tmp, finalPath);\n',
   '\t\t\t' + linkFallback('tmp', 'finalPath') + '\n',
   'persistence-jsonl: link → open(wx)+rename 回退']]);
// ④ 写工具新建文件
patch(NM + 'dsh-fs-local/lib/index.js', [[
  'const linkFile = internals.linkFile ?? link;',
  'const linkFile = internals.linkFile ?? (async (from, to) => { ' + linkFallback('from', 'to') + ' });',
  'fs-local: link → open(wx)+rename 回退']]);
// ⑤ 附件落盘（只在 Web 形态的全局树里有）——原代码只把 EEXIST 当可恢复，其余 rethrow
// 走回退时 rename 已经把 temporary 搬走，紧跟其后的裸 unlink(temporary) 必抛 ENOENT，
// 被外层 catch 统一翻成 ATTACHMENT_WRITE_FAILED——字节其实已经落盘了。症状是
// 「任何新图第一次贴报保存失败、同一张图重贴一次就成功」（第二次走 EEXIST 分支，
// temporary 还在），看起来像间歇性故障。所以这里必须连着改第二处。
patch(NM + 'dsh-attachment-local/lib/index.js', [
  ['\t\t\tawait link(temporary, target);\n\t\t} catch (error) {\n',
   '\t\t\ttry { await link(temporary, target); } catch (linkError) { if (linkError.code !== "EPERM" && linkError.code !== "EACCES") throw linkError; const placeholder = await open(target, "wx"); await placeholder.close(); await rename(temporary, target); }\n\t\t} catch (error) {\n',
   'attachment-local: link → open(wx)+rename 回退'],
  ['\t\tawait unlink(temporary);\n',
   '\t\tawait unlink(temporary).catch((cleanupError) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });\n',
   'attachment-local: 回退后的清理容忍 ENOENT']], { optional: true });
// ① koffi 桩
// koffi 的版本在上游是 `^3.1.0`（脱字号，不钉版），硬编码任何版本号都注定长期错
// （alpha.3 时是 3.1.6，alpha.5 已是 3.2.0）。桩只在排查时被人读到，取真值即可。
let koffiVersion = 'unknown';
try { koffiVersion = require(path.join(ROOT, 'koffi/package.json')).version; } catch { /* koffi 没装，下面会 NOMATCH */ }
const stubBody = `
// 加载期会被断言的 Win32 结构体大小（x64 ABI）；运行期这些路径在 openharmony 上永远走不到。
const KNOWN_SIZES = { DSH_STARTUPINFOW: 104, DSH_PROCESS_INFORMATION: 24, STARTUPINFOW: 104, PROCESS_INFORMATION: 24, PROCESSENTRY32W: 568, FILETIME: 8, SECURITY_ATTRIBUTES: 24 };
const type = (name, size) => ({ name: String(name), size: size ?? 0, kind: 'kingcode-koffi-stub' });
const typeName = (t) => (typeof t === 'string' ? t : (t && t.name) || 'void');
const unavailable = (fn) => () => { throw new Error('koffi stub: ' + fn + ' is unavailable on ' + process.platform + ' (native FFI not built; KingCode openharmony stub)'); };
const koffi = {
  pointer: (t) => type(typeName(t) + '*', 8),
  struct: (name, def) => { const n = typeof name === 'string' ? name : 'struct'; return type(n, KNOWN_SIZES[n]); },
  union: (name) => type(typeof name === 'string' ? name : 'union'),
  array: (t, n) => type(typeName(t) + '[' + n + ']'),
  opaque: (name) => type(name || 'opaque'),
  alias: (name) => type(name),
  proto: unavailable('proto'), disposable: unavailable('disposable'),
  sizeof: (t) => (t && t.size) || 0, alignof: () => 0, offsetof: () => 0, introspect: () => ({}),
  types: {}, internal: false, version: '${koffiVersion}-kingcode-openharmony-stub',
  load: unavailable('load'), alloc: unavailable('alloc'), encode: unavailable('encode'), decode: unavailable('decode'),
  call: unavailable('call'), register: unavailable('register'), unregister: () => {}, view: unavailable('view'),
  free: () => {}, address: () => 0n, as: (v) => v, reset: () => {}, config: () => ({}), stats: () => ({}),
  errno: () => 0, os: { errno: () => 0 },
};
`;
const esm = '// KingCode openharmony stub for koffi (original kept as index.js.kc-orig)\n' + stubBody + 'export default koffi;\n';
const cjs = '// KingCode openharmony stub for koffi (original kept as index.cjs.kc-orig)\n' + stubBody + 'module.exports = koffi; module.exports.default = koffi;\n';
for (const [rel, body] of [['koffi/index.js', esm], ['koffi/index.cjs', cjs]]) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) { console.log('NOMATCH  ' + rel + '（koffi 没装？）'); failed++; continue; }
  const cur = fs.readFileSync(f, 'utf8');
  if (cur.includes('kingcode-openharmony-stub') && cur.includes('KNOWN_SIZES')) { console.log('ALREADY  ' + rel); continue; }
  // 旧桩升级到新桩这条路上，cur 已经是桩了——备份它等于把假原件写进 .kc-orig，
  // 之后 --revert 会「恢复」出一个桩，真件再也拿不回来。宁可不备份。
  if (!fs.existsSync(f + '.kc-orig') && !cur.includes('kingcode-openharmony-stub')) fs.copyFileSync(f, f + '.kc-orig');
  fs.writeFileSync(f, body); console.log('PATCHED  ' + rel + (cur.includes('kingcode-openharmony-stub') ? '（升级到带大小表的桩）' : ''));
}
process.exit(failed ? 1 : 0);
JS
rc=$?

# ⑥ ripgrep 平台包
RG="$(command -v rg 2>/dev/null || true)"
if [ -z "$RG" ]; then echo "NOMATCH  ripgrep：PATH 上没有 rg（brew install ripgrep）"; rc=1
else
  PK="$ROOT/@vscode/ripgrep-openharmony-arm64"
  mkdir -p "$PK/bin"
  printf '{"name":"@vscode/ripgrep-openharmony-arm64","version":"1.18.0","description":"KingCode local shim: bin/rg is a symlink to the Harmonybrew ripgrep"}\n' > "$PK/package.json"
  ln -sf "$RG" "$PK/bin/rg" && echo "PATCHED  ripgrep 平台包 → $RG"
fi

echo
echo "自检（在 $ROOT 下解析）："
# 自检必须进退出码。以前这六行只是 console.log，`kc-hmos patch` 会带着一棵
# boot 不起来的树报成功——尤其 koffi 桩那一处**没有锚点校验**（它是整份覆盖，
# 不像 ②③④⑤ 靠 from 串 NOMATCH 报警），KNOWN_SIZES 将来对不上的唯一信号
# 就是下面 win32-process 那一行。
cd "$ROOT/.." || exit 1
CHECKS="$(
node -e 'try{require("node-pty");console.log("  node-pty      OK")}catch(e){console.log("  node-pty      "+((e.code==="MODULE_NOT_FOUND"&&/Cannot find module .node-pty./.test(e.message))?"（这棵树没有）":"FAIL: "+e.message+"（cd 到这棵树的根，CC=clang CXX=clang++ npm rebuild node-pty）"))}'
node -e 'import("koffi").then(m=>console.log("  koffi 桩      OK "+m.default.version+"  STARTUPINFOW="+m.default.struct("DSH_STARTUPINFOW").size)).catch(e=>console.log("  koffi 桩      FAIL: "+e.message))'
node -e 'import("@deepseek-ai/dsh-subprocess-local").then(()=>console.log("  subprocess    OK")).catch(e=>console.log("  subprocess    FAIL: "+e.message))'
node -e 'import("@deepseek-ai/dsh-win32-process").then(()=>console.log("  win32-process OK（全局树才有）")).catch(e=>console.log("  win32-process "+(e.code==="ERR_MODULE_NOT_FOUND"?"（这棵树没有）":"FAIL: "+e.message)))'
node -e 'import("@deepseek-ai/dsh-sandbox-local").then(()=>console.log("  sandbox-local OK（全局树才有）")).catch(e=>console.log("  sandbox-local "+(e.code==="ERR_MODULE_NOT_FOUND"?"（这棵树没有）":"FAIL: "+e.message)))'
node -e 'import("@vscode/ripgrep").then(m=>console.log("  ripgrep       OK "+m.rgPath)).catch(e=>console.log("  ripgrep       FAIL: "+e.message))'
node -e 'try{require("sharp");console.log("  sharp         OK")}catch(e){console.log("  sharp         "+(e.code==="MODULE_NOT_FOUND"?"（这棵树没有）":"FAIL: "+e.message.split("\n")[0]+"  → npm install --no-save @img/sharp-wasm32@<sharp 版本>"))}'
)"
printf '%s\n' "$CHECKS"
case "$CHECKS" in *FAIL*) echo; echo "patch: 自检有 FAIL —— 这棵树现在起不来，别往下走"; rc=1 ;; esac
exit $rc
