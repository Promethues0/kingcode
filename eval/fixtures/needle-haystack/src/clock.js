/**
 * Injectable clock. Production uses the real one; tests drive a manual clock
 * so nothing in the suite ever sleeps.
 */

export function systemClock() {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))),
  }
}

export function manualClock(start = 0) {
  let current = start
  const waiters = []

  const flush = () => {
    waiters.sort((a, b) => a.at - b.at)
    while (waiters.length > 0 && waiters[0].at <= current) {
      waiters.shift().resolve()
    }
  }

  return {
    now: () => current,
    sleep(ms) {
      if (ms <= 0) return Promise.resolve()
      return new Promise(resolve => { waiters.push({ at: current + ms, resolve }) })
    },
    advance(ms) {
      current += ms
      flush()
      return current
    },
    set(at) {
      current = at
      flush()
      return current
    },
    pending: () => waiters.length,
  }
}

/** Format a millisecond duration for logs: 1500 becomes "1.5s", 250 becomes "250ms". */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}
