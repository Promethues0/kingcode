#!/bin/sh
# KingCode 原生路线（鸿蒙 PC 的 HiShell，不经虚拟机）：给仓库 node_modules 打 openharmony 补丁。
#
# 在仓库根目录、HiShell 里跑：  sh deploy/harmonyos-native/patch-node-modules.sh
# 撤销：                        sh deploy/harmonyos-native/patch-node-modules.sh --revert
#
# 幂等：每处补丁先看是否已打过；原件留 <file>.kc-orig，--revert 原样放回。
# 只动 node_modules，不动仓库源码；npm ci / npm install 之后要重跑一次。
#
# 五处补丁，每一处对应 2026-09-02 在真机（HUAWEI MateBook 14 / HarmonyOS 7.0.0.102 / API 26，
# HongMeng Kernel 1.13.0）上实测到的一个硬事实，见同目录 README.md：
#   ① koffi：dsh-subprocess-local 顶层 `import koffi` 且加载期调 `koffi.pointer("void")`，
#      openharmony 没有原生产物、加载即炸；其余调用全在 win32 分支。→ 惰性桩，win32 才用的
#      API 一律 throw，桩本身不碰任何 .node。
#   ② dsh-subprocess-local：createProcessInspector 对非 linux/darwin/win32 直接 throw（首次开
#      终端时触发）。→ openharmony 走 LinuxProcessInspector（/proc 在，arm64 syscall 号同 Linux）。
#   ③ dsh-session-persistence-jsonl：会话落盘用 link() 做原子发布；家目录（hmdfs）EPERM、
#      el2/base（hmfs）EACCES，鸿蒙全盘禁硬链接。→ link 失败即 open(wx)+rename，保住「不存在才创建」。
#   ④ dsh-fs-local：写工具新建文件同样走 link()。→ 同 ③。
#   ⑤ @vscode/ripgrep：按 `@vscode/ripgrep-${platform}-${arch}/bin/rg` 解析平台包，没有
#      openharmony-arm64；fs-search 的 execPath 侧车只对 pkg 打包二进制生效。→ 放一个本地平台包，
#      bin/rg 软链到 Harmonybrew 的 ripgrep。
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
[ -d node_modules/@deepseek-ai/dsh-subprocess-local ] || { echo "patch: 先 npm ci / npm install，node_modules 里没有 dsh 包"; exit 1; }

if [ "${1:-}" = "--revert" ]; then
  n=0
  for f in node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js \
           node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js \
           node_modules/@deepseek-ai/dsh-fs-local/lib/index.js \
           node_modules/koffi/index.js node_modules/koffi/index.cjs; do
    if [ -f "$f.kc-orig" ]; then mv -f "$f.kc-orig" "$f" && n=$((n+1)) && echo "REVERTED $f"; fi
  done
  rm -rf node_modules/@vscode/ripgrep-openharmony-arm64 && echo "REMOVED  node_modules/@vscode/ripgrep-openharmony-arm64"
  echo "revert: $n 个文件放回原件"
  exit 0
fi

node - <<'JS'
const fs = require('fs');
let failed = 0;
function patch(file, edits) {
  const orig = file + '.kc-orig';
  let t = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [from, to, label] of edits) {
    if (t.includes(to)) { console.log(`ALREADY  ${label}`); continue; }
    if (!t.includes(from)) { console.log(`NOMATCH  ${label}  ← 上游文本变了，先核对 ${file}`); failed++; continue; }
    t = t.replace(from, to); changed = true; console.log(`PATCHED  ${label}`);
  }
  if (changed) { if (!fs.existsSync(orig)) fs.copyFileSync(file, orig); fs.writeFileSync(file, t); }
}
const NM = 'node_modules/@deepseek-ai/';
// ② 终端检查器
patch(NM + 'dsh-subprocess-local/lib/index.js', [[
  'if (platform === "linux") return new LinuxProcessInspector(arch, internals);',
  'if (platform === "linux" || platform === "openharmony") return new LinuxProcessInspector(arch, internals);',
  'subprocess-local: openharmony → LinuxProcessInspector']]);
// ③ 会话落盘
patch(NM + 'dsh-session-persistence-jsonl/lib/index.js', [
  ['import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
   'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";',
   'persistence-jsonl: import rename'],
  ['\t\t\tawait link(tmp, finalPath);\n',
   '\t\t\ttry { await link(tmp, finalPath); } catch (error) { if (error.code !== "EPERM" && error.code !== "EACCES") throw error; const placeholder = await open(finalPath, "wx"); await placeholder.close(); await rename(tmp, finalPath); }\n',
   'persistence-jsonl: link → open(wx)+rename 回退']]);
// ④ 写工具新建文件
patch(NM + 'dsh-fs-local/lib/index.js', [[
  'const linkFile = internals.linkFile ?? link;',
  'const linkFile = internals.linkFile ?? (async (from, to) => { try { await link(from, to); } catch (error) { if (error.code !== "EPERM" && error.code !== "EACCES") throw error; const placeholder = await open(to, "wx"); await placeholder.close(); await rename(from, to); } });',
  'fs-local: link → open(wx)+rename 回退']]);
// ① koffi 桩
const stubBody = `
const type = (name) => ({ name: String(name), size: 0, kind: 'kingcode-koffi-stub' });
const typeName = (t) => (typeof t === 'string' ? t : (t && t.name) || 'void');
const unavailable = (fn) => () => { throw new Error('koffi stub: ' + fn + ' is unavailable on ' + process.platform + ' (native FFI not built; KingCode openharmony stub)'); };
const koffi = {
  pointer: (t) => type(typeName(t) + '*'),
  struct: (name, def) => type(typeof name === 'string' ? name : 'struct'),
  union: (name) => type(typeof name === 'string' ? name : 'union'),
  array: (t, n) => type(typeName(t) + '[' + n + ']'),
  opaque: (name) => type(name || 'opaque'),
  alias: (name) => type(name),
  proto: unavailable('proto'), disposable: unavailable('disposable'),
  sizeof: () => 0, alignof: () => 0, offsetof: () => 0, introspect: () => ({}),
  types: {}, internal: false, version: '3.1.6-kingcode-openharmony-stub',
  load: unavailable('load'), alloc: unavailable('alloc'), encode: unavailable('encode'), decode: unavailable('decode'),
  call: unavailable('call'), register: unavailable('register'), unregister: () => {}, view: unavailable('view'),
  free: () => {}, address: () => 0n, as: (v) => v, reset: () => {}, config: () => ({}), stats: () => ({}),
  errno: () => 0, os: { errno: () => 0 },
};
`;
const esm = '// KingCode openharmony stub for koffi (original kept as index.js.kc-orig)\n' + stubBody + 'export default koffi;\n';
const cjs = '// KingCode openharmony stub for koffi (original kept as index.cjs.kc-orig)\n' + stubBody + 'module.exports = koffi; module.exports.default = koffi;\n';
for (const [f, body] of [['node_modules/koffi/index.js', esm], ['node_modules/koffi/index.cjs', cjs]]) {
  if (!fs.existsSync(f)) { console.log('NOMATCH  ' + f + '（koffi 没装？）'); failed++; continue; }
  const cur = fs.readFileSync(f, 'utf8');
  if (cur.includes('kingcode-openharmony-stub')) { console.log('ALREADY  ' + f); continue; }
  if (!fs.existsSync(f + '.kc-orig')) fs.copyFileSync(f, f + '.kc-orig');
  fs.writeFileSync(f, body); console.log('PATCHED  ' + f);
}
process.exit(failed ? 1 : 0);
JS
rc=$?

# ⑤ ripgrep 平台包
RG="$(command -v rg 2>/dev/null || true)"
if [ -z "$RG" ]; then echo "NOMATCH  ripgrep：PATH 上没有 rg（brew install ripgrep）"; rc=1
else
  PK=node_modules/@vscode/ripgrep-openharmony-arm64
  mkdir -p "$PK/bin"
  printf '{"name":"@vscode/ripgrep-openharmony-arm64","version":"1.18.0","description":"KingCode local shim: bin/rg is a symlink to the Harmonybrew ripgrep"}\n' > "$PK/package.json"
  ln -sf "$RG" "$PK/bin/rg" && echo "PATCHED  ripgrep 平台包 → $RG"
fi

echo
echo "自检："
node -e 'try{require("node-pty");console.log("  node-pty      OK")}catch(e){console.log("  node-pty      FAIL: "+e.message+"（先 cd node_modules/node-pty && CC=clang CXX=clang++ npx --no-install node-gyp rebuild）")}'
node -e 'import("koffi").then(m=>console.log("  koffi 桩      OK "+m.default.version)).catch(e=>console.log("  koffi 桩      FAIL: "+e.message))'
node -e 'import("@deepseek-ai/dsh-subprocess-local").then(()=>console.log("  subprocess    OK")).catch(e=>console.log("  subprocess    FAIL: "+e.message))'
node -e 'import("@vscode/ripgrep").then(m=>console.log("  ripgrep       OK "+m.rgPath)).catch(e=>console.log("  ripgrep       FAIL: "+e.message))'
exit $rc
