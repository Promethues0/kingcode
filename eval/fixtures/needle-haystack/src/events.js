/**
 * Minimal synchronous emitter. Listeners run in registration order; a throwing
 * listener does not stop the others, the error is re-emitted as 'error' and
 * swallowed if nobody listens for that.
 */

export class Emitter {
  #listeners = new Map()

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function')
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set())
    this.#listeners.get(event).add(fn)
    return () => this.off(event, fn)
  }

  once(event, fn) {
    const off = this.on(event, (...args) => { off(); fn(...args) })
    return off
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn)
  }

  emit(event, ...args) {
    const set = this.#listeners.get(event)
    if (!set || set.size === 0) return false
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (error) {
        if (event !== 'error') this.emit('error', error)
      }
    }
    return true
  }

  listenerCount(event) {
    return this.#listeners.get(event)?.size ?? 0
  }

  /** Promise for the next occurrence of an event (optionally with a predicate). */
  next(event, match = () => true) {
    return new Promise(resolve => {
      const off = this.on(event, (...args) => {
        if (!match(...args)) return
        off()
        resolve(args.length === 1 ? args[0] : args)
      })
    })
  }
}
