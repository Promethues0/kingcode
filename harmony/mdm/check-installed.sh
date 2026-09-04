#!/bin/bash
# 装机之后在设备上复验：系统到底有没有把它当「企业 MDM 应用」。
#
# 为什么不能只信 .p7b：profile 对、签名过、装机成功，都不等于系统按 MDM 待遇发权限。
# 唯一的一手证据是设备侧 bm dump 里的三个字段。
#
# ⚠️ bm dump 读的是**当前已安装**的包。如果新包 install 失败了，它照样返回一整套漂亮
#    字段——全是上一次那个旧包的。所以下面把 versionCode 一并打出来，先核对是不是新包。
#
# 用法：./mdm/check-installed.sh
set -euo pipefail
HDC="${HDC:-/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc}"
[ -x "$HDC" ] || { echo "找不到 hdc：$HDC（用 HDC=/path 指定）"; exit 1; }

"$HDC" list targets 2>/dev/null | grep -qvE '^\s*(\[Empty\])?\s*$' \
  || { echo "❌ hdc 上没有设备。插好线、确认已授权 USB 调试再跑。"; exit 1; }

TMP="$(mktemp -t kcbmdump)"
trap 'rm -f "$TMP"' EXIT
"$HDC" shell "bm dump -n com.kingcode.client" > "$TMP" 2>/dev/null || true

python3 - "$TMP" <<'PY'
import sys, json, pathlib
t = pathlib.Path(sys.argv[1]).read_text(errors='replace')
i = t.find('{')
if i < 0:
    print('❌ 设备上没有 com.kingcode.client，或 hdc 没连上。'); sys.exit(2)
d = json.loads(t[i:])
app = d.get('applicationInfo', {})

def line(k, v): print(f'  {k:<22} {v}')

dist = app.get('appDistributionType')
prov = app.get('appProvisionType')
apl  = app.get('appPrivilegeLevel')
perms = [p['name'] for p in d.get('reqPermissionDetails', [])]
exts  = [f"{e.get('name')}({e.get('type')})"
         for m in d.get('hapModuleInfos', []) for e in m.get('extensionInfos', [])]

print('=== 设备上这个包的真实身份 ===')
line('versionName/Code', f"{d.get('versionName')} / {d.get('versionCode')}")
line('appDistributionType', dist)
line('appProvisionType', prov)
line('appPrivilegeLevel', apl)
line('已声明权限', ', '.join(perms) if perms else '(无)')
line('扩展', ', '.join(exts) if exts else '(无)')
print()

ok = True
if dist != 'enterprise_mdm':
    ok = False
    print(f'❌ appDistributionType = {dist!r}，需要 enterprise_mdm —— 系统没把它当 MDM 应用。')
else:
    print('✅ appDistributionType = enterprise_mdm')
if prov != 'release':
    ok = False
    print(f'❌ appProvisionType = {prov!r}，MDM 走发布流程，应为 release。')
if 'ohos.permission.ENTERPRISE_MANAGE_APPLICATION' not in perms:
    ok = False
    print('❌ 没有声明 ENTERPRISE_MANAGE_APPLICATION —— 是不是没 ./mdm.sh on 就构建了？')
if not any('nterpriseAdmin' in e for e in exts):
    ok = False
    print('❌ 没有 enterpriseAdmin 扩展 —— 同上，MDM 模式没打开。')
print()
print('✅ 可以 edm enable-admin 了。' if ok else '⛔ 先解决上面的问题；现在激活也调不动那些 API。')
sys.exit(0 if ok else 1)
PY
