/**
 * Sliding-window pacer. At most `burst` acquisitions succeed inside any
 * window of `span` milliseconds; a caller that arrives when the window is
 * full is told how long until the oldest stamp falls out.
 *
 * One instance is shared by the whole dispatcher; endpoints may additionally
 * carry their own (see endpoint.js), in which case the worker takes both.
 */

import { systemClock } from './clock.js'
import { ConfigError } from './errors.js'
import { tuning } from './settings.js'

export class Throttle {
  #stamps = []

  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs] length of the sliding window in ms
   * @param {number} [opts.burst]    acquisitions allowed per window
   * @param {object} [opts.clock]    clock with now()/sleep()
   */
  constructor({ windowMs, burst, clock } = {}) {
    const cfg = tuning('throttle')
    this.span = Number(windowMs ?? cfg.span)
    this.burst = Number(burst ?? cfg.burst)
    this.clock = clock ?? systemClock()
    if (!Number.isFinite(this.span) || this.span <= 0) {
      throw new ConfigError(`throttle window must be a positive number of ms, got ${windowMs}`)
    }
    if (!Number.isInteger(this.burst) || this.burst < 1) {
      throw new ConfigError(`throttle burst must be a positive integer, got ${burst}`)
    }
  }

  #prune(now) {
    while (this.#stamps.length > 0 && now - this.#stamps[0] >= this.span) this.#stamps.shift()
  }

  /** Take a slot if one is free. Returns 0 when granted, else ms until one frees up. */
  tryAcquire() {
    const now = this.clock.now()
    this.#prune(now)
    if (this.#stamps.length < this.burst) {
      this.#stamps.push(now)
      return 0
    }
    return this.span - (now - this.#stamps[0])
  }

  /** Wait (on the injected clock) until a slot is granted. */
  async acquire() {
    for (;;) {
      const wait = this.tryAcquire()
      if (wait === 0) return
      await this.clock.sleep(wait)
    }
  }

  /** Forget every stamp; the next `burst` callers go straight through. */
  clear() {
    this.#stamps.length = 0
  }

  inspect() {
    const now = this.clock.now()
    this.#prune(now)
    return {
      windowMs: this.span,
      burst: this.burst,
      used: this.#stamps.length,
      free: this.burst - this.#stamps.length,
    }
  }
}

/** Combine several pacers: acquire each in order, so the strictest wins. */
export async function acquireAll(pacers) {
  for (const pacer of pacers) {
    if (pacer) await pacer.acquire()
  }
}
