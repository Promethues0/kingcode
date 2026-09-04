#!/bin/bash
# 验一个 provision profile（.p7b）或一个已签名的 .hap 到底是不是「企业 MDM 发布」的。
#
# 为什么需要它：MDM 签名配错了 hvigor 照样 BUILD SUCCESSFUL，要等装机才蹦 9568289，白跑一轮。
#
# **看哪个字段（这里踩过坑，记牢）**：判据是 profile **顶层**的 `app-distribution-type`，
# 目标值 `enterprise_mdm`。**不是 bundle-info.app-feature** —— 本机 SDK 的两份模板
# （toolchains/lib/Unsgned{Debug,Released}ProfileTemplate.json）里 app-feature 都写死成
# hos_normal_app，它根本不区分 MDM，拿它核对会把一张正确的 MDM Profile 判成废的。
# 佐证：OpenHarmony EDM 源码用 APP_TYPE_ENTERPRISE_MDM = "enterprise_mdm" 按
# appDistributionType 判定；华为 appDistributionType 取值表也逐字含 enterprise_mdm。
#
# 另外两个「伪造不出来」的结构判据（比赌字符串取值可靠）：
#   - bundle-info 里 debug 用 `development-certificate`，release 用 `distribution-certificate`
#   - 顶层 `app-distribution-type` 这个键只在 release profile 里存在
#   - issuer 应为 app_gallery（自己拼的假 profile 通常是 pki_internal 之类）
#
# 用法：
#   ./mdm/check-profile.sh ~/Downloads/kingcode-mdm.p7b
#   ./mdm/check-profile.sh entry/build/default/outputs/default/entry-default-signed.hap
set -euo pipefail
F="${1:-}"
[ -n "$F" ] && [ -f "$F" ] || { echo "用法: $0 <profile.p7b | signed.hap>"; exit 1; }

python3 - "$F" <<'PY'
import sys, re, json, pathlib, datetime as dt
raw = pathlib.Path(sys.argv[1]).read_bytes()

def find_json(b: bytes):
    for m in re.finditer(rb'\{"version-name"', b):
        i, depth, j, instr, esc = m.start(), 0, m.start(), False, False
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
    print('❌ 没能从这个文件里解析出 provision JSON。确认路径是 .p7b 或已签名的 .hap。')
    sys.exit(2)

bi   = d.get('bundle-info', {})
val  = d.get('validity', {})
dist = d.get('app-distribution-type')          # ← 真正的判据，顶层
ptyp = d.get('type')                            # debug / release
cert_key = 'distribution-certificate' if 'distribution-certificate' in bi else (
           'development-certificate' if 'development-certificate' in bi else '(都没有)')
ids  = d.get('debug-info', {}).get('device-ids')

def line(k, v): print(f'  {k:<22} {v}')
print('=== provision 关键字段 ===')
line('app-distribution-type', dist if dist is not None else '(无此键 → 这是 debug profile)')
line('type', ptyp)
line('bundle-info 证书键', cert_key)
line('bundle-name', bi.get('bundle-name', '(无)'))
line('developer-id', bi.get('developer-id', '(无)'))
line('apl', bi.get('apl', '(无)'))
line('issuer', d.get('issuer', '(无)'))
line('app-feature', f"{bi.get('app-feature','(无)')}   ← 不是判据，两种 profile 都是 hos_normal_app")
if ids: line('device-ids', f'{len(ids)} 台（debug profile 才有；release 应为空）')
if val:
    U = dt.timezone.utc
    f = dt.datetime.fromtimestamp(val.get('not-before', 0), U).strftime('%Y-%m-%d')
    t = dt.datetime.fromtimestamp(val.get('not-after', 0), U).strftime('%Y-%m-%d')
    expired = dt.datetime.now(U).timestamp() > val.get('not-after', 0)
    line('validity', f'{f} → {t}' + ('   ⚠️ 已过期' if expired else ''))
acl = d.get('acls', {}).get('allowed-acls')
if acl: line('acls', ', '.join(acl))

print()
ok = True
if dist == 'enterprise_mdm':
    print('✅ app-distribution-type = enterprise_mdm —— 这是企业 MDM 发布 profile。')
else:
    ok = False
    print(f'❌ app-distribution-type = {dist!r}，需要 enterprise_mdm。')
    print('   用它签的包一旦声明 ENTERPRISE_MANAGE_APPLICATION，装机会报 9568289。')
    if dist == 'enterprise_normal':
        print('   注意：enterprise_normal 是「企业应用发布」，不是「企业MDM应用发布」，两者不同。')

if ptyp != 'release':
    ok = False; print(f'❌ type = {ptyp!r}，MDM 走发布流程，应为 release（debug 产物装不上）。')
if cert_key != 'distribution-certificate':
    ok = False; print(f'❌ bundle-info 里是 {cert_key}，release profile 应为 distribution-certificate。')
if bi.get('bundle-name') != 'com.kingcode.client':
    ok = False; print(f"❌ bundle-name = {bi.get('bundle-name')!r}，应为 com.kingcode.client（与 AppScope/app.json5 一致）。")
if d.get('issuer') != 'app_gallery':
    print(f"⚠️  issuer = {d.get('issuer')!r}，华为签发的应为 app_gallery。自己拼的假 profile 常见 pki_internal。")
if ids:
    print('⚠️  这份 profile 带着 device-ids（调试 profile 特征），release MDM profile 不该有。')

print()
print('✅ 全部通过，可以拿去构建。' if ok else '⛔ 有不通过项，先解决再构建——否则会到装机才失败。')
sys.exit(0 if ok else 1)
PY
