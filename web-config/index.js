/**
 * 凭证桥 —— 让跨机客户端能填 API key，且只能填。
 *
 * 为什么需要它：上游把 credentials.* / settings.* / llm.discoverModels 钉死在 loopback
 * （dsh-client-connection 的 PRIVILEGED_METHODS），而 KingCode 的鸿蒙形态天然是跨机的
 * ——引擎在融合开发引擎的虚拟机里，客户端在鸿蒙宿主上。真机实测（172.16.105.2:3081）：
 * credentials.describe / credentials.set / settings.describe / llm.discoverModels 全部
 * forbidden，同一台机器换成 127.0.0.1 就正常。于是「填 key」在鸿蒙上无路可走。
 *
 * **只补这一件事**。别的都不补，因为实测证明它们跨机本来就能用：
 * - 列模型：llm.models 上游故意不在禁列里（注释原文：a LAN client's model picker
 *   legitimately needs it），跨机 ok:true。
 * - 改默认模型：session.selectModel 也不在禁列，而服务端处理它时顺手调了
 *   agentDefaultModel.saveSelection()。真机验过：跨机换一次模型，settings.yaml 就从
 *   「不存在」变出 agent-default-model 段。所以模型配置 UI 用上游的就行。
 *
 * ── 为什么是 connection.rpc 而不是 webServer.register ──────────────────────
 * webServer.register 注册的路由**完全没有信任栅栏**——实测 `curl /favicon.svg
 * -H 'Host: evil.example.com'` 返回 200（favicon 正是品牌层用它注册的）。拿它承载
 * 写凭证的接口，等于对 DNS rebinding 敞开：用户浏览器打开任意恶意页面，那个页面就能
 * 把 key 写进虚拟机。
 * connection.rpc.handle(channel, handler, { authority: 'trusted-host' }) 则会把上游
 * 那道 isTrustedApiRequest 原样套上（Host 必须是 loopback 或 trustedHosts 之一、
 * Origin 必须同源、显式 cross-site 拒绝），并白送 POST-only、content-type 必须是
 * application/json（跨源 JSON 属非简单请求，必触发预检，而上游从不回 CORS 头，
 * 预检必失败——这是 CSRF 的主防线）。
 * 通道名只能是单段：CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/，且 '/api' 被保留。
 *
 * ── 这条缝开得有多窄 ──────────────────────────────────────────────────────
 * ① **只写不读**：get 只回 { configured, writable }，永远不回 key 的值。
 *    这不是我们发明的，credentials.describe 本身就是这个契约。
 * ② **白名单**：只认 ALLOWED_REFS 里的名字。上游 credentials.set() 不校验 ref 形状，
 *    而下次启动解析文档时会校验——写进一个非 POSIX 标识符就会让 credentials 插件
 *    加载失败、整个引擎起不来。白名单同时挡住了「任意命名的密钥写入口」。
 * ③ **与其余 API 同等暴露**，不额外放大：用的是同一份 trustedHosts。
 * ④ **opt-in**：这一行不在 profile/cordis.patch.yml 里，要靠
 *    deploy/harmonyos-pc/credential-bridge.patch.yml 显式挂（同 bind-all 的路数）。
 *
 * 风险判断的落点：这套部署里，任何过得了 Host 栅栏的原生调用者早就能用非特权的
 * session.create + session.prompt 驱动 bash 工具、直接读走 .credentials.yaml
 * （KingCode 的工具面就是干这个的）。配置面钉死 loopback 挡的是**浏览器侧的侦察**，
 * 不是这个。所以在这套部署里加一条只写不读的窄接口，不构成实质性的新敞口；
 * 真正的敞口是绑 0.0.0.0 这个形态本身——换到不可信网络就该用 KINGCODE_BIND=loopback
 * 加 SSH 端口转发，而不是给这条缝加锁。
 *
 * 浏览器半侧在同一个包的 client.js 里（设置页的「KingCode」分区）。两半必须同包：
 * client-modules 按配置树条目的包名去 serve bundle，挂成包名才保证「有分区就有通道」。
 *
 * Loader 插件必须具名导出（default export 会静默丢 inject）。
 */

/** 通道名。单段、不能是 /api。 */
export const CHANNEL = '/kingcode-credentials'

/**
 * 允许写的凭证名。加新的之前先想清楚：这是个**写入口**，
 * 而 dsh 的凭证库是所有 provider 共用的。
 */
export const ALLOWED_REFS = Object.freeze(['DEEPSEEK_API_KEY'])

/** 上游 credentialRef 的形状（dsh-credentials 的 REF_PATTERN）。双保险，别去掉。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 判断一个 ref 能不能写。
 * @param ref - 凭证引用名。
 * @returns 不能写时返回拒绝理由，能写时返回 undefined。
 */
export function refRejection(ref) {
  if (typeof ref !== 'string' || ref.length === 0) return 'ref 必须是非空字符串'
  if (!REF_PATTERN.test(ref)) return `ref ${JSON.stringify(ref)} 不是合法的 POSIX 标识符——写进去会让下次启动时凭证库解析失败、引擎起不来`
  if (!ALLOWED_REFS.includes(ref)) return `ref ${JSON.stringify(ref)} 不在白名单里（允许：${ALLOWED_REFS.join(', ')}）`
  return undefined
}

/**
 * 上游的 rpc 结果信封。传输层（dsh-client-connection 的 fullResponse）把 handler
 * 的返回值**原样**塞进 result，而客户端拿 serverResponseSchema 解析——result 必须是
 * { ok: true, value } 或 { ok: false, error }，回裸对象客户端直接解析失败。
 * 抛异常更糟：传输层只回 500 + 纯文本 `handler failure: ...`，拒绝理由根本到不了 UI，
 * 用户只会看到「写了没反应」。所以业务错误一律走 ok:false。
 * @param value - 成功时的载荷。
 * @returns 成功信封。
 */
const ok = (value) => ({ ok: true, value })

/**
 * 业务错误信封。code 只能从上游那个判别联合（rpcErrorSchema）里挑，而里面**没有**
 * 通用的 internal——bad-request 是唯一能承载任意 message 的分支，所以校验失败与
 * 意外失败都落在它上面，靠 message 区分。details.issues 是该分支的必填字段。
 * @param message - 给用户看的原因。
 * @returns 失败信封。
 */
const bad = (message) => ({ ok: false, error: { code: 'bad-request', message, details: { issues: [] } } })

/**
 * 把文本里出现的密钥换掉。
 *
 * 为什么需要：底层 credentials.set 失败时，抛出的 Error.message 很可能把入参回显出来
 * （不少库都这么干）。那条 message 会同时进引擎日志和错误信封——一次磁盘写失败就能
 * 把 key 明文写进 run/web.log。这里不赌上游的错误措辞。
 * @param text - 待清洗文本。
 * @param secret - 本次调用经手的密钥值；没有则原样返回。
 * @returns 清洗后的文本。
 */
const redact = (text, secret) =>
  typeof secret === 'string' && secret.length > 0 ? text.split(secret).join('«已隐去»') : text

/**
 * 造出通道的 handler。抽成纯函数是为了能无头测试——真的挂上去要起整棵树。
 * @param credentials - dsh 的 credentials 服务（需 describe / set / unset）。
 * @param log - 审计输出（默认 console.log；引擎 stdout 直接落 run/web.log，已有轮转）。
 * @returns rpc handler：(endpoint, payload) => 上游信封。
 */
export function createHandler(credentials, log = (...a) => { console.log(...a) }) {
  return async (endpoint, payload) => {
    // 在 try 外面声明：catch 里要靠它给意外错误脱敏。
    let secret
    try {
      if (endpoint === 'get') {
        // 只回存在性与可写性，永远不回值。writable=false 意味着被启动环境的同名
        // 环境变量遮蔽了——UI 要据此把输入框置灰并解释原因，否则用户会觉得「写了没反应」。
        // describe 收**单个 ref**、回单个 CredentialInfo（上游签名
        // `describe(ref: CredentialRef): Promise<CredentialInfo>`）。传数组进去不会报错，
        // 回来的东西也没有 [ref] 这层，于是 configured 永远读成 false——一个不会抛、
        // 只会一直说「未配置」的静默错误。所以按 ref 逐个问。
        const refs = {}
        for (const ref of ALLOWED_REFS) {
          const info = await credentials.describe(ref)
          refs[ref] = {
            configured: info?.configured === true,
            // writable=false 只有一个成因：启动环境里有同名环境变量。上游让它
            // **可见地只读**而不是静默遮蔽写入——set 在这种时候会直接 reject。
            writable: info?.writable !== false,
            ...(info?.source === undefined ? {} : { source: info.source }),
          }
        }
        return ok({ refs, allowed: [...ALLOWED_REFS] })
      }

      if (endpoint === 'set') {
        const ref = payload?.ref
        const rejection = refRejection(ref)
        if (rejection !== undefined) return bad(rejection)
        const value = payload?.value
        if (typeof value !== 'string' || value.length === 0) return bad('value 必须是非空字符串')
        secret = value
        await credentials.set(ref, value)
        log(`kingcode-credentials: set ${ref}（${value.length} 字符，值不记录）`)
        return ok({ ref })
      }

      if (endpoint === 'unset') {
        const ref = payload?.ref
        const rejection = refRejection(ref)
        if (rejection !== undefined) return bad(rejection)
        await credentials.unset(ref)
        log(`kingcode-credentials: unset ${ref}`)
        return ok({ ref })
      }

      // 通道内部必须自己报错：frontend-static 占着 fallback 座位，
      // 打错的路径在外面看是 200 的 SPA 首页，指望不上。
      return bad(`未知 endpoint ${JSON.stringify(endpoint)}（有 get / set / unset）`)
    } catch (error) {
      // 意外失败（写不进盘之类）也变成信封，UI 才说得出话。堆栈留在引擎日志里，
      // 信封只带一行 message；两边都先过 redact。
      log(redact(`kingcode-credentials: ${endpoint} 失败：${error?.stack ?? String(error)}`, secret))
      return bad(redact(`${endpoint} 失败：${error?.message ?? String(error)}`, secret))
    }
  }
}

export const name = 'kingcode-credential-bridge'
export const inject = ['connection', 'credentials']

/**
 * 把通道挂上。
 * @param ctx - 宿主插件上下文（需 connection 与 credentials 服务）。
 */
export function apply(ctx) {
  const handler = createHandler(ctx.credentials)
  ctx.effect(() => ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'trusted-host' }))
  console.log(`kingcode-credentials: 通道 ${CHANNEL} 已挂（trusted-host；可写 ${ALLOWED_REFS.join(', ')}）`)
}
