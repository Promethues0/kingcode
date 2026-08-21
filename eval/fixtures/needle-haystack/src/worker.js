/**
 * Pulls jobs off one endpoint's queue and delivers them: pace, sign, send,
 * retry, report. One worker per endpoint; all workers share the dispatcher's
 * pacer and transport.
 */

import { formatMs, systemClock } from './clock.js'
import { describe } from './errors.js'
import { logger } from './log.js'
import { Retry } from './retry.js'
import { sign } from './signature.js'
import { acquireAll } from './throttle.js'
import { tuning } from './settings.js'

export class Worker {
  #running = false
  #stopRequested = false
  #loop = null

  /**
   * @param {object} deps
   * @param {import('./endpoint.js').Endpoint} deps.endpoint
   * @param {import('./queue.js').Queue} deps.queue
   * @param {import('./throttle.js').Throttle} deps.pacer   dispatcher-wide pacer
   * @param {{ send: Function }} deps.transport
   * @param {import('./stats.js').Stats} deps.stats
   * @param {import('./events.js').Emitter} deps.events
   * @param {object} [deps.clock]
   * @param {object} [deps.retry]   overrides for the Retry policy
   */
  constructor({ endpoint, queue, pacer, transport, stats, events, clock, retry }) {
    const cfg = tuning('worker')
    this.endpoint = endpoint
    this.queue = queue
    this.pacer = pacer
    this.transport = transport
    this.stats = stats
    this.events = events
    this.clock = clock ?? systemClock()
    this.idleMs = cfg.idleMs
    this.retry = new Retry({ ...(retry ?? {}), clock: this.clock })
    this.log = logger(`worker:${endpoint.name}`)
  }

  get running() {
    return this.#running
  }

  /** Deliver one job, with retries. Resolves to the transport's response. */
  async deliver(job) {
    const body = JSON.stringify(job.payload)
    const started = this.clock.now()
    try {
      const response = await this.retry.run(async (attempt) => {
        job.tries = attempt
        await acquireAll([this.pacer, this.endpoint.pacer])
        const signature = sign(this.endpoint.secret, body, this.clock.now())
        return this.transport.send({
          url: this.endpoint.url,
          headers: { ...this.endpoint.headers, [signature.header]: signature.value },
          body,
        })
      }, {
        jobId: job.id,
        onRetry: ({ attempt, error, delayMs }) => {
          this.stats.bump(job.endpoint, 'retried')
          this.log.debug(`attempt ${attempt} failed, retrying in ${formatMs(delayMs)}`, { job: job.id, error: describe(error) })
          this.events.emit('retry', { job, attempt, error, delayMs })
        },
      })
      this.stats.bump(job.endpoint, 'delivered')
      this.stats.time(job.endpoint, this.clock.now() - started)
      this.events.emit('delivered', { job, response })
      return response
    } catch (error) {
      this.stats.bump(job.endpoint, 'failed')
      this.log.warn(`giving up`, { job: job.id, error: describe(error) })
      this.events.emit('failed', { job, error })
      throw error
    }
  }

  /** Process jobs until the queue is empty. Failures are reported, not thrown. */
  async drain() {
    let handled = 0
    for (;;) {
      const job = this.queue.shift()
      if (job === undefined) return handled
      handled++
      try { await this.deliver(job) } catch { /* reported through events/stats */ }
    }
  }

  /** Background loop: drain, then idle, until stop() is called. */
  start() {
    if (this.#running) return this.#loop
    this.#running = true
    this.#stopRequested = false
    this.#loop = (async () => {
      while (!this.#stopRequested) {
        await this.drain()
        if (this.#stopRequested) break
        await this.clock.sleep(this.idleMs)
      }
      this.#running = false
    })()
    return this.#loop
  }

  async stop() {
    this.#stopRequested = true
    if (this.#loop) await this.#loop
  }
}
