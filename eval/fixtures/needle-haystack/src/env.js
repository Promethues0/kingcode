/**
 * Environment overrides. A variable named HOOKRELAY_<SECTION>_<KEY> patches
 * baseline[section][key]; keys are matched case-insensitively against the
 * baseline so HOOKRELAY_RETRY_BASEMS and HOOKRELAY_RETRY_BASE_MS both land on
 * retry.baseMs. Values are coerced to the type of the built-in value.
 */

import { baseline } from './internal/baseline.js'

export const PREFIX = 'HOOKRELAY_'

function normalise(key) {
  return key.toLowerCase().replace(/_/g, '')
}

function coerce(raw, like) {
  if (typeof like === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new TypeError(`expected a number, got "${raw}"`)
    return n
  }
  if (typeof like === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new TypeError(`expected true/false, got "${raw}"`)
  }
  return raw
}

/**
 * Translate a process.env-like map into a partial settings object.
 * Unknown sections/keys are reported through `onUnknown` (default: ignored)
 * rather than thrown, so an unrelated HOOKRELAY_DEBUG doesn't crash startup.
 */
export function fromEnv(env = process.env, onUnknown = () => {}) {
  const patch = {}
  for (const name of Object.keys(env)) {
    if (!name.startsWith(PREFIX)) continue
    const rest = name.slice(PREFIX.length)
    const underscore = rest.indexOf('_')
    if (underscore <= 0) { onUnknown(name); continue }
    const section = rest.slice(0, underscore).toLowerCase()
    const tail = normalise(rest.slice(underscore + 1))
    const known = baseline[section]
    if (known === undefined) { onUnknown(name); continue }
    const key = Object.keys(known).find(k => normalise(k) === tail)
    if (key === undefined) { onUnknown(name); continue }
    patch[section] ??= {}
    patch[section][key] = coerce(env[name], known[key])
  }
  return patch
}

/** Variable name that would override a given section/key (for error messages). */
export function variableFor(section, key) {
  return `${PREFIX}${section.toUpperCase()}_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`
}
