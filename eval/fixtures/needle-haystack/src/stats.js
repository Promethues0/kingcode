/**
 * Counters and simple timing histograms, keyed by endpoint. Cheap enough to
 * always be on; snapshot() is what the CLI's `stats` command prints.
 */

export class Stats {
  #counters = new Map()
  #timings = new Map()

  bump(endpoint, name, by = 1) {
    const key = `${endpoint} ${name}`
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by)
  }

  time(endpoint, ms) {
    if (!this.#timings.has(endpoint)) this.#timings.set(endpoint, [])
    const list = this.#timings.get(endpoint)
    list.push(ms)
    if (list.length > 1024) list.shift()
  }

  count(endpoint, name) {
    return this.#counters.get(`${endpoint} ${name}`) ?? 0
  }

  percentile(endpoint, p) {
    const list = (this.#timings.get(endpoint) ?? []).slice().sort((a, b) => a - b)
    if (list.length === 0) return null
    const index = Math.min(list.length - 1, Math.floor((p / 100) * list.length))
    return list[index]
  }

  snapshot() {
    const out = {}
    for (const [key, value] of this.#counters) {
      const [endpoint, name] = key.split(' ')
      out[endpoint] ??= { counters: {}, p50: null, p95: null }
      out[endpoint].counters[name] = value
    }
    for (const endpoint of this.#timings.keys()) {
      out[endpoint] ??= { counters: {}, p50: null, p95: null }
      out[endpoint].p50 = this.percentile(endpoint, 50)
      out[endpoint].p95 = this.percentile(endpoint, 95)
    }
    return out
  }

  reset() {
    this.#counters.clear()
    this.#timings.clear()
  }
}
