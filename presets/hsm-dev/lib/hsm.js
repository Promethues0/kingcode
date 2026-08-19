/**
 * 服务器密码机（FLK SDF SDK）开发辅助引擎 —— 纯函数。
 *
 * 核心是**错误码分诊**：KB3 的立论是「拿到一个错误码先看它落在哪一段，
 * 就知道该去哪儿找问题，比逐个查表快得多」。分错段的代价以天计——
 * 源文举的例子：0x01050019（IV 为空，参数问题）与 0x01000019（MAC 运算失败）
 * 只差一位，却是完全不同的故障域，误诊会让整个团队查错方向。
 *
 * 另一条硬纪律来自 KB6：引用任何实测缺陷都必须附复现命令——
 * 让开发者自己确认，而不是让他相信一个断言。工具层负责强制带上。
 */

/** 规范化错误码输入：接受 0x01000019 / 01000019 / 16777241(十进制) / 大小写混写。 */
export function normalizeCode(input) {
  if (typeof input === 'number' && Number.isInteger(input)) {
    return { hex: `0x${(input >>> 0).toString(16).toUpperCase().padStart(8, '0')}`, value: input >>> 0 }
  }
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('错误码为空')
  // 前缀大小写都认：用户从日志/文档粘过来的写法不可控（0x / 0X 都常见）
  const m = /^(0[xX])?([0-9a-fA-F]{1,8})$/.exec(raw.replace(/[\s_]/g, ''))
  if (m) {
    const value = Number.parseInt(m[2], 16)
    return { hex: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`, value }
  }
  // 纯十进制
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10)
    return { hex: `0x${value.toString(16).toUpperCase().padStart(8, '0')}`, value }
  }
  throw new Error(`无法识别的错误码写法：${input}（接受 0x01000019 / 01000019 / 十进制）`)
}

/**
 * 段位分诊。优先精确码（UKey 这类跨段特例），再按高 16 位前缀匹配。
 * @param {string|number} input - 错误码。
 * @param {object} data - hsm-errcode.json。
 */
export function diagnose(input, data) {
  const { hex, value } = normalizeCode(input)
  const codes = data.codes ?? []
  const segments = data.segments ?? []

  const exact = codes.find(c => normalizeCode(c.code_hex).value === value)

  // 段前缀：取高 16 位（0x01000019 → 0x0100）。
  // 比较前两边都归一成「无 0x 前缀的大写十六进制」——数据里写的是 '0x0105'，
  // 若只把两边 toUpperCase 再比字符串，'0X0105' 与 '0x0105' 永远不相等。
  const prefixNum = (value >>> 16) & 0xFFFF
  const prefix = `0x${prefixNum.toString(16).toUpperCase().padStart(4, '0')}`
  const segment = segments.find(s => {
    const raw = String(s.prefix_hex ?? '').replace(/[\s_]/g, '')
    if (raw === '') return false
    const parsed = Number.parseInt(raw.replace(/^0[xX]/, ''), 16)
    return Number.isFinite(parsed) && parsed === prefixNum
  }) ?? null

  // 易混淆提示：同低 16 位但不同段的码
  const low = value & 0xFFFF
  const confusable = codes
    .filter(c => {
      const v = normalizeCode(c.code_hex).value
      return v !== value && (v & 0xFFFF) === low
    })
    .map(c => ({ code_hex: c.code_hex, name: c.name, meaning: c.meaning, segment: c.segment }))

  const javaConflict = (data.java_doc_conflicts ?? [])
    .find(c => normalizeCode(c.code_hex).value === value) ?? null

  return {
    input: String(input),
    hex,
    prefix,
    segment,
    code: exact,
    confusable,
    javaDocConflict: javaConflict,
    // 没查到也要给方向：段位本身就是最有用的诊断动作
    guidance: exact
      ? `${exact.name}：${exact.meaning}`
      : segment
        ? `未在错误码表中收录此码，但它落在${segment.domain}段——先查：${segment.first_check}`
        : '未知段位：确认打印用的是 %x（错误码是位段化的十六进制），并核对是否来自 sdf.h 而非 Java 文档',
    warnings: [
      javaConflict ? `⚠️ Java 版说明书对该码的说法与头文件冲突（文档称「${javaConflict.java_doc_says}」，实为「${javaConflict.actual}」）——**以 sdf.h 为准**` : null,
      confusable.length > 0 ? `⚠️ 存在低位相同、段位不同的易混码：${confusable.map(c => `${c.code_hex}(${c.name})`).join('、')}——分错段会让整个团队查错方向` : null,
    ].filter(Boolean),
  }
}

/** 接口检索：按函数名（模糊）/分组/状态过滤。空桩函数是最要紧的命中。 */
export function findApi({ query, status, group }, data) {
  const groups = data.groups ?? []
  let rows = groups.flatMap(g => (g.functions ?? []).map(f => ({ ...f, group: g.name })))
  if (query) {
    const q = String(query).toLowerCase()
    rows = rows.filter(f => f.name.toLowerCase().includes(q) || (f.signature ?? '').toLowerCase().includes(q))
  }
  if (status) rows = rows.filter(f => f.status === status)
  if (group) rows = rows.filter(f => f.group === group)
  return {
    matches: rows,
    stubHits: rows.filter(f => f.status === 'stub').map(f => f.name),
    counts: data.counts ?? null,
  }
}

/** 缺陷检索：命中的每条都必须带 repro（工具层据此强制附复现命令）。 */
export function findDefects(query, data) {
  const q = String(query ?? '').trim().toLowerCase()
  const all = data.defects ?? []
  if (q === '') return { matches: all, citationRule: data.citation_rule ?? null }
  const matches = all.filter(d =>
    (d.title ?? '').toLowerCase().includes(q)
    || (d.phenomenon ?? '').toLowerCase().includes(q)
    || (d.affected ?? []).some(a => String(a).toLowerCase().includes(q)))
  return { matches, citationRule: data.citation_rule ?? null }
}

/** 校验：每条被引用的缺陷都带了复现命令（防止工具层漏带）。 */
export function assertRepro(defects) {
  const missing = defects.filter(d => !d.repro || String(d.repro).trim() === '')
  if (missing.length > 0) {
    throw new Error(`以下缺陷缺复现命令，按 KB6 规则不得引用：${missing.map(d => d.id ?? d.title).join('、')}`)
  }
  return true
}
