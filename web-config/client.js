/**
 * KingCode 跨机配置面 —— 浏览器半侧：设置页里的「KingCode」分区。
 *
 * 为什么存在：上游把 credentials.* 钉死在 loopback（PRIVILEGED_METHODS），
 * 于是自带的凭证页在跨机形态下整片 forbidden——鸿蒙上「填 API key」无路可走。
 * 本分区只补这一件事，走 index.js 那条只写不读的窄通道。
 * 模型列表与默认模型不在这里：llm.models / session.selectModel 跨机本来就能用，
 * 上游自己的「模型」分区照常工作（真机验过）。
 *
 * ── 三条会让人栽跟头的接缝事实 ────────────────────────────────────────────
 * ① 手写 lazy-CJS 工厂（同 tsdown clientBundle 产物格式）。**不能写 JSX 语法**，
 *    没有构建步骤；用 jsx()/jsxs()。require 只能取 shell 静态外部表里的条目。
 * ② `ctx.slots.inject(name, cb)` 对**不存在**的槽位名不会报错，而是**静默等到天荒地老**。
 *    打错一个字母的症状是「分区不出现」，没有任何日志。test/test-web-config.js
 *    拿装好的上游包核对这个名字，就是为了让这种沉默失败当场变成红。
 * ③ list 类槽位必须给 options.id（上游会抛）。order 排在上游四个分区之后：
 *    general 0 / models 10 / plugins 15 / agent-presets 20，所以取 30。
 *
 * ── 不显示密钥值 ──────────────────────────────────────────────────────────
 * 服务端 get 从来不回值（契约见 index.js），所以这里也无从显示。保存成功后
 * 立刻清空输入框并重新拉一次 get：以服务端的说法为准，不拿本地乐观状态糊弄人。
 */
window.__ModuleLoader__.load({
	id: 'kingcode-web-config',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const jsxRuntime = require('react/jsx-runtime')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		const { useState, useEffect, useCallback } = react
		const { jsx, jsxs } = jsxRuntime
		const { Button, Input } = primitives

		/** 与 index.js 的 CHANNEL 一致。改一边必须改另一边。 */
		const CHANNEL = '/kingcode-credentials'
		const REF = 'DEEPSEEK_API_KEY'

		// rpcId 只被上游校验成「字符串」（rpcIdSchema = z.string()），不必是 UUID。
		// 刻意不用 crypto.randomUUID：跨机 + 明文 HTTP 是不安全上下文，那个 API 是
		// undefined，用了就又踩一次静默失败（insecure-context-shim 补的正是它）。
		let seq = 0
		const nextRpcId = () => `kingcode-config-${Date.now().toString(36)}-${(seq += 1)}`

		/**
		 * 发一次通道调用。
		 * @param endpoint - get / set / unset。
		 * @param payload - 业务载荷。
		 * @returns 成功信封里的 value。
		 * @throws 带人话理由的 Error（调用方直接显示给用户）。
		 */
		async function callChannel(endpoint, payload) {
			const response = await fetch(`${CHANNEL}/${endpoint}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: nextRpcId(), method: endpoint, payload }),
			})

			// 403 是那道信任栅栏：Host 不在 trustedHosts 里。最常见的成因是虚拟机 IP 漂了
			// （NAT 重新分配），而服务是按启动时的 IP 建的名单——重启服务即可。
			if (response.status === 403) {
				throw new Error('服务端拒绝了这次请求（403）。多半是虚拟机 IP 变了、当前地址不在信任名单里；在虚拟机里重启一次 KingCode 服务。')
			}

			// 凭证桥没挂时，这个路径没有路由，会落到前端的 SPA fallback——拿到的是 200 + HTML。
			// 不看 content-type 就 json() 的话，报错会是一句没头没脑的 "Unexpected token <"。
			const contentType = response.headers.get('content-type') ?? ''
			if (!contentType.includes('application/json')) {
				throw new Error('凭证桥没有挂载（收到的是页面而不是数据）。启动服务时要带上 credential-bridge 覆盖层：KINGCODE_CREDENTIAL_BRIDGE=1。')
			}
			if (!response.ok) throw new Error(`服务端返回 HTTP ${response.status}`)

			const body = await response.json()
			const result = body?.result
			if (result?.ok !== true) {
				throw new Error(result?.error?.message ?? '服务端没有说明原因')
			}
			return result.value
		}

		const CSS = `
.kcfg_section { display: flex; flex-direction: column; gap: 16px; width: 100%; padding: 12px 0 8px; }
.kcfg_intro { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.kcfg_card {
	display: flex; flex-direction: column; gap: 10px;
	border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 14px 16px;
}
.kcfg_head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.kcfg_title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.kcfg_state { font-size: 12px; line-height: 18px; }
.kcfg_on { color: var(--dsw-alias-state-success-primary); }
.kcfg_off { color: var(--dsw-alias-label-tertiary); }
.kcfg_row { display: flex; align-items: center; gap: 8px; }
.kcfg_row > :first-child { flex: 1 1 auto; min-width: 0; }
.kcfg_note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.kcfg_error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.kcfg_done { color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 18px; }
`

		/**
		 * 把分区样式注入 <head>。照上游 CSS module 的做法带 data-plugin 标记，
		 * 便于在 devtools 里认出是谁加的；重复挂载时不重复插入。
		 * @returns 撤销函数。
		 */
		function installStyle() {
			const marker = 'kingcode-web-config'
			if (document.querySelector(`style[data-plugin="${marker}"]`) !== null) return () => {}
			const tag = document.createElement('style')
			tag.dataset.plugin = marker
			tag.textContent = CSS
			document.head.append(tag)
			return () => { tag.remove() }
		}

		/**
		 * 「KingCode」设置分区。
		 * @returns 分区元素。
		 */
		function KingCodeSection() {
			const [state, setState] = useState({ status: 'loading' })
			const [draft, setDraft] = useState('')
			const [busy, setBusy] = useState(false)
			const [notice, setNotice] = useState(null)

			const refresh = useCallback(async () => {
				try {
					const value = await callChannel('get', {})
					setState({ status: 'ready', info: value.refs?.[REF] ?? { configured: false, writable: true } })
				} catch (error) {
					setState({ status: 'error', message: error?.message ?? String(error) })
				}
			}, [])

			useEffect(() => { void refresh() }, [refresh])

			const submit = useCallback(async (endpoint, payload) => {
				setBusy(true)
				setNotice(null)
				try {
					await callChannel(endpoint, payload)
					// 先清空输入框再拉状态：密钥不在 DOM 里多留一拍。
					setDraft('')
					await refresh()
					setNotice({ kind: 'done', text: endpoint === 'set' ? '已保存。新会话即可使用。' : '已清除。' })
				} catch (error) {
					setNotice({ kind: 'error', text: error?.message ?? String(error) })
				} finally {
					setBusy(false)
				}
			}, [refresh])

			if (state.status === 'loading') {
				return jsx('div', { className: 'kcfg_section', children: jsx('div', { className: 'kcfg_note', children: '读取中…' }) })
			}
			if (state.status === 'error') {
				return jsx('div', {
					className: 'kcfg_section',
					children: jsx('div', { className: 'kcfg_error', role: 'alert', children: state.message }),
				})
			}

			const info = state.info
			const writable = info.writable !== false
			const trimmed = draft.trim()

			const rows = [
				jsxs('div', {
					className: 'kcfg_head',
					children: [
						jsx('span', { className: 'kcfg_title', children: 'DeepSeek API 密钥' }),
						jsx('span', {
							className: `kcfg_state ${info.configured ? 'kcfg_on' : 'kcfg_off'}`,
							children: info.configured
								? `已配置${info.source === undefined ? '' : `（来源：${info.source}）`}`
								: '未配置',
						}),
					],
				}, 'head'),
			]

			if (writable) {
				rows.push(jsxs('div', {
					className: 'kcfg_row',
					children: [
						jsx(Input, {
							type: 'password',
							value: draft,
							placeholder: info.configured ? '输入新密钥以替换' : 'sk-…',
							autoComplete: 'off',
							spellCheck: false,
							disabled: busy,
							onChange: (event) => { setDraft(event.target.value) },
							onKeyDown: (event) => {
								if (event.key === 'Enter' && trimmed !== '' && !busy) {
									void submit('set', { ref: REF, value: trimmed })
								}
							},
						}),
						jsx(Button, {
							variant: 'primary',
							size: 'sm',
							disabled: busy || trimmed === '',
							onClick: () => { void submit('set', { ref: REF, value: trimmed }) },
							children: '保存',
						}),
						info.configured
							? jsx(Button, {
								variant: 'outline',
								size: 'sm',
								disabled: busy,
								onClick: () => { void submit('unset', { ref: REF }) },
								children: '清除',
							})
							: null,
					],
				}, 'row'))
				rows.push(jsx('div', {
					className: 'kcfg_note',
					children: '密钥写进虚拟机里的凭证库，只写不读——这里永远不会显示已有的值。',
				}, 'note'))
			} else {
				// writable=false 意味着被启动环境里的同名环境变量遮蔽了。不说清楚的话，
				// 用户会一直在这里改、一直觉得「写了没反应」。
				rows.push(jsx('div', {
					className: 'kcfg_note',
					children: `这个密钥被启动服务时的环境变量 ${REF} 遮蔽了，在这里改不会生效。要改就改启动环境，或去掉那个环境变量后重启服务。`,
				}, 'shadowed'))
			}

			if (notice !== null) {
				rows.push(jsx('div', {
					className: notice.kind === 'error' ? 'kcfg_error' : 'kcfg_done',
					role: notice.kind === 'error' ? 'alert' : 'status',
					children: notice.text,
				}, 'notice'))
			}

			return jsxs('div', {
				className: 'kcfg_section',
				children: [
					jsx('div', {
						className: 'kcfg_intro',
						children: '引擎跑在另一台机器上（壳在鸿蒙桌面，引擎在虚拟机里），上游的设置接口只认本机回环——这个设置页里除本区外多半会报 403。密钥在这里填；换模型用输入框上的模型选择器，那条路不受限制。',
					}),
					jsx('div', { className: 'kcfg_card', children: rows }),
				],
			})
		}

		const name = 'kingcode-web-config'
		const inject = ['slots']

		/**
		 * 把「KingCode」分区挂进设置页。
		 * @param ctx - 客户端插件上下文（slots 由 ui-slots 提供）。
		 */
		function apply(ctx) {
			ctx.effect(installStyle)
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'kingcode',
				order: 30,
				label: 'KingCode',
			}, KingCodeSection))
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		exports.CHANNEL = CHANNEL
		exports.callChannel = callChannel
		exports.KingCodeSection = KingCodeSection
		return module.exports
	},
})
