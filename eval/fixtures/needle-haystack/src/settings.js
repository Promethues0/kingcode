/**
 * Effective settings = baseline <- environment <- configure() patches.
 *
 * The resolved tree is rebuilt on every read. It is a handful of tiny objects,
 * and recomputing is what makes tests that poke process.env or call reset()
 * behave without a cache-invalidation dance.
 */

import { baseline } from './internal/baseline.js'
import { merge, pick } from './internal/merge.js'
import { fromEnv } from './env.js'
import { ConfigError } from './errors.js'

let patches = {}
let unknownEnv = []

/** Apply a partial settings object (shape of config/staging.example.json). */
export function configure(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ConfigError('configure() expects a plain object')
  }
  for (const section of Object.keys(patch)) {
    if (section.startsWith('$')) continue
    if (!(section in baseline)) throw new ConfigError(`unknown settings section "${section}"`)
    for (const key of Object.keys(patch[section] ?? {})) {
      if (!(key in baseline[section])) throw new ConfigError(`unknown key "${section}.${key}"`)
    }
  }
  const clean = {}
  for (const section of Object.keys(patch)) if (!section.startsWith('$')) clean[section] = patch[section]
  patches = merge(patches, clean)
  return snapshot()
}

/** Drop every configure() patch. Environment overrides still apply. */
export function reset() {
  patches = {}
}

/** Full resolved tree (fresh copy). */
export function snapshot() {
  unknownEnv = []
  const env = fromEnv(process.env, name => unknownEnv.push(name))
  return merge(merge(baseline, env), patches)
}

/** One section of the resolved tree. */
export function tuning(section) {
  const all = snapshot()
  if (!(section in all)) throw new ConfigError(`unknown settings section "${section}"`)
  return all[section]
}

/** Single value by dotted path, e.g. tuningAt('retry.attempts'). */
export function tuningAt(path) {
  const value = pick(snapshot(), path)
  if (value === undefined) throw new ConfigError(`unknown setting "${path}"`)
  return value
}

/** HOOKRELAY_* variables that matched nothing on the last snapshot(). */
export function ignoredEnvironment() {
  return unknownEnv.slice()
}
