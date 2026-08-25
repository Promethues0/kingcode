/**
 * 不安全上下文垫片 —— 让「浏览器在另一台机器上」这件事真的能用。
 *
 * 场景：dsh web 跑在鸿蒙 PC 的融合开发引擎（openEuler 虚拟机）里，用户在**宿主侧
 * 浏览器**里开 `http://<虚拟机IP>:3081`。明文 HTTP + 非 loopback 主机 = 浏览器判定
 * 为 insecure context，`crypto.randomUUID` 在这种上下文里**不存在**（规范把它标了
 * [SecureContext]）。而 dsh-client-connection 每发一条 RPC 都要 `crypto.randomUUID()`
 * 铸一个 rpcId（另一处在 dsh-client-ui-conversation；全部 client bundle 里就这两个
 * 真调它——2026-08 实测的数字，别照抄"三个"那种说法），于是：
 *
 *   页面 200、静态资源 200、品牌是 KingCode、**没有任何报错横幅**，
 *   工作区永远停在「正在加载中」。
 *
 * 这是最坏的一种失败——看起来装好了。垫片把它变成「本来就该能用」。
 *
 * 为什么是垫片而不是别的：
 * - `crypto.getRandomValues` **没有**被 secure-context 门槛挡住，所以随机源本身是
 *   合格的，缺的只是那个便利函数。垫片按 RFC 4122 §4.4 摆好 version/variant 位，
 *   产出的 UUID 与原生实现同分布。
 * - 不改上游 dist：走 `webServer.tapIndex`（与 web-brand 同一条官方缝）。
 * - 安全上下文里它自己不装（`randomUUID` 已存在就整段跳过），所以 Mac/Win 客户端与
 *   本机 localhost 访问完全不受影响，多挂一行没有代价。
 *
 * 垫片治不了的，别指望它治：
 * ① 跨机访问时 `settings.*` / `credentials.*` / `agentPreset.read|copy|remove` /
 *   `llm.discoverModels` 这一整个配置面被上游钉死在 loopback，一律 403。API key 必须
 *   在虚拟机侧落盘（~/.kingcode/.credentials.yaml，0600），不能在跨机 Web UI 的
 *   Models 页里填。
 * ② `navigator.clipboard` 同样是 secure-context 门槛 API，dsh 的前端用它做复制按钮。
 *   垫片没治它（也不该治：往剪贴板写要用户手势与权限模型配合，硬垫会造出更难查的
 *   行为）。后果是复制按钮失效，不影响会话本身。全量扫过 dsh 送进浏览器的 73 个 JS，
 *   被 secure context 挡住的就这两样。
 *
 * Loader 插件必须具名导出（default export 会静默丢 inject）。
 */

/** 注入脚本的标记：既用于「已经注入过就别再注入」，也便于在浏览器里一眼认出。 */
export const MARKER = 'kingcode-insecure-context-shim'

/**
 * 注入的正文。**经典脚本**（不是 module）：经典内联脚本在解析到它的那一刻就执行，
 * 而上游 index.html 里的入口是 `<script type="module">`——module 脚本一律 defer 到
 * 文档解析完才跑。所以只要这段在 `<head>` 里，就一定排在所有应用代码之前。
 *
 * 自身不抛：垫片本身把页面搞崩，比缺 randomUUID 更糟。
 */
const SHIM_SOURCE = `(function () {
  try {
    var c = globalThis.crypto
    if (!c || typeof c.getRandomValues !== 'function') return
    if (typeof c.randomUUID === 'function') return
    var hex = []
    for (var i = 0; i < 256; i++) hex[i] = (i + 0x100).toString(16).slice(1)
    var uuid = function () {
      var b = new Uint8Array(16)
      c.getRandomValues(b)
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      return hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + '-' +
        hex[b[4]] + hex[b[5]] + '-' + hex[b[6]] + hex[b[7]] + '-' +
        hex[b[8]] + hex[b[9]] + '-' + hex[b[10]] + hex[b[11]] +
        hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
    }
    var landed = function () { return typeof c.randomUUID === 'function' }
    // 三级降落，每一级都**验过再走下一级**：内联的经典脚本是宽松模式，给冻结对象
    // 赋值不抛异常、只是静默失败，所以 try/catch 拦不住它——必须回读。
    try { c.randomUUID = uuid } catch (e) {}
    if (landed()) return
    try { Object.defineProperty(c, 'randomUUID', { value: uuid, writable: true, configurable: true }) } catch (e) {}
    if (landed()) return
    try {
      var proto = Object.getPrototypeOf(c)
      if (proto) Object.defineProperty(proto, 'randomUUID', { value: uuid, writable: true, configurable: true })
    } catch (e) {}
  } catch (e) {
    /* 垫片自己出事就当没来过：缺 randomUUID 只是工作区转圈，页面崩了才是全灭 */
  }
})()`

/** 完整的注入片段（含标记注释，供 transform 自查与浏览器里肉眼确认）。 */
export const SHIM_TAG = `<script data-${MARKER}>${SHIM_SOURCE}</script>`

/**
 * 把垫片插进 `<head>` 之后。
 *
 * 插在最早的位置而不是 `</head>` 之前：虽然按 module 的 defer 语义两处都够早，
 * 但「最早」不需要读者去推导 defer 规则才能确信。
 *
 * 幂等：已经带标记的 html 原样返回（tapIndex 的 transform 会被每个 index 响应各跑
 * 一次，重复注入虽无害，但会掩盖「挂了两遍」这种配置错误）。
 *
 * @param html - 上游的 index.html 正文。
 * @returns 注入后的正文。
 * @throws 找不到 `<head>` 时——上游 index.html 换了形状，静默不注入等于把
 *   「工作区永远转圈」这个症状原封不动地还回去，那正是本插件要消灭的东西。
 */
export function injectShim(html) {
  if (html.includes(MARKER)) return html
  const head = html.indexOf('<head>')
  if (head === -1) {
    throw new Error(`${MARKER}: index.html 里找不到 <head>，无法注入垫片——上游前端换形状了，检查 dsh 版本`)
  }
  const at = head + '<head>'.length
  return html.slice(0, at) + SHIM_TAG + html.slice(at)
}

export const name = MARKER
export const inject = ['webServer']

/**
 * 挂上 index 变换。
 * @param ctx - 宿主插件上下文（需 webServer 服务）。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.tapIndex(injectShim))
}
