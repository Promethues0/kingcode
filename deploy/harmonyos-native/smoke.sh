#!/bin/sh
# 原生路线的判据（与虚拟机路径同一口径）：无钥烟测应恰好死在 MISSING_CREDENTIAL。
#   sh deploy/harmonyos-native/smoke.sh          # 无钥：期待 stderr 末行 kingcode: MISSING_CREDENTIAL、退出码 1
#   DEEPSEEK_API_KEY=sk-... sh deploy/harmonyos-native/smoke.sh   # 带钥：期待 stdout 有回答、退出码 0
# 只看退出码分不出「缺钥」和「runner 抛异常」（都是 1），所以这里按 stderr 末行判。
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
. "$REPO/deploy/harmonyos-native/env.sh"
RESULT="$DSH_HOME/smoke.result.json"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  KINGCODE_RESULT_FILE="$RESULT" node bin/kingcode.js "say hi"; rc=$?
  echo "退出码 $rc（带钥：0 = 有回答）"; cat "$RESULT" 2>/dev/null; echo
  exit $rc
fi
err="$(env -u DEEPSEEK_API_KEY KINGCODE_RESULT_FILE="$RESULT" node bin/kingcode.js "say hi" 2>&1 >/dev/null)"; rc=$?
last="$(printf '%s\n' "$err" | tail -1)"
printf '%s\n' "$err" | tail -8
cat "$RESULT" 2>/dev/null; echo
case "$last" in
  "kingcode: MISSING_CREDENTIAL"*) echo "PASS：整棵树 boot 成功，恰好死在 MISSING_CREDENTIAL（退出码 $rc）"; exit 0 ;;
  *) echo "FAIL：末行不是 MISSING_CREDENTIAL（退出码 $rc）——上面是 stderr 尾部"; exit 1 ;;
esac
