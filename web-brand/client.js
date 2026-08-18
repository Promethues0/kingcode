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
 * 配色：苔径晨雾大地色系（墨绿黑 #262B24 / 纸底 #F1EFE7·#FCFBF7 /
 * 深赭 accent #8F5127→#B97B45 / 岩灰 #6A6B61 / 分隔线 #DFDDD0 /
 * danger 洋红调 #963C4A / good 蓝绿 #447A6E / warn 金 #B1881E），
 * 暗色是同族的「夜径」。**改配色只改下面 P 常量块。**
 */
window.__ModuleLoader__.load({
	id: 'kingcode-web-brand',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ── 调色板（唯一事实源；favicon 的同名色在 index.js 顶部）────────────
		const P = {
			// 亮色：苔径晨雾
			ink: '#262B24',        // 墨绿黑，主文字与主按钮
			ink2: '#333830',       // ink 提亮一档
			ink3: '#4A4E45',       // 次级文字
			muted: '#6A6B61',      // 岩灰，三级文字
			faint: '#8E8F84',      // 说明文字
			surface: '#FCFBF7',    // 最外层纸底（浅）
			paper2: '#F7F5EE',     // 第二层
			paper: '#F1EFE7',      // 第三层／侧栏
			sink: '#EBE8DD',       // 浮层／标签底
			sink2: '#E4E1D5',      // 按下态
			line: '#DFDDD0',       // 分隔线
			accent: '#8F5127',     // 深赭（主 accent）
			accent2: '#B97B45',    // 深赭渐变另一端
			danger: '#963C4A',     // 洋红调 danger
			good: '#447A6E',       // 蓝绿
			warn: '#B1881E',       // 金
			// 暗色：夜径（同族深色）
			dBase: '#191C18',
			dL1: '#1E221C',
			dL2: '#242821',
			dL3: '#2A2E27',
			dL4: '#343830',
			dL5: '#3E4239',
			dCode: '#161915',
			dText: '#EDEBE1',
			dText2: '#B9B7AB',
			dText3: '#94958A',
			dAccent: '#C08850',
			dAccent2: '#D19A62',
			// danger/good 的暗色值不是亮色值随手提亮的结果：两者在红绿色弱
			// 模拟（Machado 1.0）下会因明度相近而收敛，网格搜索后取
			// ΔL 11.2 + ΔE 18.5(protan)/19.6(deutan)，沿用亮色板 ≥16 的标准。
			// 改这两个值前请重跑 tools/check-contrast.js。
			dDanger: '#CE7280',
			dGood: '#70B7B3',
			dWarn: '#CFA23C',
		}

		/** rgba 辅助：亮色用墨绿黑透明度、暗色用暖白透明度（沿用上游两模式惯例）。 */
		const inkA = a => `rgba(38, 43, 36, ${a})`
		const litA = a => `rgba(237, 235, 225, ${a})`

		/** 静态色阶同值双写（上游静态阶亮暗基本同值，这里保持该惯例）。 */
		const flat = v => ({ light: v, dark: v })

		const TOKENS = {
			// DeepSeek 蓝的整条静态阶 → 深赭家族。别名层覆盖不到那些直接吃
			// --dsw-static-deepseek-* 的组件（如首页「预览版」徽章底），
			// 按明度逐档对映后，任何直接消费者都自动落进苔径晨雾里。
			'--dsw-static-deepseek-50': flat('#FBF4EC'),
			'--dsw-static-deepseek-100': flat('#F4E9DC'),
			'--dsw-static-deepseek-200': flat('#EBD9C4'),
			'--dsw-static-deepseek-300': flat('#DCBE9B'),
			'--dsw-static-deepseek-400': flat('#C08850'),
			'--dsw-static-deepseek-450': flat('#B97B45'),
			'--dsw-static-deepseek-500': flat('#8F5127'),
			'--dsw-static-deepseek-600': flat('#7C4622'),
			'--dsw-static-deepseek-800': flat('#3A2B1E'),
			'--dsw-static-deepseek-900': flat('#2B2118'),

			// 背景四层：亮色是纸底逐层加深，暗色逐层提亮
			'--dsw-alias-bg-base': { light: P.surface, dark: P.dBase },
			'--dsw-alias-bg-layer-1': { light: P.surface, dark: P.dL1 },
			'--dsw-alias-bg-layer-2': { light: P.paper2, dark: P.dL2 },
			'--dsw-alias-bg-layer-3': { light: P.paper, dark: P.dL3 },
			'--dsw-alias-bg-overlay': { light: P.sink, dark: P.dL4 },
			'--dsw-alias-bg-module-platform': { light: P.paper2, dark: P.dL2 },
			'--dsw-alias-bg-multi-select': { light: P.paper2, dark: P.dL3 },
			'--dsw-alias-bg-skeleton': { light: inkA(0.05), dark: litA(0.08) },
			'--dsw-alias-bg-mask-drop': { light: 'rgba(252, 251, 247, 0.7)', dark: 'rgba(25, 28, 24, 0.7)' },

			// 描边
			'--dsw-alias-border-l1': { light: inkA(0.05), dark: litA(0.06) },
			'--dsw-alias-border-l2': { light: inkA(0.1), dark: litA(0.12) },
			'--dsw-alias-border-l2-darkmode-thin': { light: inkA(0.1), dark: litA(0.06) },
			'--dsw-alias-border-l3': { light: inkA(0.14), dark: litA(0.16) },
			'--dsw-alias-border-l4': { light: inkA(0.2), dark: litA(0.2) },

			// 文字
			'--dsw-alias-label-primary': { light: P.ink, dark: P.dText },
			'--dsw-alias-label-primary-dimmed': { light: P.ink2, dark: '#DAD8CC' },
			'--dsw-alias-label-primary-foreground': { light: P.surface, dark: P.dBase },
			'--dsw-alias-label-primary-inverted': { light: P.surface, dark: P.dL2 },
			'--dsw-alias-label-primary-bluish': { light: P.ink, dark: P.dText },
			'--dsw-alias-label-secondary': { light: P.ink3, dark: P.dText2 },
			'--dsw-alias-label-tertiary': { light: P.muted, dark: P.dText3 },
			'--dsw-alias-label-caption': { light: P.faint, dark: P.muted },
			'--dsw-alias-label-dimmed': { light: P.line, dark: '#4A4E45' },

			// 品牌主色：上游是纯黑/纯白，这里换成墨绿黑/暖白
			'--dsw-alias-brand-primary': { light: P.ink, dark: P.dText },
			'--dsw-alias-brand-primary-invert': { light: P.ink, dark: P.dText },
			'--dsw-alias-brand-text': { light: P.ink, dark: P.dText },
			// accent 位（上游是 DeepSeek 蓝）→ 深赭
			'--dsw-alias-brand-primary-new-colorprimary-new-color': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-state-business-primary': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-business-primary': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-business-tertiary': { light: '#F0E4D9', dark: '#33281E' },

			// 按钮
			'--dsw-alias-button-primary-fill': { light: P.ink, dark: P.dText },
			'--dsw-alias-button-primary-hover': { light: '#3A4036', dark: '#D5D3C7' },
			'--dsw-alias-button-primary-dimmed': { light: P.sink2, dark: '#3A4036' },
			'--dsw-alias-button-contrast-fill': { light: P.ink3, dark: P.dText },
			'--dsw-alias-button-elevated-fill': { light: P.surface, dark: P.dL4 },
			'--dsw-alias-button-floating-fill': { light: P.surface, dark: P.dL2 },
			'--dsw-alias-button-floating-hover': { light: P.paper, dark: P.dL3 },
			'--dsw-alias-button-ghost-active-fill': { light: P.sink, dark: P.dL4 },
			'--dsw-alias-button-ghost-active-hover': { light: P.sink2, dark: P.dL5 },
			'--dsw-alias-button-ghost-active-border': { light: '#A8A99E', dark: P.muted },
			// 主动作钮（发送等）：深赭而非蓝
			'--dsw-alias-button-info-fill': { light: P.accent, dark: P.dAccent },
			'--dsw-alias-button-info-hover': { light: '#A66334', dark: P.dAccent2 },

			// 交互态
			'--dsw-alias-interactive-bg-hover': { light: inkA(0.06), dark: litA(0.08) },
			'--dsw-alias-interactive-bg-hover-solid': { light: P.paper, dark: P.dL2 },
			'--dsw-alias-interactive-bg-hover-accent': { light: inkA(0.14), dark: litA(0.24) },
			'--dsw-alias-interactive-bg-active': { light: inkA(0.1), dark: litA(0.14) },
			'--dsw-alias-interactive-bg-hover-danger': { light: 'rgba(150, 60, 74, 0.06)', dark: 'rgba(196, 99, 111, 0.15)' },

			// 状态色
			'--dsw-alias-error-primary': { light: P.danger, dark: P.dDanger },
			'--dsw-alias-error-secondary': { light: '#B04B5A', dark: '#DB8E97' },
			'--dsw-alias-success-primary': { light: P.good, dark: P.dGood },
			'--dsw-alias-success-secondary': { light: '#55907F', dark: '#8AC7C3' },
			'--dsw-alias-success-tertiary': { light: '#E3EFEA', dark: '#1E2E2A' },
			'--dsw-alias-warn-primary': { light: P.warn, dark: P.dWarn },
			'--dsw-alias-warn-secondary': { light: '#C79C2E', dark: '#DDB456' },
			'--dsw-alias-warn-label': { light: '#96731A', dark: P.dWarn },
			'--dsw-alias-warn-tertiary': { light: '#F5EEDA', dark: '#302A18' },

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
