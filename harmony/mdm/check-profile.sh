#!/bin/bash
# 验一个 provision profile（.p7b）或一个已签名的 .hap 到底是不是 MDM 的。
#
# 为什么需要它：MDM 签名配错了不会在构建时报错——hvigor 照样 BUILD SUCCESSFUL，
# 要等到装机才蹦出 9568289，白跑一轮。这个脚本直接把 profile 里的关键字段读出来，
# 构建前就能确认。
#
# 用法：
#   ./mdm/check-profile.sh ~/Downloads/kingcode_mdm.p7b
#   ./mdm/check-profile.sh entry/build/default/outputs/default/entry-default-signed.hap
#
# 要看的是这两行：
#   app-feature = hos_enterprise_mdm   ← 不是这个就拿不到 ENTERPRISE_* 权限
#   bundle-name = com.kingcode.client  ← 必须与 AppScope/app.json5 一致
set -euo pipefail
F="${1:-}"
[ -n "$F" ] && [ -f "$F" ] || { echo "用法: $0 <profile.p7b | signed.hap>"; exit 1; }

python3 - "$F" <<'PY'
import sys, re, json, pathlib
raw = pathlib.Path(sys.argv[1]).read_bytes()

# p7b 与 hap 里的 provision 都是一段内嵌 JSON，直接扫最外层的 {"version-name"... 块
# 找不到就退回：扫所有形如 "app-feature":"..." 的片段
def find_json(b: bytes):
    for m in re.finditer(rb'\{"version-name"', b):
        i = m.start()
        depth, j, instr, esc = 0, i, False, False
        while j < len(b):
            c = b[j:j+1]
            if instr:
                if esc: esc = False
                elif c == b'\\': esc = True
                elif c == b'"': instr = False
            else:
                if c == b'"': instr = True
                elif c == b'{': depth += 1
                elif c == b'}':
                    depth -= 1
                    if depth == 0:
                        try: return json.loads(b[i:j+1].decode('utf-8'))
                        except Exception: break
            j += 1
    return None

d = find_json(raw)
if d is None:
    # 退化路径：至少把关键字段捞出来
    for key in (b'app-feature', b'bundle-name', b'"type"'):
        for m in re.finditer(re.escape(key) + rb'"?\s*:\s*"([^"]{0,64})"', raw):
            print(f'  {key.decode()} = {m.group(1).decode()}')
    print('\n（没能解析出完整 profile JSON，上面是扫出来的片段）')
    sys.exit(0)

bi   = d.get('bundle-info', {})
val  = d.get('validity', {})
dbg  = d.get('debug-info', {})
feat = bi.get('app-feature', '(无)')

def line(k, v): print(f'  {k:<16} {v}')
print('=== provision 关键字段 ===')
line('app-feature', feat)
line('bundle-name', bi.get('bundle-name', '(无)'))
line('type', d.get('type', '(无)'))
line('issuer', d.get('issuer', '(无)'))
line('apl', bi.get('apl', '(无)'))
line('developer-id', bi.get('developer-id', '(无)'))
ids = dbg.get('device-ids')
if ids: line('device-ids', f'{len(ids)} 台（调试 profile 才有，绑 UDID）')
import datetime as dt
if val:
    U = dt.timezone.utc
    f = dt.datetime.fromtimestamp(val.get('not-before', 0), U).strftime('%Y-%m-%d')
    t = dt.datetime.fromtimestamp(val.get('not-after', 0), U).strftime('%Y-%m-%d')
    line('validity', f'{f} → {t}')
acl = d.get('acls', {}).get('allowed-acls')
if acl: line('acls', ', '.join(acl))

print()
if feat == 'hos_enterprise_mdm':
    print('✅ 这是 MDM profile —— 可以声明 ENTERPRISE_MANAGE_APPLICATION。')
else:
    print(f'❌ app-feature 是 {feat}，不是 hos_enterprise_mdm。')
    print('   用它签的包一旦声明 ENTERPRISE_MANAGE_APPLICATION，装机会报：')
    print('   9568289 install failed due to grant request permissions failed.')
if bi.get('bundle-name') and bi.get('bundle-name') != 'com.kingcode.client':
    print(f"⚠️  bundle-name 是 {bi.get('bundle-name')}，与本工程的 com.kingcode.client 不一致。")
PY
