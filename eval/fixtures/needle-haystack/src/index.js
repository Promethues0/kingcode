/**
 * Public surface of hookrelay. Anything not exported here is internal and may
 * change without notice.
 */

import { Dispatcher } from './dispatcher.js'

/**
 * Create a dispatcher.
 *
 * @param {object} [options]
 * @param {object} [options.transport]   transport object or httpTransport() options
 * @param {object} [options.throttle]    shared pacer: { windowMs, burst }
 * @param {object} [options.retry]       retry policy: { attempts, baseMs, capMs, factor }
 * @param {object} [options.queue]       { depth, lanes }
 * @param {object} [options.clock]       injectable clock
 * @returns {Dispatcher}
 */
export function createDispatcher(options) {
  return new Dispatcher(options)
}

export { Dispatcher }
export { configure, reset, snapshot, tuning } from './settings.js'
export { sign, verify, parse as parseSignature } from './signature.js'
export { httpTransport, memoryTransport } from './transport.js'
export { manualClock, systemClock } from './clock.js'
export { schedule as backoffSchedule, retryAfterMs } from './backoff.js'
export {
  RelayError,
  ConfigError,
  EndpointError,
  QueueFullError,
  DeliveryError,
  GaveUpError,
  isRelayError,
} from './errors.js'
