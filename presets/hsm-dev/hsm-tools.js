/**
 * 服务器密码机开发工具插件 —— 四个 hsm_* 工具。
 * 与 mpe 系一致：零 @deepseek-ai import、裸 schema register。
 *
 * hsm_diagnose   错误码分诊（段位→故障域→第一反应查什么；带 Java 文档冲突警告）
 * hsm_kb_api     229 个接口速查（重点是 🔴 空桩——调用必失败）
 * hsm_kb_struct  数据结构与算法标识（SM2 的 32 字节右对齐是最高频故障）
 * hsm_kb_defect  实测缺陷清单（**返回必带复现命令**，KB6 的硬规则）
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose, findApi, findDefects, assertRepro } from './lib/hsm.js'

export const name = 'kingcode-hsm-tools'
export const inject = ['tools']

const DATA_DIR = fileURLToPath(new URL('data/', import.meta.url))

let cache = null
function loadData() {
  if (cache) return cache
  const load = file => {
    try {
      return JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'))
    } catch (error) {
      throw new Error(`密码机知识数据 ${file} 不可用（${error.message}）。请确认 preset 完整安装。`)
    }
  }
  cache = {
    api: load('hsm-api.json'),
    struct: load('hsm-struct.json'),
    errcode: load('hsm-errcode.json'),
    defects: load('hsm-defects.json'),
  }
  return cache
}

const asText = v => [{ type: 'text', text: v }]
const jsonSchema = { type: 'object', additionalProperties: true }

export function apply(ctx) {
  const register = def => ctx.effect(() => ctx.tools.register(def))

  register({
    name: 'hsm_diagnose',
    description: '密码机错误码分诊：输入返回值（0x01000019 / 01000019 / 十进制都认），先定位它落在哪一段（标准/通讯/参数透传/JNI/时间戳/密码卡/UKey），给出故障域与「第一反应该查什么」，再给具体码的含义、症状、根因与处方。同时报出低位相同但段位不同的易混码，以及 Java 版说明书与头文件冲突的告警——分错段会让整个团队查错方向，代价以天计。排障第一步就调它，不要凭记忆猜错误码。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '错误码，如 0x01050019 / 01050019 / 17104921' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(
        `${v.hex}｜段 ${v.prefix}${v.segment ? `（${v.segment.domain}）` : ''}\n${v.guidance}`
        + (v.segment ? `\n第一反应查：${v.segment.first_check}` : '')
        + (v.warnings.length > 0 ? `\n${v.warnings.join('\n')}` : ''),
      ),
    },
    async execute(args) {
      return diagnose(args.code, loadData().errcode)
    },
  })

  register({
    name: 'hsm_kb_api',
    description: 'SDF 接口速查（随库 sdf.h 全集 229 个函数）：按函数名模糊查、按状态筛（sample=有官方样例可照抄 / declared=仅有声明用法需实测 / stub=**空桩，调用恒返 SDR_NOTSUPPORT 必失败**）、按分组列。写任何调用前先查状态——照头文件写 stub 函数是本 SDK 最典型的坑（如 PQC_Sign、SDF_LoadLib 都是空桩）。不传参数则返回全量计数与分组概览。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '函数名或片段，如 PQC_Sign、SDF_Encrypt' },
        status: { type: 'string', enum: ['sample', 'declared', 'stub'], description: '按状态筛选' },
        group: { type: 'string', description: '按分组筛选' },
      },
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(
        `命中 ${v.matches.length} 个接口`
        + (v.stubHits.length > 0 ? `\n🔴 其中空桩（调用必失败）：${v.stubHits.join('、')}` : '')
        + (v.matches.length > 0 && v.matches.length <= 8
          ? `\n${v.matches.map(f => `${f.status === 'stub' ? '🔴' : f.status === 'sample' ? '🟢' : f.status === 'declared' ? '🟡' : '⚪'} ${f.name}${f.trap ? ` ⚠️ ${f.trap}` : ''}`).join('\n')}`
          : ''),
      ),
    },
    async execute(args) {
      const data = loadData()
      // KB1 的速查表标了 18 个 🔴，KB6 的二进制实测确证 21 个（+1 个仅 ARM64）——
      // 两份清单互补。只看 KB1 会漏掉 4 个空桩，而漏掉的每一个都会让人写出
      // 「能编译、能链接、调用必失败」的代码，所以这里合并两个来源。
      const kb6Stubs = new Set(
        (data.defects.defects ?? [])
          .filter(d => /空桩/.test(d.title ?? ''))
          .flatMap(d => d.affected ?? []),
      )
      if (!args.query && !args.status && !args.group) {
        return {
          matches: [],
          stubHits: [],
          counts: data.api.counts ?? null,
          groups: (data.api.groups ?? []).map(g => ({ name: g.name, count: (g.functions ?? []).length })),
          preflight: data.api.preflight ?? [],
          stubsFromDefectList: [...kb6Stubs],
          countsNote: '总数以 KB1 速查表实际枚举为准；源文头部声称 229，其中 26 个未逐条列出（见 counts.unenumerated_in_source）',
        }
      }
      const result = findApi(args, data.api)
      // 命中项里凡在 KB6 空桩清单中的，即便 KB1 没标 🔴 也要点出来
      const extraStubs = result.matches
        .filter(f => f.status !== 'stub' && kb6Stubs.has(f.name))
        .map(f => f.name)
      return {
        ...result,
        stubHits: [...new Set([...result.stubHits, ...extraStubs])],
        stubsOnlyInDefectList: extraStubs,
      }
    },
  })

  register({
    name: 'hsm_kb_struct',
    description: '数据结构与算法标识速查：SM2 结构体的 32 字节右对齐规则（有效数据放 [32..63]，前 32 字节补 0——这条头文件与官方文档都没写，是 90% 互操作故障的根源）、结构体字段布局与跨平台对齐陷阱、算法标识常量。密钥/密文「对不上」时先查这里。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '结构体名、字段名或关键词（如 ECCrefPublicKey、SM2、对齐）；省略则返回全部小节标题' },
      },
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(
        v.sections.length === 0
          ? '无匹配小节'
          : v.sections.map(s => `${s.severity ? `【${s.severity}】` : ''}${s.title}`).join('\n'),
      ),
    },
    async execute(args) {
      const data = loadData().struct
      const q = String(args.query ?? '').trim().toLowerCase()
      if (q === '') {
        return {
          sections: (data.sections ?? []).map(s => ({ id: s.id, title: s.title, severity: s.severity })),
          structs: (data.structs ?? []).map(s => s.name),
          algoIdCount: (data.algo_ids ?? []).length,
        }
      }
      const sections = (data.sections ?? []).filter(s =>
        (s.title ?? '').toLowerCase().includes(q)
        || (s.body_summary ?? '').toLowerCase().includes(q)
        || (s.code_blocks ?? []).some(b => String(b).toLowerCase().includes(q)))
      const structs = (data.structs ?? []).filter(s => (s.name ?? '').toLowerCase().includes(q))
      const algoIds = (data.algo_ids ?? []).filter(a =>
        (a.name ?? '').toLowerCase().includes(q) || (a.algo ?? '').toLowerCase().includes(q))
      return { sections, structs, algoIds }
    },
  })

  register({
    name: 'hsm_kb_defect',
    description: '实测缺陷清单（KB6）：这些缺陷不来自任何厂商文档，而是对随库二进制与头文件逐条实测得出的——空桩函数、sdf.h 缺 include 编译不过、Java 错误码文档冲突、JNI 符号被 C++ 名字修饰、openApi 示例用中文全角引号等。**每条返回都带复现命令**，引用时必须原样转述给开发者，让他自己验证而不是相信断言。遇到「按文档写却跑不通」的现象先查这里。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '现象关键词或函数名（如 空桩、编译、UnsatisfiedLinkError、PQC_Sign）；省略返回全部' },
      },
      additionalProperties: false,
    },
    output: {
      schema: jsonSchema,
      render: (_a, v) => asText(
        v.matches.length === 0
          ? '无匹配缺陷'
          : v.matches.map(d => `${d.severity ? `【${d.severity}】` : ''}${d.id} ${d.title}`).join('\n')
            + '\n\n（每条均附复现命令，转述给开发者时必须一并给出）',
      ),
    },
    async execute(args) {
      const data = loadData().defects
      const result = findDefects(args.query, data)
      // 硬规则：引用缺陷必须带复现命令；缺了就报错而不是静默给出断言
      assertRepro(result.matches)
      return result
    },
  })
}
