/**
 * Endpoint registry: where to send, how to sign, optional per-endpoint pacing
 * and static headers. Names are normalised so "Billing" and "billing" are the
 * same target.
 */

import { EndpointError } from './errors.js'
import { Throttle } from './throttle.js'

export function normaliseName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new EndpointError('endpoint name must be a non-empty string')
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

function checkUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { throw new EndpointError(`invalid endpoint url "${url}"`) }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EndpointError(`endpoint url must be http(s), got ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) throw new EndpointError('credentials in endpoint url are not allowed')
  return parsed.toString()
}

export class Endpoint {
  /**
   * @param {string} name
   * @param {object} spec
   * @param {string} spec.url
   * @param {string} spec.secret
   * @param {object} [spec.headers]
   * @param {{ windowMs?: number, burst?: number }} [spec.throttle]  per-endpoint pacer
   * @param {object} [spec.retry]   per-endpoint retry overrides
   * @param {object} [clock]
   */
  constructor(name, spec, clock) {
    if (spec === null || typeof spec !== 'object') throw new EndpointError('endpoint spec must be an object')
    this.name = normaliseName(name)
    this.url = checkUrl(spec.url)
    if (typeof spec.secret !== 'string' || spec.secret.length < 8) {
      throw new EndpointError(`endpoint "${this.name}" needs a secret of at least 8 characters`)
    }
    this.secret = spec.secret
    this.headers = Object.freeze({ ...(spec.headers ?? {}) })
    this.retry = spec.retry ?? null
    this.pacer = spec.throttle ? new Throttle({ ...spec.throttle, clock }) : null
    this.registeredAt = clock ? clock.now() : Date.now()
  }

  inspect() {
    return {
      name: this.name,
      url: this.url,
      headers: { ...this.headers },
      pacer: this.pacer ? this.pacer.inspect() : null,
      retry: this.retry,
    }
  }
}

export class Registry {
  #byName = new Map()

  add(name, spec, clock) {
    const endpoint = new Endpoint(name, spec, clock)
    if (this.#byName.has(endpoint.name)) throw new EndpointError(`endpoint "${endpoint.name}" already registered`)
    this.#byName.set(endpoint.name, endpoint)
    return endpoint
  }

  get(name) {
    const endpoint = this.#byName.get(normaliseName(name))
    if (endpoint === undefined) throw new EndpointError(`unknown endpoint "${name}"`)
    return endpoint
  }

  has(name) {
    return this.#byName.has(normaliseName(name))
  }

  remove(name) {
    return this.#byName.delete(normaliseName(name))
  }

  names() {
    return [...this.#byName.keys()].sort()
  }

  get size() {
    return this.#byName.size
  }
}
