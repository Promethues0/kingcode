/**
 * Deep merge for plain config objects. Right side wins; arrays and non-plain
 * values are replaced wholesale, never concatenated. Never mutates inputs.
 */

function isPlain(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function merge(left, right) {
  if (!isPlain(left)) return clone(right)
  if (!isPlain(right)) return right === undefined ? clone(left) : clone(right)
  const out = {}
  for (const key of Object.keys(left)) out[key] = clone(left[key])
  for (const key of Object.keys(right)) {
    const incoming = right[key]
    if (incoming === undefined) continue
    out[key] = key in out ? merge(out[key], incoming) : clone(incoming)
  }
  return out
}

export function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (!isPlain(value)) return value
  const out = {}
  for (const key of Object.keys(value)) out[key] = clone(value[key])
  return out
}

/** Read a dotted path ("retry.attempts") off an object; undefined when absent. */
export function pick(object, path) {
  let cursor = object
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Set a dotted path on a fresh copy of the object. */
export function put(object, path, value) {
  const parts = path.split('.')
  const patch = {}
  let cursor = patch
  for (let i = 0; i < parts.length - 1; i++) {
    cursor[parts[i]] = {}
    cursor = cursor[parts[i]]
  }
  cursor[parts[parts.length - 1]] = value
  return merge(object, patch)
}
