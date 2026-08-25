#!/bin/bash
# KingCode Web 服务的起停 —— 给没有 systemd 的融合开发引擎用。
#
# 用法：
#   ./kingcode-web.sh start     启动（后台常驻，带看门狗）
#   ./kingcode-web.sh stop      停止（优雅，等它把会话 flush 完）
#   ./kingcode-web.sh restart
#   ./kingcode-web.sh status    进程 / 端口 / 就绪 / 跨机可达性 四项体检
#   ./kingcode-web.sh logs      跟踪日志
#   ./kingcode-web.sh url       打印宿主浏览器该开的地址（IP 每次开机会变）
#
# 旋钮（环境变量）：
#   KINGCODE_PORT   监听端口，默认 3081
#   KINGCODE_BIND   all（默认，绑 0.0.0.0，宿主能访问）| loopback（只给本机）
#   DSH_HOME        harness home，默认 $HOME/.kingcode
#   KINGCODE_STATE  pid / 日志目录，默认 $DSH_HOME/run
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

# 虚拟机自己的 IP。三级降级：iproute2 → hostname -I → dsh 自己在就绪行里算好的
# LAN 地址。不能只靠第一条——这个函数撑着 url 与 status 的「跨机可达吗」，
# 而那正是整套部署里最需要答案的一问，缺个 ip 命令就整行空白是最差的表现。
vm_ip() {
  ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); print a[1]; exit}' && return 0
  hostname -I 2>/dev/null | awk '{print $1; exit}' && return 0
  grep -o 'LAN: http://[0-9.]*' "$LOG" 2>/dev/null | tail -1 | sed 's|.*http://||'
}

# 用数组而不是字符串：路径里有空格时 $(...) 展开会散架，而 die 在子 shell 里
# 也杀不掉父进程（看门狗会带着半条命令继续跑）。
ENGINE=()
build_engine_argv() {
  if [ "$BIND" = all ]; then
    [ -f "$PATCH" ] || die "找不到绑定覆盖层 $PATCH（仓库不完整？）"
    ENGINE=(dsh --profile kingcode --patch "$PATCH" --port "$PORT")
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
  fails=0
  trap on_stop TERM INT
  while :; do
    started="$(date +%s)"
    printf '\n[%s] kingcode-web: 启动引擎 %s\n' "$(date '+%F %T')" "${ENGINE[*]}"
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
  if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; then
    die "端口 $PORT 已被别的进程占用——换 KINGCODE_PORT，或先停掉那个进程"
  fi

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
probe_api() {
  command -v curl >/dev/null 2>&1 || { echo '无 curl'; return; }
  # 不能写 `curl … || echo '连不上'`：curl 失败时 -w 已经把 000 吐出来了，
  # 再 echo 一句就拼成 `000连不上` 这种半截话。先收进变量再判。
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"probe","method":"agentPreset.list","payload":{}}' \
    "http://$1/api/agentPreset.list" 2>/dev/null)"
  case "$code" in
    ''|000) echo '连不上' ;;
    *)      echo "$code" ;;
  esac
}

status() {
  printf '  %-14s %s\n' '看门狗' "$(alive "$SUP_PID" "$SUP_SIG" && echo "在跑 (pid $(cat "$SUP_PID"))" || echo '没在跑')"
  printf '  %-14s %s\n' '引擎'   "$(alive "$ENG_PID" "$ENG_SIG" && echo "在跑 (pid $(cat "$ENG_PID"))" || echo '没在跑')"
  if command -v ss >/dev/null 2>&1; then
    # 不能写 `... || echo '没在听'`：没人监听时 ss 输出为空但退出 0，整条管道成功，
    # 那个兜底永远不触发，打印出来的是一个空字段——看着像"这项没查"，其实是"没在听"。
    listen="$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | paste -sd' ' -)"
    printf '  %-14s %s\n' "端口 $PORT" "${listen:-没在听}"
  fi
  printf '  %-14s %s\n' '就绪行' "$(grep "$READY_LINE" "$LOG" 2>/dev/null | tail -1 || echo '日志里还没有')"
  printf '  %-14s %s\n' '本机 /api' "$(probe_api "127.0.0.1:$PORT")  （200 才算真活着）"
  if [ "$BIND" = all ]; then
    ip="$(vm_ip)"
    if [ -n "$ip" ]; then
      code="$(probe_api "$ip:$PORT")"
      # 这一探针是在虚拟机内部打虚拟机自己的 IP：它证明的是「绑对了 + 信任栅栏放行
      # 这个 authority」，**不**证明宿主到虚拟机那条路通——那条只能在宿主的浏览器里试
      # （preflight.sh 第六节）。别把这行读成「宿主能访问了」。
      printf '  %-14s %s\n' '本机打 LAN 口' "$ip:$PORT → $code  （403=信任栅栏拦了；连不上=没绑对或防火墙。此项不证明宿主可达）"
    else
      printf '  %-14s %s\n' '跨机 /api' '量不到本机 IP（没有 ip / hostname，日志里也没有 LAN 行）——这项没查成'
    fi
  fi
}

# ── url ────────────────────────────────────────────────────────────────────
url() {
  ip="$(vm_ip)"
  if [ "$BIND" != all ]; then
    printf '  只绑了 loopback：仅本机可用  http://127.0.0.1:%s\n' "$PORT"
    printf '  要让鸿蒙宿主的浏览器能开，用 KINGCODE_BIND=all 重启\n'
    return
  fi
  printf '  在**鸿蒙宿主侧的浏览器**里打开：  http://%s:%s\n' "${ip:-<虚拟机IP>}" "$PORT"
  printf '  虚拟机内部自测：                  http://127.0.0.1:%s\n' "$PORT"
  printf '  注意：融合开发引擎的虚拟机 IP 每次开机可能变，别把它存成书签——用本命令重新问。\n'
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -n 50 -f "$LOG" ;;
  url)     url ;;
  __supervise) supervise ;;
  *) printf '用法: %s {start|stop|restart|status|logs|url}\n' "${0##*/}"; exit 2 ;;
esac
