/**
 * Leveled logger writing to stderr. Level comes from settings (log.level);
 * the sink is swappable so tests can capture output.
 */

import { tuning } from './settings.js'

const LEVELS = ['debug', 'info', 'warn', 'error', 'silent']

let sink = (line) => process.stderr.write(line + '\n')

export function setSink(fn) {
  const previous = sink
  sink = fn
  return previous
}

function enabled(level) {
  const configured = tuning('log').level
  return LEVELS.indexOf(level) >= LEVELS.indexOf(configured)
}

function stamp(level, scope, message, fields) {
  const extra = fields && Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : ''
  return `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}${extra}`
}

export function logger(scope) {
  const write = (level) => (message, fields) => {
    if (!enabled(level)) return
    sink(stamp(level, scope, message, fields))
  }
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (sub) => logger(`${scope}:${sub}`),
  }
}

export { LEVELS }
