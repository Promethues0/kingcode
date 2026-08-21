/**
 * The thing users hold: registers endpoints, accepts events, owns the shared
 * pacer/transport/stats, and fans work out to one worker per endpoint.
 */

import { systemClock } from './clock.js'
import { Registry } from './endpoint.js'
import { ConfigError } from './errors.js'
import { Emitter } from './events.js'
import { logger } from './log.js'
import { Queue } from './queue.js'
import { Stats } from './stats.js'
import { Throttle } from './throttle.js'
import { httpTransport } from './transport.js'
import { Worker } from './worker.js'

export class Dispatcher extends Emitter {
  #registry = new Registry()
  #queues = new Map()
  #workers = new Map()
  #closed = false

  /**
   * @param {object} [options]
   * @param {object} [options.clock]       injectable clock (tests)
   * @param {object} [options.transport]   a transport object, or options for httpTransport()
   * @param {{ windowMs?: number, burst?: number }} [options.throttle]  shared pacer
   * @param {object} [options.retry]       retry policy overrides for every endpoint
   * @param {{ depth?: number, lanes?: number }} [options.queue]
   */
  constructor(options = {}) {
    super()
    if (options === null || typeof options !== 'object') throw new ConfigError('dispatcher options must be an object')
    this.clock = options.clock ?? systemClock()
    this.transport = typeof options.transport?.send === 'function'
      ? options.transport
      : httpTransport(options.transport ?? {})
    this.pacer = new Throttle({ ...(options.throttle ?? {}), clock: this.clock })
    this.retryOptions = options.retry ?? null
    this.queueOptions = options.queue ?? {}
    this.stats = new Stats()
    this.log = logger('dispatcher')
    this.on('error', (error) => this.log.error('listener threw', { error: String(error) }))
  }

  #assertOpen() {
    if (this.#closed) throw new ConfigError('dispatcher is closed')
  }

  /** Register a delivery target. Returns the Endpoint. */
  register(name, spec) {
    this.#assertOpen()
    const endpoint = this.#registry.add(name, spec, this.clock)
    const queue = new Queue(endpoint.name, this.queueOptions)
    this.#queues.set(endpoint.name, queue)
    this.#workers.set(endpoint.name, new Worker({
      endpoint,
      queue,
      pacer: this.pacer,
      transport: this.transport,
      stats: this.stats,
      events: this,
      clock: this.clock,
      retry: { ...(this.retryOptions ?? {}), ...(endpoint.retry ?? {}) },
    }))
    this.log.info('registered', { endpoint: endpoint.name })
    return endpoint
  }

  /** Remove an endpoint; pending jobs are dropped and returned. */
  async unregister(name) {
    const endpoint = this.#registry.get(name)
    await this.#workers.get(endpoint.name)?.stop()
    const dropped = this.#queues.get(endpoint.name)?.purge() ?? []
    this.#queues.delete(endpoint.name)
    this.#workers.delete(endpoint.name)
    this.#registry.remove(endpoint.name)
    return dropped
  }

  /** Enqueue a payload for an endpoint. Resolves to the job record. */
  push(name, payload, { lane } = {}) {
    this.#assertOpen()
    const endpoint = this.#registry.get(name)
    const job = this.#queues.get(endpoint.name).push(payload, { lane, at: this.clock.now() })
    this.stats.bump(endpoint.name, 'queued')
    this.emit('queued', { job })
    return job
  }

  /** Deliver everything currently queued, across all endpoints. */
  async drain(name) {
    const targets = name === undefined ? [...this.#workers.values()] : [this.#workers.get(this.#registry.get(name).name)]
    const counts = await Promise.all(targets.map(worker => worker.drain()))
    return counts.reduce((a, b) => a + b, 0)
  }

  /** Start background workers for every endpoint. */
  start() {
    this.#assertOpen()
    for (const worker of this.#workers.values()) worker.start()
  }

  /** Stop workers and refuse further pushes. */
  async close() {
    this.#closed = true
    await Promise.all([...this.#workers.values()].map(worker => worker.stop()))
  }

  endpoints() {
    return this.#registry.names()
  }

  pending(name) {
    if (name !== undefined) return this.#queues.get(this.#registry.get(name).name).size
    let total = 0
    for (const queue of this.#queues.values()) total += queue.size
    return total
  }

  /** Diagnostic view: shared pacer, transport, per-endpoint state, counters. */
  inspect() {
    const endpoints = {}
    for (const name of this.#registry.names()) {
      endpoints[name] = {
        ...this.#registry.get(name).inspect(),
        queue: this.#queues.get(name).inspect(),
        retry: this.#workers.get(name).retry.inspect(),
        running: this.#workers.get(name).running,
      }
    }
    return {
      closed: this.#closed,
      pacer: this.pacer.inspect(),
      transport: { kind: this.transport.kind ?? 'custom', timeoutMs: this.transport.timeoutMs ?? null },
      endpoints,
      stats: this.stats.snapshot(),
    }
  }
}
