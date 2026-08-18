/**
 * KingCode Web UI 品牌层 —— 节点（host）半侧。
 *
 * 两个官方开放缝，都不碰上游前端 dist：
 * - webServer.tapIndex(transform)：每次 index 响应都过一遍，改 <title>。
 *   浏览器侧 DocumentTitle 以首次挂载时的 document.title 为后缀基底，所以
 *   会话标题会自动变成「会话名 — KingCode」。
 * - webServer.register({kind:'exact', ...})：命名路由先于 frontend-static
 *   的 fallback 匹配，用来接管 /favicon.svg 与 /manifest.webmanifest。
 *
 * 配色与 client.js 的 P 常量块保持一致（这里只用得到三个色）。
 */

const INK = '#262B24'      // 墨绿黑，图标底
const PAPER = '#F1EFE7'    // 纸底，K 的主笔画
const ACCENT2 = '#B97B45'  // 深赭渐变亮端，K 的下撇

const BRAND_NAME = 'KingCode'

/** 32×32 品牌标：墨绿黑圆角底 + 纸色 K，下撇取深赭。 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="${INK}"/>
  <rect x="9" y="8" width="3.4" height="16" rx="1.5" fill="${PAPER}"/>
  <path d="M13.2 16 L21.6 8.4" stroke="${PAPER}" stroke-width="3.4" stroke-linecap="round" fill="none"/>
  <path d="M13.2 16 L21.6 23.6" stroke="${ACCENT2}" stroke-width="3.4" stroke-linecap="round" fill="none"/>
</svg>
`

const MANIFEST = JSON.stringify({
  id: '/',
  name: BRAND_NAME,
  short_name: BRAND_NAME,
  start_url: '/',
  scope: '/',
  display: 'fullscreen',
  icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}, null, 2)

export const name = 'kingcode-web-brand'
export const inject = ['webServer']

/**
 * 装上品牌层：改标题、接管图标与 PWA 清单。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.tapIndex(
    html => html.replace(/<title>[^<]*<\/title>/, `<title>${BRAND_NAME}</title>`),
  ))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/favicon.svg',
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(FAVICON_SVG)
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler: (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(MANIFEST)
    },
  }))
}
