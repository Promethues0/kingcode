/**
 * 批量校验：不抛错，把每条不合法账目的序号和原因收集起来。
 */

import { normalizeEntry } from './entry.js'

/**
 * @param {unknown[]} raws
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateBatch(raws) {
  const problems = []
  raws.forEach((raw, i) => {
    try {
      normalizeEntry(raw)
    } catch (err) {
      problems.push(`normalizeEntry rejected #${i}: ${err.message}`)
    }
  })
  return { ok: problems.length === 0, problems }
}
