/**
 * 内存账本：入账时逐条规整，余额按账户累加（单位：分）。
 */

import { normalizeEntry } from './entry.js'

export class Ledger {
  #entries = []

  /** 入一条账，返回 this 以便链式调用 */
  add(raw) {
    this.#entries.push(normalizeEntry(raw))
    return this
  }

  /** 批量入账；任一条不合法则整批不入 */
  addMany(raws) {
    const prepared = raws.map(normalizeEntry)
    this.#entries.push(...prepared)
    return this
  }

  get size() {
    return this.#entries.length
  }

  /** 某账户余额（分）；未知账户为 0 */
  balance(account) {
    return this.#entries
      .filter(e => e.account === account)
      .reduce((sum, e) => sum + e.cents, 0)
  }

  entries() {
    return this.#entries.slice()
  }
}
