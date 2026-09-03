#!/bin/bash
# 切换「MDM 模式」——把设备超级管理员扩展编进 KingCode 客户端。
#
# 默认（off）：包不带 EDM 扩展、不带 ENTERPRISE_MANAGE_APPLICATION 权限，用 DevEco
# 的普通调试/发布签名就能装。这是仓库的常态。
#
# on：把 mdm/EnterpriseAdminAbility.ets 放进 entry 源码树，并给 module.json5 加上
# 扩展声明与那条权限。**这之后的包只有 MDM 企业签名装得上**（provision 的
# app-feature = hos_enterprise_mdm），个人调试证书会在装机时报
# 9568289 grant request permissions failed。所以只有拿到企业开发者账号、
# 在 AGC 建了 MDM 应用、DevEco 里配了 MDM 签名的人才用得上。
#
# 用法：
#   ./mdm.sh on     # 打开 MDM 模式（改 module.json5 + 放扩展源码）
#   ./mdm.sh off    # 还原成默认（可安装）状态
#
# 打开之后的完整流程见 mdm/README.md。
set -euo pipefail
cd "$(dirname "$0")"

MOD="entry/src/main/module.json5"
EXT_DST="entry/src/main/ets/enterpriseadmin/EnterpriseAdminAbility.ets"
BEGIN='// >>> kc-mdm >>>'
END='// <<< kc-mdm <<<'

is_on() { grep -q 'enterpriseAdmin' "$MOD"; }

case "${1:-}" in
  on)
    if is_on; then echo "已经是 MDM 模式。"; exit 0; fi
    mkdir -p "$(dirname "$EXT_DST")"
    cp mdm/EnterpriseAdminAbility.ets "$EXT_DST"
    # 用 python 精确插入，避免 sed 处理 json5 的坑
    python3 - "$MOD" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding='utf-8')
perm = '''      {
        "name": "ohos.permission.INTERNET"
      }'''
perm_new = '''      {
        "name": "ohos.permission.INTERNET"
      },
      {
        // MDM 模式专用：把系统「终端」加进开机自启/保活白名单。只有 MDM 企业签名的包
        // 装得上；普通签名会报 9568289。用 ./mdm.sh off 去掉。
        "name": "ohos.permission.ENTERPRISE_MANAGE_APPLICATION"
      }'''
assert perm in s, 'INTERNET 权限块没找到'
s = s.replace(perm, perm_new)
ext = '"extensionAbilities": ['
ext_new = '''"extensionAbilities": [
      {
        "name": "EnterpriseAdminAbility",
        "srcEntry": "./ets/enterpriseadmin/EnterpriseAdminAbility.ets",
        "type": "enterpriseAdmin",
        "exported": true
      },'''
assert ext in s, 'extensionAbilities 没找到'
s = s.replace(ext, ext_new)
p.write_text(s, encoding='utf-8')
print('  module.json5 已改为 MDM 模式')
PY
    echo "MDM 模式已打开。下一步：用 MDM 企业签名构建（见 mdm/README.md）。"
    ;;
  off)
    if ! is_on; then echo "已经是默认（可安装）状态。"; exit 0; fi
    rm -f "$EXT_DST"
    rmdir "$(dirname "$EXT_DST")" 2>/dev/null || true
    python3 - "$MOD" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding='utf-8')
s = s.replace('''      },
      {
        // MDM 模式专用：把系统「终端」加进开机自启/保活白名单。只有 MDM 企业签名的包
        // 装得上；普通签名会报 9568289。用 ./mdm.sh off 去掉。
        "name": "ohos.permission.ENTERPRISE_MANAGE_APPLICATION"
      }''', '      }')
s = s.replace('''      {
        "name": "EnterpriseAdminAbility",
        "srcEntry": "./ets/enterpriseadmin/EnterpriseAdminAbility.ets",
        "type": "enterpriseAdmin",
        "exported": true
      },
''', '')
p.write_text(s, encoding='utf-8')
print('  module.json5 已还原为默认')
PY
    echo "已还原成默认（可安装）状态。"
    ;;
  *) echo "用法: ./mdm.sh on|off"; exit 1 ;;
esac
