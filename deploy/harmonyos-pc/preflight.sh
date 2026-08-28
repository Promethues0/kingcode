#!/bin/bash
# KingCode 鸿蒙 PC 部署 —— 只读探针。
#
# 它把这台机器上决定部署方案的事实采集齐，打印成一段可以整段回贴的报告。
# 先跑它，再跑 install.sh。
#
# 「只读」的准确含义（不夸大）：**不装任何软件、不改任何配置文件**。
# 但它确实会碰两样东西：① 非 root 的 dnf 查询会刷新/下载 dnf 的元数据缓存；
# ② 在 /mnt/linux_share 里建一个探针文件再立刻删掉（这是判断可写性的唯一办法）。
#
# 为什么需要这一步：融合开发引擎的默认 CPU/内存/磁盘规格、宿主能不能访问虚拟机端口、
# openEuler 的具体小版本，华为官方一个字都没写，全网也查不到实测——只能在机器上量。
#
# 跑法：bash preflight.sh            （在虚拟机的 Linux 终端里）
#      bash preflight.sh > pf.txt   （存成文件再回贴）
# shellcheck disable=SC2016
# 全文关掉 SC2016（本指令必须排在第一条命令之前才生效）：ask() 的第二个参数是**延迟求值**的表达式（在 ask 里 eval），
# 单引号是刻意的——写成双引号会在定义处就展开，探测的就不是运行时的实况了。
# 这些表达式全部是本文件里的字面量，不含任何外部输入。
set -uo pipefail   # 故意不设 -e：探针的职责是把每一项都问一遍，不是遇到第一个缺失就退

# 先留一份用户原本的 locale，再把解析用的输出钉成 C：procps-ng 在中文环境下把
# `Mem:` 译成「内存：」，df/ip/dnf 同理——照着英文字段写的 awk 会静默匹配不到，
# 打印出一片空白，而空白看起来像「这项没事」。
LANG_ORIG="${LANG:-未设}"
export LC_ALL=C
export LANG=C

KINGCODE_PORT="${KINGCODE_PORT:-3081}"
KC_HOME="${DSH_HOME:-$HOME/.kingcode}"
# 一整套装完实测约 1.0GB（开发机 darwin-arm64 对应物、全新 npm 缓存下量的，linux-arm64
# 同量级）：仓库 node_modules 266MB + 全局 dsh+pnpm 301MB + Node 解压后 187MB +
# npm 缓存 214MB（npm ci 与 npm i -g 两步合计）+ 头文件与编译临时件。2048 是含工作
# 余量的下限——会话 jsonl 与 spill 没有任何东西会自动清（见 README 已知限制）。
NEED_DISK_MB=2048

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
item() { printf '  %-26s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
# 命令成功但输出为空时也要给出兜底——`cmd || echo '兜底'` 是死代码：
# 退出 0 而输出为空的情况下兜底永远不触发，报告上打印成空白，
# 读者会把「最该报警的一项」当成「没问题」。
ask()  { out="$( { eval "$2"; } 2>/dev/null )"; item "$1" "${out:-${3:-取不到}}"; }
ver()  { if have "$1"; then item "$1" "$("$@" 2>&1 | head -1)"; else item "$1" '缺失'; fi; }

printf '========== KingCode 鸿蒙 PC preflight ==========\n'
item '采集时间' "$(date '+%Y-%m-%d %H:%M:%S %z' 2>/dev/null || echo '?')"
item '本脚本' "只读：不装软件、不改配置；会刷新 dnf 元数据缓存、在共享目录建删一个探针文件"

say '一、系统与体质'
ask 'uname'      'uname -srm'
ask 'arch'       'uname -m'   '取不到'
item ' '         '# 期望 aarch64；不是的话整份方案要重来'
ask 'os-release' '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"' '读不到 /etc/os-release'
ask 'glibc'      'getconf GNU_LIBC_VERSION || { have ldd && ldd --version | head -1; }'
ask 'CPU 核'     'nproc'
ask '内存'       'free -h | awk "/^Mem:/{print \$2\" 总 / \"\$7\" 可用\"}"'
ask '根盘'       'df -Ph / | awk "NR==2{print \$2\" 总 / \"\$4\" 可用\"}"'
ask 'HOME 盘'    'df -Ph "$HOME" | awk "NR==2{print \$2\" 总 / \"\$4\" 可用 (\"\$6\")\"}"'
avail_mb="$(df -Pm "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "${avail_mb:-}" ]; then
  item 'HOME 盘够不够' "$( [ "$avail_mb" -ge "$NEED_DISK_MB" ] && echo "够（${avail_mb}MB ≥ ${NEED_DISK_MB}MB）" || echo "不够（${avail_mb}MB < ${NEED_DISK_MB}MB，node_modules 就要 265MB）" )"
else
  item 'HOME 盘够不够' '量不到'
fi
ask '/tmp 可写'  'tmpf=$(mktemp 2>/dev/null) && rm -f "$tmpf" && echo "可写（node-gyp 与 spill 都要用）"' '不可写——node-gyp 编译会失败'
ask 'PID 1'      'ps -p 1 -o comm='
item ' '         '# 没有 systemd 时自启方案要看它'
ask '当前用户'   'echo "$(id -un) (uid=$(id -u))"'
# 二进制在不在 ≠ 当前用户能不能用。install.sh 第 1 步就是 sudo dnf，
# 不在 sudoers 里的话那一步必然失败，值得提前知道。
# `sudo -n -v` 不会弹密码提示：能过=免密可用；不过则分不清「要密码」还是「没权限」，
# 如实说成两种可能，不替用户下结论。
ask 'sudo'       'have sudo && { sudo -n -v 2>/dev/null && echo "可用（免密）" || echo "有 sudo，但免密校验没过——可能要输密码，也可能当前用户不在 sudoers 里"; }' '缺失——dnf 装包会做不了'
ask 'SELinux'    'getenforce' '无 getenforce（多半没启用）'
item 'locale（原始）' "$LANG_ORIG"
ask '时钟'       'date -u "+%F %T UTC"'
item ' '         '# 与真实 UTC 差几分钟以上会让 TLS 握手失败，装不上任何东西'
ask 'crond'      'have crontab && echo "crontab 在（@reboot 自启也许可行，需实测）"' '没有 crontab——@reboot 自启这条路走不通'

say '二、已有的工具链'
ver node --version
ver npm --version
ver pnpm --version
ver git --version
ver curl --version
ver python3 --version
ver make --version
ver gcc --version
ver 'g++' --version
ver tar --version
ver xz --version
ver dnf --version
ver ss --version
ver setsid --version
item 'node 够不够' "$(if have node; then node -e 'const [a,b]=process.versions.node.split(".").map(Number); console.log((a>22||(a===22&&b>=19))?"够（≥22.19）":"不够，必须换：需要 ≥22.19.0")' 2>&1; else echo '没装——install.sh 会装官方 linux-arm64 tarball'; fi)"

say '三、网络（决定 npm 与模型调用能不能通）'
ask 'IPv4 地址' 'ip -4 -o addr show scope global | awk "{print \$2\":\"\$4}" | paste -sd" " -' '没有全局 IPv4——多半是 host-only 模式或网卡没起'
ask '默认路由'  'ip route show default | head -1' '无默认路由——没有外网，install.sh 装不了任何东西'
ask 'DNS'       'awk "/^nameserver/{print \$2}" /etc/resolv.conf | paste -sd" " -' '/etc/resolv.conf 里没有 nameserver——域名一个都解析不了'
ask '代理变量'  'env | grep -iE "^(http|https|all|no)_proxy=" | paste -sd" " -' '无'
for host in api.deepseek.com registry.npmmirror.com registry.npmjs.org nodejs.org github.com; do
  ask "解析 $host" "getent ahostsv4 $host | awk 'NR==1{print \$1}'" '解析失败'
done
if have curl; then
  # 连通性要一个个真打——只做 DNS 解析证明不了任何事，而 install.sh 第 2/5/6/7 步
  # 分别要打 nodejs.org、github.com、npm registry。
  for url in https://api.deepseek.com/chat/completions https://registry.npmmirror.com/ https://registry.npmjs.org/ https://nodejs.org/dist/index.json https://github.com/; do
    ask "连通 ${url#https://}" "curl -sS -o /dev/null --connect-timeout 8 -m 15 -w 'http=%{http_code} 用时%{time_total}s' '$url' 2>&1 | head -1" '连不上'
  done
  item ' ' '# api.deepseek.com 返回 401 就是通的——没带 key 而已'
fi

say '四、dnf 里有什么（只查询，会刷新元数据缓存；网不通时整节都会说“查不到”）'
if have dnf; then
  for p in gcc-c++ make python3 glibc-devel git curl tar xz ca-certificates; do
    ask "$p" "dnf -q list --available $p 2>/dev/null | awk 'NR==2{print \$2}' || dnf -q list --installed $p 2>/dev/null | awk 'NR==2{print \$2\" (已装)\"}'" '查不到（包不在源里，或网不通）'
  done
  ask 'nodejs（仅参考）' "dnf -q list --available nodejs 2>/dev/null | awk 'NR==2{print \$2}'" '查不到'
  item ' ' '# 20.x 的话不能用作运行时，仅记录'
else
  item 'dnf' '缺失——这不像融合开发引擎的 openEuler，请确认环境'
fi

say '五、共享目录与端口'
if [ -d /mnt/linux_share ]; then
  ask '/mnt/linux_share' 'stat -c "存在  属主=%U:%G 权限%a" /mnt/linux_share'
  if touch /mnt/linux_share/.kingcode-write-probe 2>/dev/null; then
    item '  可写性' '普通用户可写'; rm -f /mnt/linux_share/.kingcode-write-probe
  else
    item '  可写性' '普通用户不可写（官方 FAQ 说过属主是 root）——仓库与 harness home 都别放这儿'
  fi
else
  item '/mnt/linux_share' '不存在（没开共享目录，或不是融合开发引擎）'
fi
if have ss; then
  ask "端口 $KINGCODE_PORT" "ss -ltnH 'sport = :$KINGCODE_PORT' | awk '{print \$4\" 已被占用\"}'" '空闲'
else
  item "端口 $KINGCODE_PORT" '无 ss，没法查'
fi

say '六、宿主能不能访问虚拟机端口（这条必须你亲手验）'
VMIP="$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); print a[1]}')"
cat <<TIP
  官方从未正面说明宿主机能否访问虚拟机监听的端口，也没有端口转发功能，
  而且**虚拟机 IP 每次开机可能变**。请在这台机器上跑（用真正要用的端口 $KINGCODE_PORT，
  并且**在一个空目录里**起——直接在 \$HOME 里起会把你的文件连同 .credentials.yaml
  一起无认证地列给整个网段）：

      mkdir -p /tmp/kc-probe && cd /tmp/kc-probe && echo ok > index.html
      python3 -m http.server $KINGCODE_PORT --bind 0.0.0.0

  然后在**鸿蒙宿主侧的浏览器**里打开：

      http://${VMIP:-<上面第三节的 IPv4 地址>}:$KINGCODE_PORT

  看到 ok = 通，KingCode 的 Web 形态就能用；连不上 = 只能用 CLI 形态。
  把结果一起告诉我。（Ctrl-C 结束那个 http.server。）
TIP

say '七、KingCode 现状'
item 'DSH_HOME 环境变量' "${DSH_HOME:-未设（KingCode 自己会兜底到 ~/.kingcode）}"
item 'harness home' "$KC_HOME  $([ -d "$KC_HOME" ] && echo '（已存在）' || echo '（还没有）')"
ask '凭证文件' "stat -c '存在 权限%a（组/其他位必须为 0）' '$KC_HOME/.credentials.yaml'" '还没有'
item 'KingCode 预设' "$([ -d "$KC_HOME/.agent-presets/kingcode" ] && echo '已装' || echo '未装（profile/setup.sh 会装）')"
item 'DEEPSEEK_API_KEY' "$([ -n "${DEEPSEEK_API_KEY:-}" ] && echo '已在环境里' || echo '不在环境里')"
item '仓库' "$([ -f "$HOME/kingcode/package.json" ] && echo "$HOME/kingcode 已存在" || echo '还没克隆')"

printf '\n========== 报告结束：把上面整段回贴 ==========\n'
