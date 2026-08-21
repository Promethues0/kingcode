/**
 * Error hierarchy. Every error thrown by hookrelay is a RelayError so callers
 * can catch one type; `code` is stable across versions, `message` is not.
 */

export class RelayError extends Error {
  constructor(message, code = 'E_RELAY', extra = {}) {
    super(message)
    this.name = new.target.name
    this.code = code
    Object.assign(this, extra)
  }
}

export class ConfigError extends RelayError {
  constructor(message, extra) { super(message, 'E_CONFIG', extra) }
}

export class EndpointError extends RelayError {
  constructor(message, extra) { super(message, 'E_ENDPOINT', extra) }
}

export class QueueFullError extends RelayError {
  constructor(endpoint, depth) {
    super(`queue for "${endpoint}" is full (${depth})`, 'E_QUEUE_FULL', { endpoint, depth })
  }
}

export class DeliveryError extends RelayError {
  constructor(message, extra) { super(message, 'E_DELIVERY', extra) }
}

export class GaveUpError extends RelayError {
  constructor(jobId, attempts, last) {
    super(`gave up on job ${jobId} after ${attempts} attempt(s)`, 'E_GAVE_UP', { jobId, attempts, last })
  }
}

/** True when an error is one of ours with the given code. */
export function isRelayError(error, code) {
  return error instanceof RelayError && (code === undefined || error.code === code)
}

/** Classify an arbitrary thrown value for logging. */
export function describe(error) {
  if (error instanceof RelayError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
