#!/bin/bash
# KingCode Web 服务的起停 —— 给没有 systemd 的融合开发引擎用。
#
# 用法：
#   ./kingcode-web.sh start     启动（后台常驻，带看门狗）
#   ./kingcode-web.sh stop      停止（优雅，等它把会话 flush 完）
#   ./kingcode-web.sh restart
#   ./kingcode-web.sh status    进程 / 端口 / 就绪 / 跨机可达性 / IP 漂移 五项体检
#   ./kingcode-web.sh logs      跟踪日志
#   ./kingcode-web.sh url       打印宿主浏览器该开的地址（IP 每次开机会变）
#   ./kingcode-web.sh prune     清掉 N 天没动的会话目录（默认干跑，--yes 才真删；
#                               服务在跑时拒绝执行）
#
# 旋钮（环境变量）：
#   KINGCODE_PORT        监听端口，默认 3081
#   KINGCODE_BIND        all（默认，绑 0.0.0.0，宿主能访问）| loopback（只给本机）
#   DSH_HOME             harness home，默认 $HOME/.kingcode
#   KINGCODE_STATE       pid / 日志目录，默认 $DSH_HOME/run
#   KINGCODE_PRUNE_DAYS  prune 的保留天数，默认 30
#   KINGCODE_NODE_OPTS   附加给引擎 node 进程的旗标（追加进 NODE_OPTIONS，看门狗每次
#                        拉起引擎都带上）。几 GB 内存的虚拟机建议 --max-old-space-size=768：
#                        V8 默认堆上限随物理内存走（约一半），2GB 机上放任它长到 1GB+ 会
#                        先触发 OOM-killer 连累整机；封个顶让它改为干净 abort，看门狗接手重启
#   KINGCODE_LOG_MAX_BYTES  日志轮转阈值，默认 8388608（8 MiB；只留一代 .1，上限即 16 MiB）
#
# 为什么是这套写法，每一条都对着一个实测过的上游行为：
# - **nohup 是必需的**：dsh 不处理 SIGHUP，收到就直接死（退出码 129）。关掉终端
#   就等于杀服务，除非 SIGHUP 被挡在外面。
# - **看门狗只看退出码**：SIGTERM→0（人主动停的）、崩溃→非 0。所以「0 就收手、
#   非 0 才重启」是可靠判据，不需要探活去猜。
# - **就绪判据是日志里的 URL 行**，不是端口能连上：端口先开、整棵 Loader 树 settle
#   之后才打那一行，早了会连到一个还没装好的服务。
# - **日志只能 `>>` 追加 + copy-truncate 轮转**：dsh 没有 reopen 通道，而唯一能
#   充当 reopen 信号的 SIGHUP 会直接杀死它；用 `>` 打开时外部截断会留下 NUL 空洞。
# - **自己保证单实例**：同一个 $DSH_HOME 起两个实例会**双双成功**——harness home
#   这一级没有任何跨进程锁（跨进程写锁只覆盖 settings.yaml 与 .credentials.yaml），
#   而会话 jsonl 明确「一个会话只能有一个活写者」。
# - **/api 信任名单是启动那一刻的快照**：绑 0.0.0.0 时 dsh 把当时本机所有
#   non-internal IPv4 拍进名单。虚拟机 IP 变了（睡眠恢复、重连网络）服务不会察觉，
#   宿主浏览器从此收 403——status 与 url 会对比「就绪行里的 LAN IP」和「现在的
#   本机 IP」，不一致就大声提醒重启。
# - **prune 在服务运行时拒绝执行**：会话 jsonl 只允许一个活写者，跑着删等于在
#   写者脚下抽文件。保底再叠一层「只删 N 天没动的」——活会话的 mtime 不可能老。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 装机时写的 PATH 快照（install.sh 生成）。从 .bashrc / 计划任务里拉起时，
# 交互式 shell 的 PATH 不一定在，node 与 dsh 要靠它才找得到。
# shellcheck source=/dev/null
[ -f "$HOME/.kingcode/env.sh" ] && . "$HOME/.kingcode/env.sh"

DSH_HOME="${DSH_HOME:-$HOME/.kingcode}"
PORT="${KINGCODE_PORT:-3081}"
BIND="${KINGCODE_BIND:-all}"
STATE="${KINGCODE_STATE:-$DSH_HOME/run}"
LOG="$STATE/web.log"
SUP_PID="$STATE/supervisor.pid"
ENG_PID="$STATE/engine.pid"
STOP_FLAG="$STATE/stopping"
LOCK="$STATE/start.lock"
PATCH="$REPO/deploy/harmonyos-pc/bind-all.patch.yml"
LOG_MAX_BYTES="${KINGCODE_LOG_MAX_BYTES:-8388608}"   # 8 MiB
READY_LINE='dsh web: http://'
export DSH_HOME

die()  { printf '\033[31mkingcode-web: %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf 'kingcode-web: %s\n' "$*"; }

# 活着 = pid 文件在 + 进程在 + **那个进程确实是我们起的那个**。
# 第三项不能省：虚拟机重启后 pid 会被复用，只用 kill -0 判断的话，start 会拒绝启动
# （"已经在跑了"），stop 会 SIGTERM 掉一个毫不相干的进程，然后宣布"已优雅停"。
# $2 是命令行里必然出现的一段签名。
alive() {
  [ -f "$1" ] || return 1
  pid="$(cat "$1" 2>/dev/null)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  # `--` 是必需的：签名以 -- 开头（`--profile kingcode`），不加的话 grep 把它当选项，
  # 报 "unrecognized option" 并返回失败——于是活着的引擎会被判成"没在跑"。
  ps -p "$pid" -o args= 2>/dev/null | grep -qF -- "$2"
}
SUP_SIG='kingcode-web.sh'          # 看门狗是 `bash .../kingcode-web.sh __supervise`
ENG_SIG='--profile kingcode'       # 引擎是 `node .../dsh/lib/bin.js --profile kingcode ...`

# 日志里最后一条就绪行，以及 dsh 在那一刻拍进 /api 信任名单的 LAN IP。
# 就绪行长这样（alpha.2 起两半都带 token）：
#   `dsh web: http://127.0.0.1:3081/?token=… (LAN: http://10.0.0.42:3081/?token=…)`
# ——只认 `LAN: http://` 后面那段数字，127.0.0.1 那半截永远匹配不上；
# loopback 绑法的就绪行没有 LAN 半截，此时输出为空。
last_ready_line() { grep "$READY_LINE" "$LOG" 2>/dev/null | tail -1; }
trusted_lan_ip()  { last_ready_line | grep -o 'LAN: http://[0-9][0-9.]*' | sed 's|.*http://||'; }

# 就绪行里 loopback / LAN 那半截的**完整地址（含 ?token=）**。
# dsh 0.1.2-alpha.2 起整个 Host API 要一枚签名 cookie，loopback 也不豁免：
# 首次必须用带 token 的地址访问一次，换到 cookie（30 天）之后才能用干净地址。
ready_url_loopback() { last_ready_line | grep -o "http://127\.0\.0\.1:$PORT/[^ )]*" | head -1; }
ready_url_lan()      { last_ready_line | sed -n 's/.*(LAN: \([^)]*\)).*/\1/p' | head -1; }

# 拿 token 换一枚会话 cookie 落进临时 jar，回声 jar 路径；换不到就回声空。
# 调用方负责 rm。探针必须带上它，否则 /api 一律 401，看着像引擎死了。
mint_cookie_jar() {
  command -v curl >/dev/null 2>&1 || return 0
  u="$(ready_url_loopback)"; [ -n "$u" ] || return 0
  jar="$(mktemp 2>/dev/null)" || return 0
  code="$(curl -s -o /dev/null -c "$jar" -m 8 -w '%{http_code}' "$u" 2>/dev/null)"
  case "$code" in
    303|200) printf '%s' "$jar" ;;
    *)       rm -f "$jar" ;;
  esac
}

# 虚拟机自己的 IP，分两层：
# vm_ip_live 只认**现在**能量到的（iproute2 → hostname -I），量不到就失败——
#   IP 漂移检查只能用它：拿日志兜底去比日志，永远"没漂移"。
# vm_ip 在 live 失败时退回日志就绪行里的 LAN 地址——url/status 的展示场景里，
#   一个可能过期的地址也比整行空白强。
# 每一级都必须**先收进变量、验非空再返回**，不能写 `cmd | awk … && return 0`：
# 命令缺失时 pipefail 能救（127 传出来，降级继续），但「命令在、只是一时量不到
# 地址」时管道退 0 带空输出（awk 对空输入成功），降级链会在第一级带着空字符串
# 短路——而那正是睡眠恢复、网络刚断这种 IP 漂移检查最该说话的时刻（实测复现过：
# 空输入的管道退 0）。
vm_ip_live() {
  got="$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); print a[1]; exit}')"
  [ -n "$got" ] && { printf '%s\n' "$got"; return 0; }
  got="$(hostname -I 2>/dev/null | awk '{print $1; exit}')"
  [ -n "$got" ] && { printf '%s\n' "$got"; return 0; }
  return 1
}
vm_ip() {
  vm_ip_live && return 0
  trusted_lan_ip
}

# IP 漂移的警报（$1=信任名单里的，$2=现在的）。status 与 url 共用。
drift_warn() {
  printf '\033[31m  !! IP 变了：/api 信任名单是启动那一刻拍的快照（%s），本机现在是 %s。\n' "$1" "$2"
  printf '     宿主浏览器打新地址会被 403 挡住——重启服务（restart）才能刷新名单。\033[0m\n'
}

# 谁在监听 $PORT。ss（openEuler）优先，没有就退 lsof（macOS 彩排机没有 ss，
# 没这级降级的话「端口占用」检查与 status 的端口行在开发机上会整个静默跳过）。
# 两个工具都没有时输出空——调用方自己决定怎么说。
port_listeners() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | paste -sd' ' -
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | paste -sd' ' -
  fi
}

# 用数组而不是字符串：路径里有空格时 $(...) 展开会散架，而 die 在子 shell 里
# 也杀不掉父进程（看门狗会带着半条命令继续跑）。
ENGINE=()
build_engine_argv() {
  if [ "$BIND" = all ]; then
    [ -f "$PATCH" ] || die "找不到绑定覆盖层 $PATCH（仓库不完整？）"
    ENGINE=(dsh --profile kingcode --patch "$PATCH")
    # 这里曾经还有一个 KINGCODE_CREDENTIAL_BRIDGE=1 的覆盖层（凭证桥）。它存在的
    # 唯一理由是上游把 credentials.* / settings.* / llm.discoverModels 钉死在
    # loopback（PRIVILEGED_METHODS），跨机填 key 无路可走。dsh 0.1.2-alpha.2 的
    # `fix(web): authenticate the browser Host API` 把那份名单整段删了。**但跨机仍然
    # 不能用 Models 页填 key**：浏览器半侧按页面 hostname 把非 loopback 的设置面降级成
    # memory（dsh-client-ui-settings/lib/client.js:1345），请求根本不发。桥是服务端半侧
    # 的东西、治不了那道闸，退役的真实理由是与上游新认证模型重叠。跨机填 key 走服务侧
    # .credentials.yaml 落盘（见 deploy README「填 API key 的两条路」的第②条）。
    ENGINE+=(--port "$PORT")
  else
    ENGINE=(dsh --profile kingcode --port "$PORT")
  fi
}

rotate_log() {
  [ -f "$LOG" ] || return 0
  size="$(wc -c < "$LOG" 2>/dev/null || echo 0)"
  [ "$size" -gt "$LOG_MAX_BYTES" ] || return 0
  # copy-truncate：进程还攥着这个 fd，mv 之后它会继续往旧 inode 写
  cp "$LOG" "$LOG.1" 2>/dev/null && : > "$LOG"
  info "日志超过 $LOG_MAX_BYTES 字节，已轮转到 $LOG.1"
}

# ── 看门狗（内部子命令，不给人直接调）──────────────────────────────────────
# 收到停止信号：转发给引擎，**并且等它真的走完**。
# 必须在这里等，不能指望下面的 `wait`：bash 的 `wait` 被 trap 打断会立刻返回
# 128+信号号（143），此时引擎才刚开始优雅退出（上游给的上限是 5s，期间要 flush
# 会话 jsonl）。不等的话看门狗会先一步退干净，外面的 stop 就会在引擎还在写盘时
# 宣布「已停，会话已 flush」——一句会骗人的话。
on_stop() {
  touch "$STOP_FLAG"
  [ -f "$ENG_PID" ] || return 0
  stopping="$(cat "$ENG_PID" 2>/dev/null)"
  [ -n "$stopping" ] || return 0
  kill -TERM "$stopping" 2>/dev/null
  for _ in $(seq 1 12); do
    kill -0 "$stopping" 2>/dev/null || return 0
    sleep 1
  done
  printf '[%s] kingcode-web: 引擎 12s 内没退干净，交给外层强杀\n' "$(date '+%F %T')"
}

supervise() {
  build_engine_argv
  # 引擎专属的 Node 旗标。追加而不是覆盖：外面可能已经有 NODE_OPTIONS。放在这里
  # 而不是 start()：看门狗的每一次重启都要带上，不只第一次。dsh 运行期 spawn 的
  # 子进程里没有别的 node（bash 是 pty、LSP 是原生 tsc 二进制），实际只作用于引擎。
  [ -n "${KINGCODE_NODE_OPTS:-}" ] && export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$KINGCODE_NODE_OPTS"
  fails=0
  trap on_stop TERM INT
  while :; do
    started="$(date +%s)"
    printf '\n[%s] kingcode-web: 启动引擎 %s%s\n' "$(date '+%F %T')" "${ENGINE[*]}" "${NODE_OPTIONS:+  (NODE_OPTIONS: $NODE_OPTIONS)}"
    "${ENGINE[@]}" &
    engine=$!
    echo "$engine" > "$ENG_PID"
    wait "$engine"; code=$?
    rm -f "$ENG_PID"

    if [ -f "$STOP_FLAG" ]; then
      # 这里刻意不报 $code：被 trap 打断的 wait 返回的是 128+信号号（外层 stop 时
      # 恒为 143），那是 shell 的说法、不是引擎的结局，报出来会误导排障的人。
      printf '[%s] kingcode-web: 收到停止指令，引擎已退出，看门狗收工\n' "$(date '+%F %T')"
      break
    fi
    if [ "$code" -eq 0 ]; then
      printf '[%s] kingcode-web: 引擎以 0 退出（视作人主动停的），看门狗收工\n' "$(date '+%F %T')"
      break
    fi

    ran=$(( $(date +%s) - started ))
    if [ "$ran" -lt 10 ]; then fails=$(( fails + 1 )); else fails=0; fi
    if [ "$fails" -ge 5 ]; then
      printf '[%s] kingcode-web: 连续 5 次在 10s 内崩溃（退出码 %s），不再重启——去看上面的报错\n' "$(date '+%F %T')" "$code"
      break
    fi
    printf '[%s] kingcode-web: 引擎异常退出（码 %s，活了 %ss），2s 后重启\n' "$(date '+%F %T')" "$code" "$ran"
    # 崩溃重启环里也要轮转：start() 只在拉起那一刻轮转一次，而 dsh 平时几乎不写
    # stdout（实测三天 21KB），长跑中唯一能把日志顶过上限的就是这里——每次崩溃都
    # 写一段栈，无人值守跑上几天就能越过 8 MiB，之后一直涨到下一次 start。
    # 只放崩溃分支、不放环顶：首轮轮转会作废 start() 记下的就绪偏移 mark。
    rotate_log
    sleep 2
  done
  rm -f "$SUP_PID" "$ENG_PID" "$STOP_FLAG"
}

# ── start ──────────────────────────────────────────────────────────────────
start() {
  command -v dsh >/dev/null 2>&1 || die '找不到 dsh。先跑 install.sh，或 . ~/.kingcode/env.sh'
  [ -d "$DSH_HOME/profiles/kingcode" ] || die "$DSH_HOME/profiles/kingcode 不存在——先跑仓库里的 profile/setup.sh"
  # 预设缺失是个**不响的失败**：服务照常起、页面照常是 KingCode 品牌，但预设列表里
  # 既没有 KingCode 也没有任何默认项（实测：只剩上游四个 system 预设，全部
  # isDefault=false）。在这里拦住，比让用户开着一个残废的 UI 去猜强。
  [ -d "$DSH_HOME/.agent-presets/kingcode" ] || die "$DSH_HOME/.agent-presets/kingcode 不存在——KingCode 预设没装上，新会话会没有默认预设。跑 profile/setup.sh 补上"
  # 原子锁：mkdir 在同一目录下是原子的，两次 start 抢跑时只有一个能建成。
  # 没有它的话「先 nohup 再写 pid 文件」中间那道缝会让两个看门狗同时起来，
  # 而 pid 文件只记得住后写的那个——另一对看门狗+引擎从此再也停不掉。
  mkdir -p "$STATE" || die "建不了状态目录 $STATE"
  mkdir "$LOCK" 2>/dev/null || die "另一个 start 正在进行（锁 $LOCK）。它若是上次崩溃留下的，rmdir 掉再试"
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT

  alive "$SUP_PID" "$SUP_SIG" && die "已经在跑了（看门狗 pid $(cat "$SUP_PID")）。要重来用 restart"
  busy="$(port_listeners)"
  [ -n "$busy" ] && die "端口 $PORT 已被别的进程占用（$busy）——换 KINGCODE_PORT，或先停掉那个进程"

  rotate_log
  rm -f "$STOP_FLAG"

  # 就绪判据只许看**本轮**日志：日志是追加的，上一轮的就绪行还躺在里面，
  # 拿整个文件 grep 会让第二次 start 与每一次 restart 立刻误判为"已就绪"，
  # 于是在引擎根本没起来的情况下打印 URL 并退 0。记下起跑前的字节偏移。
  [ -f "$LOG" ] || : > "$LOG"
  mark="$(wc -c < "$LOG" 2>/dev/null || echo 0)"
  mark="${mark//[^0-9]/}"

  nohup bash "${BASH_SOURCE[0]}" __supervise >> "$LOG" 2>&1 &
  echo $! > "$SUP_PID"
  info "看门狗 pid $(cat "$SUP_PID")，日志 $LOG"

  # 就绪判据：日志里出现 URL 行。同时盯着看门狗别死了。
  for _ in $(seq 1 60); do
    if tail -c "+$((mark + 1))" "$LOG" 2>/dev/null | grep -q "$READY_LINE"; then
      info '引擎就绪'
      url
      return 0
    fi
    alive "$SUP_PID" "$SUP_SIG" || { printf '\n--- 本轮日志 ---\n'; tail -c "+$((mark + 1))" "$LOG" | tail -25; die '看门狗已退出，服务没起来（上面是本轮日志）'; }
    sleep 1
  done
  printf '\n--- 本轮日志 ---\n'; tail -c "+$((mark + 1))" "$LOG" | tail -25
  die '等了 60s 还没看到就绪那一行（上面是本轮日志）'
}

# ── stop ───────────────────────────────────────────────────────────────────
stop() {
  if ! alive "$SUP_PID" "$SUP_SIG"; then
    # 看门狗没了不等于服务没了：它被 SIGKILL 掉时引擎会被重父到 PID 1 继续监听。
    # 这种时候报"本来就没在跑"并删掉 engine.pid，等于亲手把唯一的线索毁掉，
    # 留下一个还占着端口、谁也停不掉的孤儿。
    if alive "$ENG_PID" "$ENG_SIG"; then
      orphan="$(cat "$ENG_PID")"
      info "看门狗不在了，但引擎还活着（pid $orphan，孤儿）。直接停引擎"
      kill -TERM "$orphan" 2>/dev/null
      for _ in $(seq 1 12); do
        kill -0 "$orphan" 2>/dev/null || { info '孤儿引擎已停'; rm -f "$SUP_PID" "$ENG_PID" "$STOP_FLAG"; return 0; }
        sleep 1
      done
      kill -KILL "$orphan" 2>/dev/null
      info '孤儿引擎强杀'
      rm -f "$SUP_PID" "$ENG_PID" "$STOP_FLAG"
      return 0
    fi
    info '本来就没在跑'
    rm -f "$SUP_PID" "$ENG_PID" "$STOP_FLAG"
    return 0
  fi
  touch "$STOP_FLAG"
  kill -TERM "$(cat "$SUP_PID")" 2>/dev/null
  for _ in $(seq 1 20); do
    alive "$SUP_PID" "$SUP_SIG" || { info '已停（引擎优雅退出，会话已 flush）'; rm -f "$STOP_FLAG"; return 0; }
    sleep 1
  done
  info '20s 内没停下来，强杀'
  [ -f "$ENG_PID" ] && kill -KILL "$(cat "$ENG_PID")" 2>/dev/null
  kill -KILL "$(cat "$SUP_PID")" 2>/dev/null
  rm -f "$SUP_PID" "$ENG_PID" "$STOP_FLAG"
  info '已强杀——会话 jsonl 的尾巴可能缺一小段（崩溃恢复会截断并补一条修复记录）'
}

# ── status ─────────────────────────────────────────────────────────────────
# $1 = authority（host:port），$2 = cookie jar（可空）
probe_api() {
  command -v curl >/dev/null 2>&1 || { echo '无 curl'; return; }
  # 端点名是 `<namespace>/<method>` 的规范形式，且请求体里的 method 必须与它逐字相同
  # （不一致时网关回 `method "x" does not match endpoint "y"`）。老的 `agentPreset.list`
  # 在 alpha.3 上是 404——那是探针写错了，不是引擎坏了。
  # 不能写 `curl … || echo '连不上'`：curl 失败时 -w 已经把 000 吐出来了，
  # 再 echo 一句就拼成 `000连不上` 这种半截话。先收进变量再判。
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    ${2:+-b "$2"} \
    -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"probe","method":"agentPresets/list","payload":{}}' \
    "http://$1/api/agentPresets/list" 2>/dev/null)"
  case "$code" in
    ''|000) echo '连不上' ;;
    401)    echo '401（认证生效、这次没带上 cookie——引擎是活的）' ;;
    *)      echo "$code" ;;
  esac
}

status() {
  printf '  %-14s %s\n' '看门狗' "$(alive "$SUP_PID" "$SUP_SIG" && echo "在跑 (pid $(cat "$SUP_PID"))" || echo '没在跑')"
  printf '  %-14s %s\n' '引擎'   "$(alive "$ENG_PID" "$ENG_SIG" && echo "在跑 (pid $(cat "$ENG_PID"))" || echo '没在跑')"
  if command -v ss >/dev/null 2>&1 || command -v lsof >/dev/null 2>&1; then
    # 不能写 `... || echo '没在听'`：没人监听时 ss/lsof 输出为空但管道退 0，
    # 那个兜底永远不触发，打印出来的是一个空字段——看着像"这项没查"，其实是"没在听"。
    listen="$(port_listeners)"
    printf '  %-14s %s\n' "端口 $PORT" "${listen:-没在听}"
  else
    printf '  %-14s %s\n' "端口 $PORT" '没有 ss / lsof——这项没查成'
  fi
  # 就绪行同理不能 `grep | tail || echo`：tail 对空输入照样退 0，兜底永远不触发，
  # 没有就绪行时这里会打出一个空字段。另外就绪行是**追加日志里最后一条**——
  # 引擎没在跑时它只是历史，不加说明的话五行体检里四行说"死了"、这行却贴着
  # 一个活生生的 URL，谁看谁迷糊。
  ready="$(last_ready_line)"
  if [ -n "$ready" ] && ! alive "$ENG_PID" "$ENG_SIG"; then
    ready="$ready  ←历史记录（引擎现在没在跑）"
  fi
  printf '  %-14s %s\n' '就绪行' "${ready:-日志里还没有}"
  # 探针必须带 cookie：alpha.2 起 /api 无 cookie 一律 401，不带就永远读成「死了」。
  JAR="$(mint_cookie_jar)"
  printf '  %-14s %s\n' '本机 /api' "$(probe_api "127.0.0.1:$PORT" "$JAR")  （200 才算真活着）"
  if [ "$BIND" = all ]; then
    ip="$(vm_ip)"
    if [ -n "$ip" ]; then
      code="$(probe_api "$ip:$PORT" "$JAR")"
      # 这一探针是在虚拟机内部打虚拟机自己的 IP：它证明的是「绑对了 + 信任栅栏放行
      # 这个 authority」，**不**证明宿主到虚拟机那条路通——那条只能在宿主的浏览器里试
      # （preflight.sh 第六节）。别把这行读成「宿主能访问了」。
      # 注意 401 在这里是正常的：cookie 与 host:port 绑定，拿 127.0.0.1 换来的那枚
      # 对 LAN authority 不成立——能收到 401 恰好说明栅栏放行了（没放行是 403）。
      printf '  %-14s %s\n' '本机打 LAN 口' "$ip:$PORT → $code  （403=信任栅栏拦了；401=栅栏已放行、只是 cookie 不通用；连不上=没绑对或防火墙。此项不证明宿主可达）"
    else
      printf '  %-14s %s\n' '跨机 /api' '量不到本机 IP（没有 ip / hostname，日志里也没有 LAN 行）——这项没查成'
    fi
    # IP 漂移：信任名单是启动快照，睡眠恢复/重连网络后 IP 变了服务不会察觉，
    # 宿主只会开始收 403 而这里毫无迹象——所以专门比一次。只在引擎活着时比
    # （死了谈不上名单），只用 vm_ip_live（拿日志兜底去比日志永远相等，是自欺）。
    if alive "$ENG_PID" "$ENG_SIG"; then
      trusted="$(trusted_lan_ip)"
      if [ -n "$trusted" ]; then
        if live="$(vm_ip_live)"; then
          if [ "$live" = "$trusted" ]; then
            printf '  %-14s %s\n' 'IP 漂移' "没有（信任名单与当前 IP 一致：$live）"
          else
            drift_warn "$trusted" "$live"
          fi
        else
          printf '  %-14s %s\n' 'IP 漂移' '量不到本机当前 IP（没有 ip / hostname -I）——检查不了'
        fi
      fi
    fi
  fi
  [ -n "${JAR:-}" ] && rm -f "$JAR"
}

# ── url ────────────────────────────────────────────────────────────────────
# 递出去的必须是**带 token 的完整地址**：alpha.2 起首页无 cookie 一律 401，
# 递裸地址等于送人去看一行英文报错。换到 cookie（30 天）之后干净地址才好使。
url() {
  ip="$(vm_ip)"
  lan="$(ready_url_lan)"
  loop="$(ready_url_loopback)"
  if [ "$BIND" != all ]; then
    printf '  只绑了 loopback：仅本机可用  %s\n' "${loop:-http://127.0.0.1:$PORT（日志里还没有就绪行）}"
    printf '  要让鸿蒙宿主的浏览器能开，用 KINGCODE_BIND=all 重启\n'
    return
  fi
  if [ -n "$lan" ]; then
    printf '  在**鸿蒙宿主侧的浏览器 / 鸿蒙壳**里打开（首次必须用这条带 token 的）：\n    %s\n' "$lan"
  else
    printf '  在**鸿蒙宿主侧的浏览器**里打开：  http://%s:%s\n' "${ip:-<虚拟机IP>}" "$PORT"
    printf '    ！日志里还没有就绪行，拿不到 token——这条裸地址会是 401。先 status 看引擎起没起\n'
  fi
  printf '  虚拟机内部自测：                  %s\n' "${loop:-http://127.0.0.1:$PORT}"
  printf '  换到 cookie 之后（30 天内）用干净地址即可：http://%s:%s\n' "${ip:-<虚拟机IP>}" "$PORT"
  printf '  注意：融合开发引擎的虚拟机 IP 每次开机可能变，别把它存成书签——用本命令重新问。\n'
  printf '  服务每次重启换一枚新 token，但**已发的 cookie 仍然有效**（签名密钥落盘在\n'
  printf '    $DSH_HOME/.credentials.yaml）——所以重启后通常不用重新贴地址。\n'
  # url 是用户拿地址的入口——IP 漂移了还把新地址递出去而不说一声，等于送他去 403。
  if alive "$ENG_PID" "$ENG_SIG"; then
    trusted="$(trusted_lan_ip)"
    if [ -n "$trusted" ] && live="$(vm_ip_live)" && [ "$live" != "$trusted" ]; then
      drift_warn "$trusted" "$live"
    fi
  fi
}

# ── prune ──────────────────────────────────────────────────────────────────
# $DSH_HOME/sessions 没有任何东西会自动清（上游无 TTL，虚拟机里也没有
# systemd-tmpfiles 兜底），而虚拟机磁盘只有几 GB——单个会话的 jsonl.zstd 实测
# 常见几百 KB、重的超过 2 MB，攒一年就是问题。结构固定两级：
# <sessions>/<项目路径编码>/<会话目录>/session.jsonl.zstd…，删除单位是会话目录。
# 判老不能只看目录 mtime（往 jsonl 追加只动文件 mtime 不动目录），所以判据是
# 「目录自身与其中所有文件都超过 N 天没动」。
prune() {
  days="${KINGCODE_PRUNE_DAYS:-30}"
  case "$days" in ''|*[!0-9]*) die "KINGCODE_PRUNE_DAYS 得是正整数，现在是「${KINGCODE_PRUNE_DAYS:-}」" ;; esac
  [ "$days" -ge 1 ] || die 'KINGCODE_PRUNE_DAYS 至少是 1——0 天等于把正在用的会话也划进来'

  yes=0
  for arg in "$@"; do
    case "$arg" in
      --yes) yes=1 ;;
      *) die "prune 不认识的参数：$arg（只支持 --yes）" ;;
    esac
  done

  sess="$DSH_HOME/sessions"
  [ -d "$sess" ] || { info "没有会话目录（$sess），无可清"; return 0; }

  # 服务在跑就拒绝：会话 jsonl 只允许一个活写者，跑着删等于在写者脚下抽文件。
  # 孤儿引擎（看门狗被 SIGKILL 后重父到 PID 1 的那种）也算在跑，所以两个 pid 都查。
  if alive "$SUP_PID" "$SUP_SIG" || alive "$ENG_PID" "$ENG_SIG"; then
    die '服务在跑，拒绝清理——先 stop 再 prune（会话文件只允许一个活写者）'
  fi

  victims=()
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    # find 输出为空 = 目录自己和里面的所有东西都不比 N 天新 → 可删。
    if [ -z "$(find "$d" -mtime -"$days" -print -quit 2>/dev/null)" ]; then
      victims+=("$d")
    fi
  done < <(find "$sess" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)

  # 顺手把系统 tmp 里的溢写孤儿量出来（只报数，不动手）：Web 形态的 spill-local
  # 没配 root，溢写落在 $TMPDIR/dsh-spill-*（每次进程启动 mkdtemp 一个，进程死后
  # 没人收）。不删是因为同机可能还有**别的** dsh 产品在跑，它的 spill 目录长得
  # 一模一样，删了会弄断人家活会话的溢写回读。
  tmproot="${TMPDIR:-/tmp}"
  spill_n="$(find "$tmproot" -mindepth 1 -maxdepth 1 -type d -name 'dsh-spill-*' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${spill_n:-0}" -gt 0 ]; then
    spill_sz="$(find "$tmproot" -mindepth 1 -maxdepth 1 -type d -name 'dsh-spill-*' -print0 2>/dev/null | xargs -0 du -shc 2>/dev/null | tail -1 | awk '{print $1}')"
    info "提示：$tmproot 下有 $spill_n 个 dsh-spill-* 溢写目录（合计 ${spill_sz:-?}）。本命令不动它们——确认同机没有别的 dsh 产品在跑时，可以手动清"
  fi

  if [ "${#victims[@]}" -eq 0 ]; then
    info "超过 $days 天没动的会话：0 个，无可清（$sess 现在共 $(du -sh "$sess" 2>/dev/null | awk '{print $1}')）"
    return 0
  fi

  info "以下 ${#victims[@]} 个会话目录超过 $days 天没动过："
  du -sh "${victims[@]}" 2>/dev/null | sed 's/^/    /'
  total="$(du -shc "${victims[@]}" 2>/dev/null | tail -1 | awk '{print $1}')"
  info "合计 ${total:-?}"

  if [ "$yes" -ne 1 ]; then
    info '这是干跑，什么都没删。确认清单无误后：kingcode-web.sh prune --yes'
    return 0
  fi

  for d in "${victims[@]}"; do
    rm -rf "$d"
  done
  # 项目层目录空了就顺手收掉；还有会话的 rmdir 会失败，静默即可。
  find "$sess" -mindepth 1 -maxdepth 1 -type d -exec rmdir {} \; 2>/dev/null
  info "已删除 ${#victims[@]} 个会话目录，释放 ${total:-?}"
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -n 50 -f "$LOG" ;;
  url)     url ;;
  prune)   shift; prune "$@" ;;
  __supervise) supervise ;;
  *) printf '用法: %s {start|stop|restart|status|logs|url|prune [--yes]}\n' "${0##*/}"; exit 2 ;;
esac
