/**
 * KingCode Web UI 品牌层 —— 浏览器半侧。
 *
 * 手写的 lazy-CJS 工厂包裹（与 tsdown clientBundle 预设产物同格式）：本插件
 * 不 require 任何模块表条目，所以无需构建工具链，改完即生效。
 *
 * 换肤走官方扩展点 ctx.theme.overrideTokens(source, tokens)——在激活主题上
 * 叠一层别名 token 覆盖，同 source 重调即整层替换，disposer 可撤。每个值必须
 * {light, dark} 成对（裸字符串会抛教学错误）。
 *
 * 配色：字节蓝（Arco Design 色阶——字节跳动开源设计系统）。
 * accent 用 Arco primary #165DFF 而非品牌色 #3370FF：后者白字对比度
 * 只有 4.28，不达 WCAG AA。语义三色按「对比度 × 红绿色弱可辨性」双约束
 * 选取（Arco 九种 red×green 组合里最差的一对色弱 ΔE 仅 2.1）。
 * **改配色只改下面 P 常量块，改完必跑 tools/check-contrast.js。**
 */
window.__ModuleLoader__.load({
	id: 'kingcode-web-brand',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ── 调色板（唯一事实源；favicon 的同名色在 index.js 顶部）────────────
		const P = {
			// 亮色：字节蓝（Arco Design 色阶，字节跳动开源设计系统）
			ink: '#1D2129',        // gray-9，主文字与主按钮
			ink2: '#272E3B',       // gray-8
			ink3: '#4E5969',       // gray-7，次级文字
			muted: '#666F7A',      // 三级文字（比 Arco gray-6 深一档：gray-6 在浅底只有 2.92，不达 4.5）
			faint: '#86909C',      // gray-6，说明文字（仅用于 ≥3 的场景）
			surface: '#FFFFFF',    // 最外层
			paper2: '#F7F8FA',     // gray-1，第二层
			paper: '#F2F3F5',      // gray-2，第三层／侧栏
			sink: '#E5E6EB',       // gray-3，浮层／标签底
			sink2: '#DCDEE2',      // 按下态
			line: '#E5E6EB',       // 分隔线
			accent: '#165DFF',     // Arco primary（blue-6）。**不用品牌色 #3370FF 做按钮底**：
			                       // 白字压在 #3370FF 上只有 4.28，不达 WCAG AA 的 4.5；
			                       // #165DFF 是 5.19，且它本就是字节自家设计系统的主色。
			accent2: '#4080FF',    // blue-5，渐变另一端
			// 语义三色是「对比度 × 色弱可辨性」双约束下选的，不是挑好看的：
			// Arco 九种 red×green 组合里，red-7×green-8 的色弱 ΔE 只有 2.1（最差），
			// red-8×green-7 是 23.6（最佳且两者都是官方色阶）。改前必跑
			// tools/check-contrast.js，别只看对比度。
			danger: '#A1151E',     // red-8，白底 7.95（错误文字要能读）
			good: '#009A29',       // green-7，白底 3.71（成功色用于图标/徽标，按 ≥3 要求）
			warn: '#D25F00',       // orange-7，白底 3.91
			// 暗色：Arco 深色模式色阶
			dBase: '#17171A',
			dL1: '#1D1D1F',
			dL2: '#232324',
			dL3: '#2A2A2B',
			dL4: '#313132',
			dL5: '#373739',
			dCode: '#141416',
			dText: '#F6F6F6',
			dText2: '#C9CDD4',     // gray-4
			dText3: '#929293',
			dAccent: '#4080FF',    // 暗底上用 blue-5，blue-6 在深色底对比不足
			dAccent2: '#6AA1FF',   // blue-4
			// danger/good 的暗色值同样不是亮色随手提亮：红绿在色弱模拟下会收敛。
			// 这组取值 good↔danger ΔE 36.6（protan/deutan 取小），远超 16 的红线。
			// 改这三个值前请重跑 tools/check-contrast.js。
			dDanger: '#FBACA3',    // red-4
			dGood: '#00B42A',      // green-6
			dWarn: '#FF9A2E',      // orange-5
		}

		/** rgba 辅助：亮色用深灰蓝透明度、暗色用近白透明度（沿用上游两模式惯例）。 */
		const inkA = a => `rgba(29, 33, 41, ${a})`
		const litA = a => `rgba(246, 246, 246, ${a})`

		/** 静态色阶同值双写（上游静态阶亮暗基本同值，这里保持该惯例）。 */
		const flat = v => ({ light: v, dark: v })

		const TOKENS = {
			// DeepSeek 蓝的整条静态阶 → Arco 蓝阶。别名层覆盖不到那些直接吃
			// --dsw-static-deepseek-* 的组件（如首页徽章底、输入框光晕），
			// 逐档对映后任何直接消费者都自动落进字节蓝里。
			'--dsw-static-deepseek-50': flat('#F2F7FF'),
			'--dsw-static-deepseek-100': flat('#E8F3FF'),
			'--dsw-static-deepseek-200': flat('#BEDAFF'),
			'--dsw-static-deepseek-300': flat('#94BFFF'),
			'--dsw-static-deepseek-400': flat('#6AA1FF'),
			'--dsw-static-deepseek-450': flat('#4080FF'),
			'--dsw-static-deepseek-500': flat('#165DFF'),
			'--dsw-static-deepseek-600': flat('#0E42D2'),
			'--dsw-static-deepseek-800': flat('#072CA6'),
			'--dsw-static-deepseek-900': flat('#031A79'),

			// 背景四层：亮色是纸底逐层加深，暗色逐层提亮
			'--dsw-alias-bg-base': { light: P.surface, dark: P.dBase },
			'--dsw-alias-bg-layer-1': { light: P.surface, dark: P.dL1 },
			'--dsw-alias-bg-layer-2': { light: P.paper2, dark: P.dL2 },
			'--dsw-alias-bg-layer-3': { light: P.paper, dark: P.dL3 },
			'--dsw-alias-bg-overlay': { light: P.sink, dark: P.dL4 },
			'--dsw-alias-bg-module-platform': { light: P.paper2, dark: P.dL2 },
			'--dsw-alias-bg-multi-select': { light: P.paper2, dark: P.dL3 },
			'--dsw-alias-bg-skeleton': { light: inkA(0.05), dark: litA(0.08) },
			'--dsw-alias-bg-mask-drop': { light: 'rgba(255, 255, 255, 0.7)', dark: 'rgba(23, 23, 26, 0.7)' },

			// 描边
			'--dsw-alias-border-l1': { light: inkA(0.05), dark: litA(0.06) },
			'--dsw-alias-border-l2': { light: inkA(0.1), dark: litA(0.12) },
			'--dsw-alias-border-l2-darkmode-thin': { light: inkA(0.1), dark: litA(0.06) },
			'--dsw-alias-border-l3': { light: inkA(0.14), dark: litA(0.16) },
			'--dsw-alias-border-l4': { light: inkA(0.2), dark: litA(0.2) },

			// 文字
			'--dsw-alias-label-primary': { light: P.ink, dark: P.dText },
			'--dsw-alias-label-primary-dimmed': { light: P.ink2, dark: '#E5E6EB' },
			'--dsw-alias-label-primary-foreground': { light: P.surface, dark: P.dBase },
			'--dsw-alias-label-primary-inverted': { light: P.surface, dark: P.dL2 },
			'--dsw-alias-label-primary-bluish': { light: P.ink, dark: P.dText },
			'--dsw-alias-label-secondary': { light: P.ink3, dark: P.dText2 },
			'--dsw-alias-label-tertiary': { light: P.muted, dark: P.dText3 },
			'--dsw-alias-label-caption': { light: P.faint, dark: P.muted },
			'--dsw-alias-label-dimmed': { light: P.line, dark: '#4E5969' },

			// 品牌主色：上游是纯黑/纯白，这里换成 Arco gray-9 / 近白
			'--dsw-alias-brand-primary': { light: P.ink, dark: P.dText },
			'--dsw-alias-brand-primary-invert': { light: P.ink, dark: P.dText },
			'--dsw-alias-brand-text': { light: P.ink, dark: P.dText },
			// accent 位：换成 Arco primary
			'--dsw-alias-brand-primary-new-colorprimary-new-color': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-state-business-primary': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-business-primary': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-business-tertiary': { light: '#E8F3FF', dark: '#072CA6' },

			// 按钮
			'--dsw-alias-button-primary-fill': { light: P.ink, dark: P.dText },
			'--dsw-alias-button-primary-hover': { light: '#272E3B', dark: '#E5E6EB' },
			'--dsw-alias-button-primary-dimmed': { light: P.sink2, dark: '#313132' },
			'--dsw-alias-button-contrast-fill': { light: P.ink3, dark: P.dText },
			'--dsw-alias-button-elevated-fill': { light: P.surface, dark: P.dL4 },
			'--dsw-alias-button-floating-fill': { light: P.surface, dark: P.dL2 },
			'--dsw-alias-button-floating-hover': { light: P.paper, dark: P.dL3 },
			'--dsw-alias-button-ghost-active-fill': { light: P.sink, dark: P.dL4 },
			'--dsw-alias-button-ghost-active-hover': { light: P.sink2, dark: P.dL5 },
			'--dsw-alias-button-ghost-active-border': { light: '#C9CDD4', dark: P.muted },
			// 主动作钮（发送等）：Arco primary
			'--dsw-alias-button-info-fill': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-button-info-hover': { light: '#0E42D2', dark: P.dAccent2 },

			// 交互态
			'--dsw-alias-interactive-bg-hover': { light: inkA(0.06), dark: litA(0.08) },
			'--dsw-alias-interactive-bg-hover-solid': { light: P.paper, dark: P.dL2 },
			'--dsw-alias-interactive-bg-hover-accent': { light: inkA(0.14), dark: litA(0.24) },
			'--dsw-alias-interactive-bg-active': { light: inkA(0.1), dark: litA(0.14) },
			'--dsw-alias-interactive-bg-hover-danger': { light: 'rgba(161, 21, 30, 0.06)', dark: 'rgba(251, 172, 163, 0.15)' },

			// 状态色
			'--dsw-alias-error-primary': { light: P.danger, dark: P.dDanger },
			'--dsw-alias-error-secondary': { light: '#CB272D', dark: '#F98981' },
			'--dsw-alias-success-primary': { light: P.good, dark: P.dGood },
			'--dsw-alias-success-secondary': { light: '#00B42A', dark: '#4CD263' },
			'--dsw-alias-success-tertiary': { light: '#E8FFEA', dark: '#00301C' },
			'--dsw-alias-warn-primary': { light: P.warn, dark: P.dWarn },
			'--dsw-alias-warn-secondary': { light: '#FF7D00', dark: '#FFB65D' },
			'--dsw-alias-warn-label': { light: '#A64500', dark: P.dWarn },
			'--dsw-alias-warn-tertiary': { light: '#FFF7E8', dark: '#3A2100' },

			// markdown / 代码
			'--dsw-alias-code-block': { light: P.paper, dark: P.dCode },
			'--dsw-alias-code-block-banner': { light: P.sink, dark: P.dL1 },
			'--dsw-alias-inline-code': { light: P.sink, dark: P.dL3 },
			'--dsw-alias-markdown-citation': { light: P.sink, dark: P.dL3 },
			'--dsw-alias-tag': { light: P.sink, dark: P.dL3 },
			'--dsw-alias-placeholder': { light: P.paper2, dark: P.dL2 },
			'--dsw-alias-code-segment-selected': { light: P.surface, dark: P.dL3 },
			'--dsw-alias-code-segment-unselected': { light: P.paper, dark: P.dBase },

			// 滚动条
			'--dsw-alias-scrollbar-bg-l1': { light: P.line, dark: P.dL5 },
			'--dsw-alias-scrollbar-bg-l2': { light: P.line, dark: P.ink3 },
			'--dsw-alias-scrollbar-hover-l1': { light: '#C9C6B6', dark: P.ink3 },
			'--dsw-alias-scrollbar-hover-l2': { light: '#C9C6B6', dark: '#55594F' },

			// 浮层
			'--dsw-alias-toast-bg': { light: P.ink2, dark: P.dL4 },
			'--dsw-alias-tooltip-bg': { light: P.ink, dark: P.dL4 },

			// 组件专用
			'--dsw-specific-sidebar-fill': { light: P.paper, dark: P.dCode },
			'--dsw-specific-sidebar-nav-item-active': { light: P.sink2, dark: P.dL3 },
			'--dsw-specific-sidebar-nav-item-active-accent': { light: '#EFE3D6', dark: P.dL3 },
			'--dsw-specific-sidebar-nav-item-hover': { light: P.sink, dark: P.dL2 },
			'--dsw-specific-bubble': { light: '#EFE9DC', dark: P.dL3 },
			'--dsw-specific-bubble-highlight': { light: '#E6DCC9', dark: P.dL4 },
			'--dsw-specific-input-major': { light: P.surface, dark: P.dL2 },
			'--dsw-specific-login-input': { light: P.paper2, dark: P.dBase },
			'--dsw-specific-menu': { light: P.surface, dark: P.dL3 },
			'--dsw-specific-selector': { light: P.paper2, dark: P.dL3 },
			'--dsw-specific-tip': { light: P.paper2, dark: P.dL3 },
		}

		// ── 品牌文案与标记（想改名/改标语只动这里）──────────────────────────
		const BRAND = {
			wordmark: 'KingCode',   // 侧栏左上角
			headline: 'KingCode',   // 首页大标题（原「探索未至之境」）
		}

		/**
		 * K 字标：把颜色直接烤进 SVG 背景图，亮暗各出一份。
		 *
		 * 早先用的是「渐变底 + CSS mask」，在 WebKit（原生客户端用的引擎）里
		 * 两次踩坑：简写丢 no-repeat 导致蒙版平铺成「|K|」；改长写后蒙版边缘
		 * 仍会在栅格化时抖出一圈噪点。背景图没有蒙版那套语义，画出来就是干净的。
		 * 代价是颜色不能再跟 CSS 变量走——所以这里显式生成两份，用
		 * body[data-ds-dark-theme] 切换（与上游主题开关同一判据）。
		 *
		 * @param from - 渐变起点色。
		 * @param to - 渐变终点色。
		 * @returns 可直接放进 url() 的 data URI。
		 */
		const kMark = (from, to) => 'data:image/svg+xml,' + encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
			// gradientUnits 必须是 userSpaceOnUse：默认的 objectBoundingBox 以每个
			// 形状自己的包围盒为参照，而竖笔是条垂直线、盒宽为零，按 SVG 规范渐变
			// 退化后该形状根本不绘制——K 会变成「<」。用户空间坐标还顺带让三笔
			// 共享同一条渐变，而不是各自来一条。
			+ '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"'
			+ ' x1="7" y1="5" x2="23" y2="27">'
			+ `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`
			+ '</linearGradient></defs>'
			+ '<g fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">'
			+ '<path d="M9 7 L9 25"/>'
			+ '<path d="M12 16 L21.5 6.2"/>'
			+ '<path d="M12 16 L21.5 25.8"/>'
			+ '</g></svg>',
		)

		const K_LIGHT = kMark(P.accent, P.accent2)
		const K_DARK = kMark(P.dAccent, P.dAccent2)

		/** 一处品牌标的完整样式（含暗色变体）。 */
		const markRule = (selector, size) => `
${selector} {
	content: "";
	width: ${size}px; height: ${size}px; flex: none;
	background-image: url("${K_LIGHT}");
	background-repeat: no-repeat;
	background-position: center;
	background-size: contain;
}
body[data-ds-dark-theme] ${selector} {
	background-image: url("${K_DARK}");
}`

		/**
		 * 覆盖上游硬编码的品牌图形（侧栏 wordmark、首页鲸鱼与标题）。
		 *
		 * 选择器只用「哈希前缀 + _语义名」里的稳定后缀（如 `_brand`、`_headline`），
		 * 不写死 CSS Modules 的完整哈希类名——上游重建会换前缀、不换后缀。
		 * 匹配不到时整段是无害的空规则，UI 退回上游原样，不会白屏。
		 */
		const BRAND_CSS = `
/* 侧栏 wordmark：藏掉 deepseek HARNESS 原标，换 K 字标 + 字样 */
button[class*="_brand"] > svg[viewBox="0 0 182 24"] { display: none !important; }
button[class*="_brand"] {
	display: inline-flex !important;
	align-items: center;
	gap: 7px;
}
${markRule('button[class*="_brand"]::before', 19)}
button[class*="_brand"]::after {
	content: "${BRAND.wordmark}";
	font-size: 15px;
	font-weight: 640;
	letter-spacing: 0.005em;
	color: var(--dsw-alias-label-primary);
	white-space: nowrap;
}

/* 收起态（rail）：上游此时不渲染 _brand 按钮，改在切换钮里放鲸鱼单标
   （静止显示鲸鱼、悬停换成展开图标）。这里换成 K 字标并保留那套互换逻辑。
   用 :has(_railFish) 当状态判据——该元素只在收起态存在，是最稳的锚点。 */
button[class*="_toggle"] [class*="_railFish"] { display: none !important; }
${markRule('button[class*="_toggle"]:has([class*="_railFish"])::before', 21)}
button[class*="_toggle"]:has([class*="_railFish"]):hover::before { display: none; }

/* 输入框背后的光晕：上游把 DeepSeek 蓝硬编码在 SVG 的 fill 属性里（不走
   token），是全页最后一处蓝。内联 SVG 能被 CSS 的 fill 覆盖。 */
[class*="_heroGlow"] ellipse { fill: ${P.accent2} !important; }

/* 首页 Hero：藏鲸鱼、原标题与「预览版」徽章，换自己的标记与字样。
   徽章标的是上游 harness 的预览状态，不该出现在自己的客户端上。 */
[class*="_fishHitbox"] { display: none !important; }
[class*="_previewBadge"] { display: none !important; }
[class*="_headline"] > [class*="_headlineText"] { display: none !important; }
/* 上游 _headline 是 grid 且优先级更高，不去覆盖它的布局——grid 会把
   ::before/::after 正常排进轨道。选择器排除 _headlineText，
   否则 [class*="_headline"] 会把它一并命中。 */
${markRule('[class*="_headline"]:not([class*="_headlineText"])::before', 30)}
[class*="_headline"]:not([class*="_headlineText"])::after {
	content: "${BRAND.headline}";
	color: var(--dsw-alias-label-primary);
	font-weight: 620;
}
`

		const name = 'kingcode-web-brand'
		const inject = ['theme']

		/**
		 * 叠上 KingCode 品牌 token 层，并注入品牌图形覆盖样式。
		 * @param ctx - 客户端插件上下文（theme 服务由 ui-theme 的浏览器半侧提供）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.theme.overrideTokens('kingcode-web-brand', TOKENS))
			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = name
				style.textContent = BRAND_CSS
				document.head.append(style)
				return () => { style.remove() }
			})
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})
