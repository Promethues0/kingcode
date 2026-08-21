/**
 * Delay schedules for retries. Pure functions: the retry loop decides when to
 * sleep, this module only says for how long.
 */

/**
 * Exponential schedule without jitter: base, base*factor, ... capped at `capMs`.
 * Returns one delay per retry, i.e. `attempts - 1` entries (no delay before
 * the first try).
 */
export function schedule({ attempts, baseMs, capMs, factor }) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be >= 1')
  const out = []
  let delay = baseMs
  for (let i = 1; i < attempts; i++) {
    out.push(Math.min(capMs, Math.round(delay)))
    delay *= factor
  }
  return out
}

/** Full jitter: uniform in [0, delay]. `rng` defaults to Math.random. */
export function jitter(delay, rng = Math.random) {
  return Math.round(rng() * delay)
}

/** Equal jitter: half fixed, half random. Gentler on tight caps. */
export function equalJitter(delay, rng = Math.random) {
  const half = delay / 2
  return Math.round(half + rng() * half)
}

/**
 * Honour a Retry-After header when present: integer seconds or an HTTP date.
 * Returns ms, or null when the header is absent/unparseable.
 */
export function retryAfterMs(header, now = Date.now()) {
  if (header === undefined || header === null || header === '') return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(String(header))
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/** Sum of a schedule: worst-case time spent waiting, ignoring the calls themselves. */
export function totalWait(delays) {
  return delays.reduce((sum, d) => sum + d, 0)
}
