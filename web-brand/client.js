/**
 * KingCode Web UI 品牌层 —— 浏览器半侧。
 *
 * 手写的 lazy-CJS 工厂包裹（与 tsdown clientBundle 预设产物同格式）：只 require
 * `react` 这一个模块表条目（上游共享进冻结模块表的那几个之一），不 JSX、不打包，
 * 所以仍然无需构建工具链，改完即生效。
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

		// 模块表条目。上游把 react / react/jsx-runtime / react-dom(/client) /
		// @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
		// dsh-client-ui-primitives 这几个共享进冻结模块表（PLATFORM_MODULES，见
		// dsh-client-web/src/platform.ts），运行期加载的插件 require 它们即可——
		// 所以占 slot 不需要把 React 打进本文件，也就仍然不需要构建工具链。
		// 不用 JSX（那需要转译）：下面统一用 React.createElement。
		const React = require('react')

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

			// K 字标的渐变两端。名字不带 --dsw- 前缀是有意的：它不是上游别名体系里的
			// token，只是本插件自己要用的两个值。overrideTokens 不校验名字、只校验
			// {light, dark} 成对（见 ui-theme 的 validateOverrides），所以借它这一层
			// 最省事——亮暗切换、随插件 dispose 一起撤，两件事都白拿。
			// 下面 slot 占位组件里的内联 SVG 用 var() 读它们，因此不必再像老版那样
			// 生成两份烤死颜色的 data URI。
			'--kingcode-mark-from': { light: P.accent, dark: P.dAccent },
			'--kingcode-mark-to': { light: P.accent2, dark: P.dAccent2 },
		}

		// ── 品牌文案与标记（想改名/改标语只动这里）──────────────────────────
		const BRAND = {
			wordmark: 'KingCode',   // 侧栏左上角
			headline: 'KingCode',   // 首页大标题（原「探索未至之境」）
		}

		/**
		 * K 字标（内联 SVG，供三个品牌 slot 共用）。
		 *
		 * 从「data URI 背景图 + 亮暗两份烤死的颜色」换成内联 SVG：它现在是 slot 占位
		 * 组件的返回值，不再是 ::before 的背景图，所以那两条历史约束都不成立了——
		 * 当年不敢跟 CSS 变量走，是因为走的是 `mask`（WebKit 上简写丢 no-repeat 会把
		 * 蒙版平铺成「|K|」，改长写后边缘又在栅格化时抖噪点）；内联 SVG 的 stop-color
		 * 吃 var() 没有这些毛病，亮暗切换交给上面那两个 token 即可。
		 *
		 * gradientUnits 仍然必须是 userSpaceOnUse：默认的 objectBoundingBox 以每个
		 * 形状自己的包围盒为参照，而竖笔是条垂直线、盒宽为零，按 SVG 规范渐变退化后
		 * 该形状根本不绘制——K 会变成「<」。用户空间坐标还顺带让三笔共享同一条渐变。
		 *
		 * 渐变 id 必须每实例唯一（useId）：侧栏与首页会同时挂着，而 SVG 的 id 是整个
		 * 文档的作用域——重名时后挂的那份会去引用先挂的那条渐变。现在同色看不出来，
		 * 将来给某一处单独换色就会串。
		 *
		 * @param props.size - 正方形边长（px），由 slot 的 owner 侧给出。
		 * @param props.className - 宿主给的类名（保持它周围的几何），可缺省。
		 * @returns React 元素。
		 */
		function KMark({ size, className }) {
			const gradientId = React.useId()
			const h = React.createElement
			return h('svg', {
				className,
				width: size,
				height: size,
				viewBox: '0 0 32 32',
				'aria-hidden': true,
				focusable: 'false',
			},
			h('defs', null, h('linearGradient', {
				id: gradientId, gradientUnits: 'userSpaceOnUse', x1: 7, y1: 5, x2: 23, y2: 27,
			},
			h('stop', { offset: '0', stopColor: 'var(--kingcode-mark-from)' }),
			h('stop', { offset: '1', stopColor: 'var(--kingcode-mark-to)' }))),
			h('g', {
				fill: 'none',
				stroke: `url(#${gradientId})`,
				strokeWidth: 4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
			},
			h('path', { d: 'M9 7 L9 25' }),
			h('path', { d: 'M12 16 L21.5 6.2' }),
			h('path', { d: 'M12 16 L21.5 25.8' })))
		}

		/**
		 * 把浏览器标题里的「产品名」那一截换成 KingCode。
		 *
		 * 为什么需要它：dsh 0.1.0-rc.8 起，产品名不再取自服务端注入的 <title>，而是
		 * `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`（ui-layout 的
		 * AppFrame）——**构建期烤进前端 bundle**。而我们用的是上游预构建的 bundle，
		 * 那个值就是上游自己的产品名。于是 ui-layout 的 DocumentTitle 一挂载，
		 * index.js 那边 tapIndex 改好的 <title> 就被整段盖掉，标签页写着上游的名字。
		 * 上游 dsh-client-ui-brand-official 的 README 明说标题「不在槽位系统之内」，
		 * 所以这里没有缝可占，只能在标题被写之后把它改回来。
		 *
		 * 不写死上游那个字符串：它随构建变（官方构建一个值、本地构建是 locale 的
		 * 「本地构建」文案）。判据改成「不是我们的名字就换掉」——DocumentTitle 写的
		 * 格式是 `${会话名} — ${产品名}`，所以只替换最后一段，会话名照留。
		 * 分隔符万一被上游改了，就落到最后那个分支：整条换成 KingCode——丢了会话名，
		 * 但绝不会露出上游品牌，这个方向的失败是安全的。
		 *
		 * @param raw - 当前的 document.title。
		 * @returns 应该显示的标题。
		 */
		const SEPARATOR = ' — '
		function brandedTitle(raw) {
			if (raw === BRAND.wordmark || raw.endsWith(SEPARATOR + BRAND.wordmark)) return raw
			const cut = raw.lastIndexOf(SEPARATOR)
			if (cut > 0) return raw.slice(0, cut) + SEPARATOR + BRAND.wordmark
			return BRAND.wordmark
		}

		/**
		 * 侧栏字标。上游的 fallback 是一段通用文案，占住这个 slot 就整段换掉。
		 * @returns React 元素。
		 */
		function KWordmark() {
			return React.createElement('span', {
				style: {
					fontSize: 15,
					fontWeight: 640,
					letterSpacing: '0.005em',
					color: 'var(--dsw-alias-label-primary)',
					whiteSpace: 'nowrap',
				},
			}, BRAND.wordmark)
		}

		/**
		 * 剩下的品牌图形覆盖——**只剩两条**，都是上游没开缝的地方。
		 *
		 * 原来这里有五条，其中三条（侧栏字标、收起态 rail 的鲸鱼、首页 Hero 的鲸鱼）
		 * 已经改走官方 slot（见下面 apply）。留在 CSS 里的这两条，是因为上游确实
		 * 没有对应的扩展点：`_headlineText` 与 `_previewBadge` 是 EmptyHero 直接渲染的
		 * 两个 span（文案来自 locale 的 hero.headline / hero.preview），而 locale 那边
		 * 只支持「注册新语言」，不支持覆盖既有语言的某个词条——真去注册一门语言，
		 * 就等于逼用户在设置里多选一档语言，比这两行 CSS 更糟。
		 *
		 * 选择器只用「哈希前缀 + _语义名」里的稳定后缀，不写死 CSS Modules 的完整
		 * 哈希类名——上游重建会换前缀、不换后缀。匹配不到时是无害的空规则，UI 退回
		 * 上游原样，不会白屏。
		 */
		// ⚠️ 这是模板字符串：**注释里一个反引号都不能出现**。写了就会把模板从中间
		// 截断，而 `node --check` 照样通过（截断后仍是合法 JS）、check:contrast 也通过，
		// 于是残缺的 CSS 一路发到真机上，表现为上游品牌整个露出来且不报任何错。
		// 这个坑我踩过两次。test/test-web-brand.js 会断言反引号成对与规则完整，
		// 改这段之后务必 npm test。
		const BRAND_CSS = `
/* 输入框背后的光晕：上游把 DeepSeek 蓝硬编码在 SVG 的 fill 属性里（不走
   token），是全页最后一处蓝。内联 SVG 能被 CSS 的 fill 覆盖。 */
[class*="_heroGlow"] ellipse { fill: ${P.accent2} !important; }

/* 首页 Hero 的原标题与「预览版」徽章。标记本身已经由
   conversation.hero.brand.mark 这个 slot 接管，这里只处理这两段文案：
   徽章标的是上游 harness 的预览状态，不该出现在自己的客户端上。
   上游 _headline 是 grid 且优先级更高，不去覆盖它的布局——grid 会把 ::after
   正常排进轨道。选择器排除 _headlineText，否则 [class*="_headline"] 会把它
   一并命中。 */
[class*="_previewBadge"] { display: none !important; }
[class*="_headlineText"] { display: none !important; }
[class*="_headline"]:not([class*="_headlineText"])::after {
	content: "${BRAND.headline}";
	color: var(--dsw-alias-label-primary);
	font-weight: 620;
}
`

		const name = 'kingcode-web-brand'
		// slots 是 0.1.0-rc.8 起的官方品牌扩展点（`feat(client): compose deployment
		// branding through slots`）。上游自己的 dsh-client-ui-brand-official 就是靠占
		// 同一批 slot 实现的，它的 README 把这条路写成了唯一路径：
		// 「a deployment with its own identity leaves this package out and composes
		//   another package that occupies the sidebar slots」。
		const inject = ['theme', 'slots']

		/**
		 * 叠上 KingCode 品牌 token 层、占住三个品牌 slot，并注入剩下那两条覆盖样式。
		 *
		 * slot 的注册要点（照上游 dsh-client-ui-brand-official 的写法）：
		 * ① `ctx.slots.inject(名字, 回调)` 会等到那个 slot 被**声明**之后再跑回调，
		 *    所以本行先挂还是声明方先挂都无所谓，声明消失时占位也会跟着撤；
		 * ② 侧栏那两个套在一起注册（生成器逐个 yield disposer），是为了让它们**同生
		 *    同死**——HMR 时不会出现「K 字标已换、字样还是上游」这种半拉状态；
		 * ③ 首页那个单独 inject：它由 ui-conversation 声明，与侧栏不是同一个包。
		 *    套进上面那组的话，任一方缺席就会把另一方也拖着不生效。
		 *
		 * 一个 slot 一次只有一个占位者（kind: 'single'），所以占住即整段替换，不需要
		 * 再去藏上游的 fallback——那正是原来那三条 `display: none !important` 在干的事。
		 *
		 * @param ctx - 客户端插件上下文（theme 与 slots 都由上游浏览器半侧提供）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.theme.overrideTokens('kingcode-web-brand', TOKENS))

			ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () =>
				ctx.slots.inject('sidebar.brand.name', function* () {
					yield ctx.slots.register({ name: 'sidebar.brand.mark' }, KMark)
					yield ctx.slots.register({ name: 'sidebar.brand.name' }, KWordmark)
				})))

			ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', function* () {
				yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, KMark)
			}))

			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = name
				style.textContent = BRAND_CSS
				document.head.append(style)
				return () => { style.remove() }
			})

			// 标题守卫。observe 的是 <head> 的 subtree 而不是 <title> 元素本身：
			// DocumentTitle 用的是 `document.title = …`（改的是文本子节点，subtree
			// 能收到），但整个 <title> 元素被换掉的写法也存在，锚 head 两种都盖住。
			// 先读后写并比较，写回不会再触发一轮有效改动，所以不会自激。
			ctx.effect(() => {
				const retitle = () => {
					const next = brandedTitle(document.title)
					if (next !== document.title) document.title = next
				}
				retitle()
				const observer = new MutationObserver(retitle)
				observer.observe(document.head, { childList: true, subtree: true, characterData: true })
				return () => { observer.disconnect() }
			})
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})
