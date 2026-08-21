/**
 * Transports put bytes on the wire. Two are shipped: an HTTP one built on the
 * global fetch, and an in-memory one for tests and dry runs. Both expose
 * `send({ url, headers, body })` resolving to `{ status, headers, body }` and
 * rejecting with DeliveryError on a non-2xx response.
 */

import { DeliveryError } from './errors.js'
import { tuning } from './settings.js'

function toDeliveryError(response, bodyText) {
  return new DeliveryError(`endpoint answered ${response.status}`, {
    status: response.status,
    retryAfter: response.headers?.get?.('retry-after') ?? response.headers?.['retry-after'] ?? undefined,
    body: bodyText,
  })
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetch]     fetch implementation (defaults to global)
 * @param {number}   [opts.timeoutMs]
 * @param {string}   [opts.userAgent]
 */
export function httpTransport({ fetch: fetchImpl, timeoutMs, userAgent } = {}) {
  const cfg = tuning('transport')
  const doFetch = fetchImpl ?? globalThis.fetch
  const timeout = timeoutMs ?? cfg.timeoutMs
  const agent = userAgent ?? cfg.userAgent
  if (typeof doFetch !== 'function') throw new DeliveryError('no fetch implementation available')

  return {
    kind: 'http',
    timeoutMs: timeout,
    async send({ url, headers = {}, body }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': agent, ...headers },
          body,
          signal: controller.signal,
          keepalive: cfg.keepAlive,
        })
        const text = await response.text()
        if (response.status < 200 || response.status >= 300) throw toDeliveryError(response, text)
        return { status: response.status, headers: Object.fromEntries(response.headers ?? []), body: text }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * In-memory transport. `respond` decides each outcome:
 *   - a number: that HTTP status
 *   - an object: { status, headers?, body? }
 *   - a function (request, index) returning either of the above, or throwing
 * Every request is recorded on `.requests`.
 */
export function memoryTransport(respond = 200) {
  const requests = []
  const resolve = (request) => {
    const plan = typeof respond === 'function' ? respond(request, requests.length - 1) : respond
    return typeof plan === 'number' ? { status: plan } : plan
  }
  return {
    kind: 'memory',
    requests,
    async send(request) {
      requests.push(request)
      const planned = resolve(request)
      const status = planned.status ?? 200
      if (status < 200 || status >= 300) {
        throw toDeliveryError({ status, headers: planned.headers ?? {} }, planned.body ?? '')
      }
      return { status, headers: planned.headers ?? {}, body: planned.body ?? '' }
    },
  }
}
