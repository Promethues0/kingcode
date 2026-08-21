/**
 * Bounded multi-lane FIFO. Lane 0 is served first, then 1, and so on; within
 * a lane, insertion order. `depth` bounds the total across lanes so one noisy
 * endpoint cannot starve the process of memory.
 */

import { ConfigError, QueueFullError } from './errors.js'
import { tuning } from './settings.js'

let nextId = 1

export class Queue {
  #lanes

  /**
   * @param {string} name   owner (used in errors/metrics)
   * @param {object} [opts]
   * @param {number} [opts.depth]
   * @param {number} [opts.lanes]
   */
  constructor(name, { depth, lanes } = {}) {
    const cfg = tuning('queue')
    this.name = name
    this.depth = depth ?? cfg.depth
    this.laneCount = lanes ?? cfg.lanes
    if (!Number.isInteger(this.depth) || this.depth < 1) throw new ConfigError('queue depth must be a positive integer')
    if (!Number.isInteger(this.laneCount) || this.laneCount < 1) throw new ConfigError('queue lanes must be a positive integer')
    this.#lanes = Array.from({ length: this.laneCount }, () => [])
  }

  get size() {
    return this.#lanes.reduce((n, lane) => n + lane.length, 0)
  }

  get empty() {
    return this.size === 0
  }

  /** Enqueue a payload; returns the job record. Throws QueueFullError at capacity. */
  push(payload, { lane = this.laneCount - 1, at = Date.now() } = {}) {
    if (!Number.isInteger(lane) || lane < 0 || lane >= this.laneCount) {
      throw new ConfigError(`lane must be 0..${this.laneCount - 1}, got ${lane}`)
    }
    if (this.size >= this.depth) throw new QueueFullError(this.name, this.depth)
    const job = { id: `${this.name}-${nextId++}`, endpoint: this.name, payload, lane, enqueuedAt: at, tries: 0 }
    this.#lanes[lane].push(job)
    return job
  }

  /** Dequeue the next job (lowest lane first) or undefined. */
  shift() {
    for (const lane of this.#lanes) {
      if (lane.length > 0) return lane.shift()
    }
    return undefined
  }

  peek() {
    for (const lane of this.#lanes) {
      if (lane.length > 0) return lane[0]
    }
    return undefined
  }

  /** Remove and return every job matching `predicate`. */
  purge(predicate = () => true) {
    const removed = []
    for (let i = 0; i < this.#lanes.length; i++) {
      const keep = []
      for (const job of this.#lanes[i]) (predicate(job) ? removed : keep).push(job)
      this.#lanes[i] = keep
    }
    return removed
  }

  inspect() {
    return { depth: this.depth, size: this.size, lanes: this.#lanes.map(l => l.length) }
  }
}
