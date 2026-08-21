/**
 * Payload signing. Header value is `t=<unix ms>,v1=<hex hmac>` where the
 * HMAC covers `${t}.${body}`; receivers recompute and compare in constant
 * time, rejecting stamps older than the tolerance.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConfigError } from './errors.js'
import { tuning } from './settings.js'

function digest(secret, algorithm, timestamp, body) {
  return createHmac(algorithm, secret).update(`${timestamp}.${body}`).digest('hex')
}

/**
 * @param {string} secret
 * @param {string} body       exact bytes that go on the wire
 * @param {number} [timestamp] ms since epoch; defaults to now
 * @returns {{ header: string, value: string, timestamp: number }}
 */
export function sign(secret, body, timestamp = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0) throw new ConfigError('signing secret must be a non-empty string')
  const cfg = tuning('signature')
  return {
    header: cfg.header,
    value: `t=${timestamp},v1=${digest(secret, cfg.algorithm, timestamp, body)}`,
    timestamp,
  }
}

/** Parse a header value into its parts; null if malformed. */
export function parse(value) {
  if (typeof value !== 'string') return null
  const parts = Object.fromEntries(value.split(',').map(pair => {
    const eq = pair.indexOf('=')
    return eq === -1 ? [pair, ''] : [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]
  }))
  const timestamp = Number(parts.t)
  if (!Number.isInteger(timestamp) || typeof parts.v1 !== 'string' || !/^[0-9a-f]+$/.test(parts.v1)) return null
  return { timestamp, v1: parts.v1 }
}

/**
 * @returns {{ ok: boolean, reason?: 'malformed'|'stale'|'mismatch' }}
 */
export function verify(secret, body, headerValue, { now = Date.now(), toleranceMs } = {}) {
  const cfg = tuning('signature')
  const parsed = parse(headerValue)
  if (parsed === null) return { ok: false, reason: 'malformed' }
  const tolerance = toleranceMs ?? cfg.toleranceMs
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'stale' }
  const expected = Buffer.from(digest(secret, cfg.algorithm, parsed.timestamp, body), 'hex')
  const given = Buffer.from(parsed.v1, 'hex')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
