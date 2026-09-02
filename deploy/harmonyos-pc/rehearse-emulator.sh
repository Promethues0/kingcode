#!/bin/bash
# KingCode 鸿蒙 PC 彩排 —— 在开发机（macOS）上用 DevEco 的 2in1 模拟器复验「宿主浏览器那半边」。
#
# 用法：
#   ./rehearse-emulator.sh [输出目录]     默认 ./rehearsal-<时间戳>/
#
# 旋钮（环境变量）：
#   HDC                    hdc 路径，默认 DevEco Studio 自带的那份
#   KINGCODE_PORT          服务端口，默认 3081
#   KINGCODE_LAN_IP        本机 LAN IP（不设就自动算；模拟器要按这个地址访问服务）
#   KINGCODE_HDC_TARGET    hdc 目标，默认取 `hdc list targets` 的第一台
#   KINGCODE_REHEARSE_WAIT aa start 之后等页面加载的秒数，默认 12
#
# 这在验什么：跨机访问链路里「宿主浏览器」那半边——真 ArkWeb 打开
# http://<服务机IP>:3081 之后，能换到浏览器会话 cookie、页面 200、KingCode 品牌、
# 不带 cookie 时被 401 挡住、/api 被信任栅栏放行、WebSocket 下行挂着。
# dsh 升级 / 品牌层改动 / preset 变更后跑一遍，十分钟内知道这条链路还活不活，
# 别再手敲 hdc。
#
# 角色对照（彩排与真机是镜像的，读报告前先对齐）：
#   真机：   服务在鸿蒙 PC 的虚拟机里，浏览器在鸿蒙宿主上
#   彩排：   服务在这台 Mac 上（kingcode-web.sh 起的），浏览器在 DevEco 的
#            2in1 模拟器里——模拟器扮演「鸿蒙宿主」，Mac 扮演「虚拟机」
#   没彩排到的：真机上「宿主能否访问虚拟机端口」那一跳（preflight.sh 第六节）
#
# 为什么是这套写法：
# - **hdc 的退出码不可信**：目标不存在（打印 [Fail]...）、aa start 失败
#   （打印 error: failed to start ability.）都退 0——实测。所以每一步 hdc 都按
#   输出文本判定，不看 $?。
# - **截图没法自动判读**：工作区有没有加载只能肉眼看，报告里给出判读口径，
#   不假装机器看得懂。
# - **只读动作**：对模拟器只做 aa start（开页面）、snapshot（截屏）、file recv
#   （取文件）。snapshot 会在客户机 /data/local/tmp 落一个固定名字的临时文件，
#   每次覆盖，不删（删也是一次写，留着反而干净）。副作用要知道：aa start 每跑
#   一次，客户机浏览器就多开一个标签页，并且新标签页会再弹一次 dsh 的内测声明
#   ——都是正常态，不是故障。
set -uo pipefail

HDC="${HDC:-/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc}"
PORT="${KINGCODE_PORT:-3081}"
TARGET="${KINGCODE_HDC_TARGET:-}"
WAIT="${KINGCODE_REHEARSE_WAIT:-12}"
OUT="${1:-./rehearsal-$(date +%Y%m%d-%H%M%S)}"

# 页面指纹：品牌来自 web-brand 的服务端半侧（webServer.tapIndex 改的 <title>）。
# 不在 = profile 没挂上这份交付（多半是 pull 完没重跑 profile/setup.sh），页面照样 200。
#
# 曾经这里还有一个 SHIM_MARK（垫片注入的标记）。垫片在 dsh 0.1.2-alpha.1 之后冗余
# 并删除，那条检查换成了「不带 cookie 必须 401」——见下面「未认证访问」那一步。
#
# 注意这个指纹只验服务端那半侧：侧栏与首页的 K 字标现在走的是客户端 slot
# （sidebar.brand.mark / sidebar.brand.name / conversation.hero.brand.mark），
# 静态 HTML 里看不到，只能靠最后那张截图肉眼确认。
BRAND_MARK='<title>KingCode</title>'
GUEST_TMP='/data/local/tmp/kingcode-rehearsal.jpeg'

case "${1:-}" in
  -h|--help) printf '用法: %s [输出目录]   （旋钮见文件头注释）\n' "${0##*/}"; exit 0 ;;
esac

die()  { printf '\033[31mrehearse: %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf 'rehearse: %s\n' "$*"; }

# ── 结果收集 ───────────────────────────────────────────────────────────────
# 每一步 pass/fail 都进 RESULTS，最后统一打报告；fail 当场就把「测的是什么 /
# 报错原文 / 下一步查哪」三件套打出来——报告只留一行结论，细节在失败现场。
RESULTS=()
FAILED=0
ok() {   # $1 步骤名  $2 一句话结论
  RESULTS+=("PASS  $1 —— $2")
  printf '  \033[32mPASS\033[0m  %s —— %s\n' "$1" "$2"
}
bad() {  # $1 步骤名  $2 这步测的是什么  $3 报错原文  $4 下一步查哪
  RESULTS+=("FAIL  $1")
  FAILED=1
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  printf '        这步测的是: %s\n' "$2"
  printf '        报错原文:   %s\n' "${3:-（无输出）}"
  printf '        下一步查:   %s\n' "$4"
}
# 前置条件断了就没有继续的意义：报出三件套，直接收工（不打汇总——一共就跑了这几步）。
fatal() { bad "$@"; die '前置自检没过，彩排没法继续（原因见上）'; }

# ── 浏览器会话 ─────────────────────────────────────────────────────────────
# dsh 0.1.2-alpha.1 起整个 Host API 都要一枚浏览器会话 cookie（`fix(web):
# authenticate the browser Host API`）。拿法：每进程随机一个 launch token，
# 就绪行里打出来，`GET /?token=…` 换一枚签名 cookie（HttpOnly / SameSite=Strict）。
# 所以彩排也得先换一次 cookie，否则从这里往下每一发请求都是 401。
#
# token 只在**当前进程**有效，服务重启就换一枚——所以每轮彩排都现取，不缓存。
COOKIE_JAR="$OUT/cookies.txt"

# 服务日志：彩排里服务就在这台 Mac 上，由 kingcode-web.sh 起，日志路径与它一致
# （$KINGCODE_STATE 或 $DSH_HOME/run，DSH_HOME 默认 ~/.kingcode）。
WEB_LOG="${KINGCODE_STATE:-${DSH_HOME:-$HOME/.kingcode}/run}/web.log"

# 从服务日志的**最后一条**就绪行里取 launch token。就绪行形如
#   dsh web: http://127.0.0.1:3081/?token=XXX (LAN: http://10.11.39.141:3081/?token=XXX)
# 取最后一条：日志是追加的，重启过的话前面那些 token 早就失效了。
launch_token() {
  grep -o 'token=[A-Za-z0-9_-]\{16,\}' "$WEB_LOG" 2>/dev/null | tail -1 | cut -d= -f2
}

# 用 token 换 cookie。换成功的判据是 303（换完重定向到干净的 /），
# 而不是最终 200——跟随重定向会把「换没换成」和「页面通不通」两件事混成一件。
exchange_cookie() {
  mkdir -p "$OUT"
  curl -s -o /dev/null -m 8 -w '%{http_code}' -c "$COOKIE_JAR" \
    "http://$1/?token=$2" 2>/dev/null
}

# ── /api 探针 ──────────────────────────────────────────────────────────────
# 与 kingcode-web.sh 的 probe_api 同一形状。**现在有两层，别混**：
#   403 = Host/Origin 栅栏没放行（DNS rebinding 防线，与方法名无关）
#   401 = 栅栏过了但没有浏览器会话 cookie
# 上游那份「钉死 loopback 的配置面」名单（PRIVILEGED_METHODS）在 0.1.2-alpha.1
# 被整段删掉了，所以不再有「某些方法天生 403」这回事。
# 不能写 `curl … || echo 连不上`：curl 失败时 -w 已经把 000 吐出来了。
probe_api() {
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -b "$COOKIE_JAR" \
    -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"rehearse","method":"agentPreset.list","payload":{}}' \
    "http://$1/api/agentPreset.list" 2>/dev/null)"
  case "$code" in
    ''|000) echo '连不上' ;;
    *)      echo "$code" ;;
  esac
}

# 来自模拟器的 ESTABLISHED 连接数。DevEco 模拟器做 NAT，客户机流量在 Mac 上
# 表现为「Emulator（qemu）进程 → 服务端口」的本机 TCP 连接——lsof 的 COMMAND
# 列就能认出它，不会把本机 curl / 浏览器误算进来。
emu_estab() {
  lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | awk '$1 ~ /[Ee]mulator|[Qq]emu/' | grep -c .
}

command -v curl >/dev/null 2>&1 || die '找不到 curl（macOS 自带，这台机器不对劲）'
command -v lsof >/dev/null 2>&1 || die '找不到 lsof（macOS 自带，这台机器不对劲）'
mkdir -p "$OUT" || die "建不了输出目录 $OUT"

printf '========== KingCode 模拟器彩排 %s ==========\n' "$(date '+%F %T')"

# ── 一、前置自检 ───────────────────────────────────────────────────────────
info '一、前置自检'

if [ -x "$HDC" ]; then
  ok 'hdc 在不在' "$HDC"
else
  fatal 'hdc 在不在' \
    'DevEco 的 hdc 命令行工具存不存在（后面所有客户机动作都靠它）' \
    "$HDC: 不存在或不可执行" \
    '装 DevEco Studio（自带 OpenHarmony SDK toolchains），或 HDC=/自己的/hdc 指过去'
fi

targets="$("$HDC" list targets 2>&1 | tr -d '\r')"
if [ -z "$targets" ] || printf '%s' "$targets" | grep -qE '^\[Empty\]|\[Fail\]'; then
  fatal '模拟器目标' \
    'hdc 有没有认到设备（没有设备，浏览器那半边就无从谈起）' \
    "$targets" \
    'DevEco Studio → Device Manager，起一台 2in1 模拟器（HarmonyOS 6.x），起完重跑'
fi
[ -n "$TARGET" ] || TARGET="$(printf '%s\n' "$targets" | head -n1)"
# 目标在列表里 ≠ 目标能用（模拟器关了、列表是陈的）。真打一发 echo 验通路；
# hdc 失败也退 0，所以按回显文本判定。
ping_out="$("$HDC" -t "$TARGET" shell "echo kc-ping" 2>&1 | tr -d '\r')"
if printf '%s' "$ping_out" | grep -q 'kc-ping'; then
  ok '模拟器目标' "$TARGET 可用"
else
  fatal '模拟器目标' \
    "hdc 目标 $TARGET 的 shell 通路是不是活的" \
    "$ping_out" \
    '模拟器是不是关了/重启过？hdc list targets 重新看一眼，换 KINGCODE_HDC_TARGET 指对'
fi

# 先换浏览器会话 cookie：0.1.2-alpha.1 之后，不带它的话下面每一发 /api 都是 401，
# 会把「服务没起」和「没登录」两件事混成一件。
TOKEN="$(launch_token)"
if [ -z "$TOKEN" ]; then
  fatal 'launch token' \
    "服务日志里有没有带 ?token= 的就绪行（换浏览器会话 cookie 要用它）" \
    "$WEB_LOG 里没找到 token=…" \
    "服务是 kingcode-web.sh 起的吗（日志路径由它决定）？手起的话把日志指过来：KINGCODE_STATE=<目录>。另外 dsh < 0.1.2-alpha.1 的就绪行没有 token，那种版本不需要这一步"
fi
exchange_code="$(exchange_cookie "127.0.0.1:$PORT" "$TOKEN")"
if [ "$exchange_code" = 303 ]; then
  ok '浏览器会话' "token 换到 cookie（303 → /），已存 $COOKIE_JAR"
else
  fatal '浏览器会话' \
    'launch token 能不能换到一枚浏览器会话 cookie（整个 Host API 都认它）' \
    "GET /?token=… → $exchange_code（期望 303）" \
    '401=token 不对：服务重启过就换了新的一枚，重跑本脚本即可（它每轮现取）。连不上=服务没起'
fi

api_local="$(probe_api "127.0.0.1:$PORT")"
if [ "$api_local" = 200 ]; then
  ok '本机服务' "127.0.0.1:$PORT /api → 200"
else
  fatal '本机服务' \
    "本机 $PORT 上的 KingCode Web 服务活不活（彩排的被测对象就是它）" \
    "/api → $api_local" \
    '401=cookie 没带上或已过期（看上一步）；其余：deploy/harmonyos-pc/kingcode-web.sh start 起服务，已经起了就 status 体检'
fi

# ── 二、Mac 侧链路（模拟器动手前，先证明服务这半边没问题）────────────────────
info '二、Mac 侧链路'

if [ -z "${KINGCODE_LAN_IP:-}" ]; then
  ifc="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  IP="$([ -n "$ifc" ] && ipconfig getifaddr "$ifc" 2>/dev/null)"
else
  IP="$KINGCODE_LAN_IP"
fi
if [ -n "${IP:-}" ]; then
  ok '本机 LAN IP' "$IP（模拟器将按这个地址访问服务）"
else
  fatal '本机 LAN IP' \
    '本机的 LAN 地址（模拟器 NAT 出来后要按它回连服务，127.0.0.1 在客户机里指模拟器自己）' \
    'route/ipconfig 都没给出地址' \
    '这台 Mac 联网了吗？或者手工 KINGCODE_LAN_IP=x.x.x.x 指定'
fi

page_code="$(curl -s -o "$OUT/index.html" -m 8 -w '%{http_code}' -b "$COOKIE_JAR" "http://$IP:$PORT/" 2>/dev/null)"
if [ "$page_code" = 200 ]; then
  ok '页面（Mac 侧）' "http://$IP:$PORT/ → 200，已存 $OUT/index.html"
else
  fatal '页面（Mac 侧）' \
    "按 LAN 地址取首页（Mac 自己都取不到的话，模拟器更不可能）" \
    "http=$page_code" \
    '401=cookie 没带上（看「浏览器会话」那步）；403=Host 栅栏（LAN IP 变过就重启服务）；其余：服务是不是只绑了 loopback（KINGCODE_BIND=loopback）？kingcode-web.sh status 看端口那行'
fi

# 这一步取代了老版的「垫片标记」。垫片（plugins/insecure-context-shim.js）在
# dsh 0.1.2-alpha.1 之后已冗余并删除，它当年的角色是「这份交付到底装上没有」的
# 页面指纹；现在换成一条更直接的安全断言：**不带 cookie 就必须 401**。
# 它同时能抓住两种真实故障：认证层根本没生效（回到裸奔），或者服务是老版本。
naked_code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$IP:$PORT/" 2>/dev/null)"
if [ "$naked_code" = 401 ]; then
  ok '未认证访问' "无 cookie 取首页 → 401（浏览器会话认证生效）"
else
  bad '未认证访问' \
    '不带浏览器会话 cookie 时首页是不是被挡住（挡不住 = 这台机器的 LAN 上谁都能用这个 agent）' \
    "无 cookie → $naked_code（期望 401）" \
    'dsh 是不是还在 0.1.2-alpha.1 之前？那种版本没有这层认证——升级，或者接受「绑 0.0.0.0 就等于对 LAN 敞开」'
fi

if grep -q "$BRAND_MARK" "$OUT/index.html"; then
  ok '品牌' "页面标题是 KingCode"
else
  bad '品牌' \
    '页面是不是 KingCode 的形状（不是的话，起的多半是裸 dsh 或别的 profile）' \
    "页面 200 但找不到 $BRAND_MARK" \
    '服务是不是用 --profile kingcode 起的？kingcode-web.sh 起的就该带；手起的检查命令行'
fi

api_lan="$(probe_api "$IP:$PORT")"
if [ "$api_lan" = 200 ]; then
  ok '信任栅栏（Mac 侧）' "$IP:$PORT /api → 200"
else
  bad '信任栅栏（Mac 侧）' \
    '按 LAN 地址打 /api 有没有被信任栅栏放行（403 的话页面照样开，工作区转圈）' \
    "/api → $api_lan" \
    '403=栅栏拦了：IP 是不是在服务启动后变过？重启服务（信任名单是启动那一刻的快照）。连不上=回头看上一步'
fi

# ── 三、客户机动作 ─────────────────────────────────────────────────────────
info '三、客户机动作（模拟器扮演鸿蒙宿主）'

# 基线要在 aa start 之前记：上一回彩排/手工开的标签页可能还挂着连接，
# 不记基线的话，本次就算什么都没发生，旧连接也会把最后一步糊弄成 pass。
estab_before="$(emu_estab)"
info "aa start 前，来自模拟器的 ESTABLISHED 基线：$estab_before 条"

# URL 必须带 ?token=：客户机浏览器是全新的，没有那枚 cookie，裸地址会被 401 挡住
# （0.1.2-alpha.1 起）。这与真机上用户的做法一致——第一次用就绪行里那条带 token 的
# 地址打开，换到 cookie 之后才可以用干净的 /。
aa_out="$("$HDC" -t "$TARGET" shell "aa start -A ohos.want.action.viewData -U 'http://$IP:$PORT/?token=$TOKEN' 2>&1" | tr -d '\r')"
if printf '%s' "$aa_out" | grep -q 'start ability successfully'; then
  ok '拉起客户机浏览器' "aa start → $IP:$PORT（带 launch token；会新开一个标签页并弹内测声明，正常）"
else
  bad '拉起客户机浏览器' \
    '用 viewData want 让客户机默认浏览器打开服务地址（hdc 失败也退 0，只能看回显）' \
    "$aa_out" \
    '客户机里装没装浏览器？桌面卡没卡死？截图那步照样会跑，看 guest.jpeg 里现在是什么'
fi

info "等 ${WAIT}s：页面要加载、WS 要挂上（改 KINGCODE_REHEARSE_WAIT 可调）"
sleep "$WAIT"

snap_out="$("$HDC" -t "$TARGET" shell "snapshot_display -f $GUEST_TMP" 2>&1 | tr -d '\r')"
if printf '%s' "$snap_out" | grep -q 'success: snapshot display'; then
  recv_out="$("$HDC" -t "$TARGET" file recv "$GUEST_TMP" "$OUT/guest.jpeg" 2>&1 | tr -d '\r')"
  if printf '%s' "$recv_out" | grep -q 'FileTransfer finish' && [ -s "$OUT/guest.jpeg" ]; then
    ok '客户机截屏' "已存 $OUT/guest.jpeg（$(wc -c < "$OUT/guest.jpeg" | tr -d ' ') 字节）"
  else
    bad '客户机截屏' \
      '把客户机真屏截图取回本机（这是判断工作区加载与否的唯一证据）' \
      "$recv_out" \
      "hdc file recv 单独重试一次：$HDC -t $TARGET file recv $GUEST_TMP ./guest.jpeg"
  fi
else
  bad '客户机截屏' \
    '客户机侧 snapshot_display 截真屏（没有它就没有肉眼判读的证据）' \
    "$snap_out" \
    '客户机 /data/local/tmp 满了？hdc shell df -h 看看；或换 KINGCODE_HDC_TARGET'
fi

lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED > "$OUT/lsof.txt" 2>/dev/null
estab_after="$(emu_estab)"
if [ "$estab_after" -ge 1 ] 2>/dev/null; then
  if [ "$estab_after" -gt "$estab_before" ] 2>/dev/null; then
    ok 'WS 下行' "模拟器 → :$PORT 有 $estab_after 条 ESTABLISHED（基线 $estab_before，本次新增了）"
  else
    ok 'WS 下行' "模拟器 → :$PORT 有 $estab_after 条 ESTABLISHED（基线 $estab_before，没观察到新增——挂着的可能是先前标签页的连接，结合 guest.jpeg 判读）"
  fi
else
  bad 'WS 下行' \
    "服务端口上有没有来自模拟器（Emulator/qemu 进程）的 ESTABLISHED 连接（WS 挂上才算真连通）" \
    "$(cat "$OUT/lsof.txt" 2>/dev/null || echo 'lsof 无输出')" \
    "页面打开了吗（看 guest.jpeg）？打开了还没连接，看浏览器控制台连的是不是别的地址；完整 lsof 在 $OUT/lsof.txt"
fi

# ── 四、汇总 ───────────────────────────────────────────────────────────────
{
  printf '\n========== 彩排报告 %s ==========\n' "$(date '+%F %T')"
  printf '服务 http://%s:%s  模拟器 %s  输出 %s\n\n' "$IP" "$PORT" "$TARGET" "$OUT"
  for line in "${RESULTS[@]}"; do printf '  %s\n' "$line"; done
  cat <<EOF

  肉眼判读（机器看不懂截图，这步免不了）：
    打开 $OUT/guest.jpeg——
    工作区列表有数据      = 整条链路通
    侧栏与首页是 K 字标   = 品牌 slot 在真 ArkWeb 里生效（静态 HTML 验不到这个，
                            只有截图能看；看到鲸鱼就是 web-brand 的客户端半侧没加载）
    页面是 401 / 空白     = 模拟器那边没有 cookie。真机上用户是拿带 ?token= 的地址
                            开的第一次，之后才靠 cookie；彩排里 aa start 传的也是那条
    工作区空转圈          = 看上面「信任栅栏」那步：403 是 Host 栅栏（IP 变了就重启
                            服务，信任名单是启动那一刻的快照）
    设置面板能改 key      = 正常态。上游那份钉死 loopback 的配置面名单
                            （PRIVILEGED_METHODS）在 0.1.2-alpha.1 已删，跨机也能改
    复制按钮点了没反应    = 已知限制，navigator.clipboard 卡 secure context，
                            上游没治，不影响会话
EOF
  if [ "$FAILED" -eq 0 ]; then
    printf '\n  结论：机器能验的全过。肉眼确认 guest.jpeg 后，这轮彩排就算完成。\n'
  else
    printf '\n  结论：有步骤没过（FAIL 行上方有三件套诊断），修完重跑。\n'
  fi
} | tee "$OUT/report.txt"

exit "$FAILED"
