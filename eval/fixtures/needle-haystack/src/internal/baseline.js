/**
 * Built-in numbers for every subsystem. settings.js layers environment
 * variables and configure() patches on top of this; nothing outside
 * settings.js should import it directly.
 *
 * Units: *Ms fields are milliseconds. Fields without a suffix are documented
 * where they are consumed.
 */

export const baseline = Object.freeze({
  queue: Object.freeze({
    depth: 512,
    lanes: 3,
  }),
  worker: Object.freeze({
    idleMs: 1500,
    drainMs: 250,
    batch: 16,
  }),
  throttle: Object.freeze({
    span: 7243,
    burst: 9,
  }),
  retry: Object.freeze({
    attempts: 4,
    baseMs: 410,
    capMs: 20000,
    factor: 2,
  }),
  transport: Object.freeze({
    timeoutMs: 8000,
    keepAlive: true,
    userAgent: 'hookrelay/0.4',
  }),
  signature: Object.freeze({
    algorithm: 'sha256',
    header: 'x-hookrelay-signature',
    toleranceMs: 300000,
  }),
  log: Object.freeze({
    level: 'warn',
  }),
})

/** Section names, in the order the CLI prints them. */
export const sections = Object.freeze(Object.keys(baseline))
