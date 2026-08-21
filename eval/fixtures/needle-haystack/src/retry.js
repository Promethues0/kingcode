/**
 * Retry loop around a single delivery. Which errors are worth retrying is
 * decided here (5xx, 429, network-ish failures); the delays come from
 * backoff.js and the budget from settings.
 */

import { jitter, retryAfterMs, schedule } from './backoff.js'
import { systemClock } from './clock.js'
import { DeliveryError, GaveUpError, RelayError } from './errors.js'
import { tuning } from './settings.js'

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ABORT_ERR'])

/** Should this failure be tried again? */
export function retryable(error) {
  if (error instanceof DeliveryError) {
    if (error.status === 429) return true
    if (typeof error.status === 'number') return error.status >= 500 && error.status < 600
    return true // no status at all: transport blew up before a response
  }
  if (error instanceof RelayError) return false
  if (error && NETWORK_CODES.has(error.code)) return true
  return error?.name === 'AbortError'
}

export class Retry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.attempts] total tries including the first
   * @param {number} [opts.baseMs]
   * @param {number} [opts.capMs]
   * @param {number} [opts.factor]
   * @param {object} [opts.clock]
   * @param {() => number} [opts.rng]
   */
  constructor({ attempts, baseMs, capMs, factor, clock, rng } = {}) {
    const cfg = tuning('retry')
    this.policy = {
      attempts: attempts ?? cfg.attempts,
      baseMs: baseMs ?? cfg.baseMs,
      capMs: capMs ?? cfg.capMs,
      factor: factor ?? cfg.factor,
    }
    this.delays = schedule(this.policy)
    this.clock = clock ?? systemClock()
    this.rng = rng ?? Math.random
  }

  /**
   * Run `fn(attemptNumber)` until it resolves or the budget is spent.
   * `onRetry({ attempt, error, delayMs })` fires before each sleep.
   */
  async run(fn, { onRetry = () => {}, jobId = '?' } = {}) {
    let last
    for (let attempt = 1; attempt <= this.policy.attempts; attempt++) {
      try {
        return await fn(attempt)
      } catch (error) {
        last = error
        if (!retryable(error) || attempt === this.policy.attempts) break
        const hinted = retryAfterMs(error.retryAfter, this.clock.now())
        const delayMs = hinted ?? jitter(this.delays[attempt - 1], this.rng)
        onRetry({ attempt, error, delayMs })
        await this.clock.sleep(delayMs)
      }
    }
    throw new GaveUpError(jobId, this.policy.attempts, last)
  }

  inspect() {
    return { ...this.policy, delays: this.delays.slice() }
  }
}
