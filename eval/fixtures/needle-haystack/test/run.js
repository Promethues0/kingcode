/**
 * Test-suite: plain node, no framework. Every case pins behaviour against
 * values passed explicitly, so the suite keeps passing when built-in numbers
 * are re-tuned.
 */

import {
  ConfigError,
  QueueFullError,
  GaveUpError,
  backoffSchedule,
  configure,
  createDispatcher,
  manualClock,
  memoryTransport,
  parseSignature,
  reset,
  retryAfterMs,
  sign,
  tuning,
  verify,
} from '../src/index.js'
import { fromEnv } from '../src/env.js'
import { merge, pick, put } from '../src/internal/merge.js'
import { Queue } from '../src/queue.js'
import { Retry, retryable } from '../src/retry.js'
import { Throttle } from '../src/throttle.js'
import { DeliveryError } from '../src/errors.js'
import { setSink } from '../src/log.js'

let failures = 0
let total = 0

function check(name, ok, extra = '') {
  total++
  if (ok) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.log(`FAIL ${name}${extra ? ' -- ' + extra : ''}`)
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `expected ${e}, got ${a}`)
}

async function throws(name, fn, type) {
  try {
    await fn()
    check(name, false, 'did not throw')
  } catch (error) {
    check(name, type === undefined || error instanceof type, `threw ${error?.constructor?.name}: ${error?.message}`)
  }
}

setSink(() => {}) // keep the suite quiet
for (const name of Object.keys(process.env)) if (name.startsWith('HOOKRELAY_')) delete process.env[name]

// merge ----------------------------------------------------------------------
{
  const left = { a: { b: 1, c: [1, 2] }, d: 'x' }
  const out = merge(left, { a: { b: 2, c: [3] }, e: true })
  eq('merge: right wins, arrays replaced', out, { a: { b: 2, c: [3] }, d: 'x', e: true })
  eq('merge: left untouched', left, { a: { b: 1, c: [1, 2] }, d: 'x' })
  eq('merge: undefined on right is ignored', merge({ a: 1 }, { a: undefined }), { a: 1 })
  eq('pick: dotted path', pick(out, 'a.c'), [3])
  eq('pick: missing path', pick(out, 'a.zz.q'), undefined)
  eq('put: dotted path', put({ a: { b: 1 } }, 'a.c', 5), { a: { b: 1, c: 5 } })
}

// env ------------------------------------------------------------------------
{
  const unknown = []
  const patch = fromEnv({
    HOOKRELAY_RETRY_ATTEMPTS: '7',
    HOOKRELAY_RETRY_BASE_MS: '25',
    HOOKRELAY_TRANSPORT_KEEP_ALIVE: 'false',
    HOOKRELAY_NOPE_X: '1',
    HOOKRELAY_DEBUG: '1',
    PATH: '/usr/bin',
  }, name => unknown.push(name))
  eq('env: numbers coerced and keys matched loosely', patch.retry, { attempts: 7, baseMs: 25 })
  eq('env: booleans coerced', patch.transport, { keepAlive: false })
  eq('env: unknown names reported, unrelated vars ignored', unknown, ['HOOKRELAY_NOPE_X', 'HOOKRELAY_DEBUG'])
  await throws('env: bad number throws', () => fromEnv({ HOOKRELAY_RETRY_ATTEMPTS: 'many' }), TypeError)
}

// settings -------------------------------------------------------------------
{
  reset()
  const before = tuning('retry').attempts
  configure({ $comment: 'ignored', retry: { attempts: before + 1 } })
  eq('settings: configure patches one key', tuning('retry').attempts, before + 1)
  reset()
  eq('settings: reset restores', tuning('retry').attempts, before)
  await throws('settings: unknown section rejected', () => configure({ nope: {} }), ConfigError)
  await throws('settings: unknown key rejected', () => configure({ retry: { nope: 1 } }), ConfigError)
  process.env.HOOKRELAY_QUEUE_DEPTH = '3'
  eq('settings: env overrides baseline', tuning('queue').depth, 3)
  configure({ queue: { depth: 4 } })
  eq('settings: configure overrides env', tuning('queue').depth, 4)
  delete process.env.HOOKRELAY_QUEUE_DEPTH
  reset()
}

// throttle -------------------------------------------------------------------
{
  const clock = manualClock(1000)
  const pacer = new Throttle({ windowMs: 200, burst: 2, clock })
  eq('throttle: first two go through', [pacer.tryAcquire(), pacer.tryAcquire()], [0, 0])
  eq('throttle: third waits for the oldest stamp', pacer.tryAcquire(), 200)
  clock.advance(150)
  eq('throttle: still blocked inside the window', pacer.tryAcquire(), 50)
  clock.advance(50)
  eq('throttle: slot frees exactly at window edge', pacer.tryAcquire(), 0)
  eq('throttle: inspect reports explicit settings', pacer.inspect(), { windowMs: 200, burst: 2, used: 1, free: 1 })
  pacer.clear()
  eq('throttle: clear frees everything', pacer.inspect().free, 2)
  await throws('throttle: zero window rejected', () => new Throttle({ windowMs: 0 }), ConfigError)
  await throws('throttle: fractional burst rejected', () => new Throttle({ burst: 1.5 }), ConfigError)

  const gate = new Throttle({ windowMs: 100, burst: 1, clock })
  let passed = 0
  const waiting = (async () => { await gate.acquire(); await gate.acquire(); passed = 2 })()
  await Promise.resolve()
  eq('throttle: acquire blocks on the manual clock', passed, 0)
  clock.advance(100)
  await waiting
  eq('throttle: acquire resumes after advance', passed, 2)
}

// backoff / retry ------------------------------------------------------------
{
  eq('backoff: exponential, capped, attempts-1 entries',
    backoffSchedule({ attempts: 5, baseMs: 100, capMs: 350, factor: 2 }), [100, 200, 350, 350])
  eq('backoff: retry-after seconds', retryAfterMs('2'), 2000)
  eq('backoff: retry-after date', retryAfterMs(new Date(5000).toUTCString(), 2000), 3000)
  eq('backoff: retry-after garbage', retryAfterMs('soon'), null)

  eq('retry: 503 is retryable', retryable(new DeliveryError('x', { status: 503 })), true)
  eq('retry: 404 is not', retryable(new DeliveryError('x', { status: 404 })), false)
  eq('retry: 429 is', retryable(new DeliveryError('x', { status: 429 })), true)
  eq('retry: ECONNRESET is', retryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true)

  const clock = manualClock(0)
  const retry = new Retry({ attempts: 3, baseMs: 10, capMs: 10, factor: 1, clock, rng: () => 1 })
  let calls = 0
  const delays = []
  const run = retry.run(async () => {
    calls++
    if (calls < 3) throw new DeliveryError('boom', { status: 502 })
    return 'done'
  }, { onRetry: ({ delayMs }) => delays.push(delayMs) })
  for (let i = 0; i < 6; i++) { await Promise.resolve(); clock.advance(10) }
  eq('retry: succeeds on third try', await run, 'done')
  eq('retry: slept the scheduled delays', delays, [10, 10])

  const hopeless = new Retry({ attempts: 2, baseMs: 1, capMs: 1, factor: 1, clock, rng: () => 0 })
  const p = hopeless.run(async () => { throw new DeliveryError('nope', { status: 500 }) }, { jobId: 'j1' })
  p.catch(() => {})
  for (let i = 0; i < 4; i++) { await Promise.resolve(); clock.advance(1) }
  await throws('retry: gives up with GaveUpError', () => p, GaveUpError)
}

// queue ----------------------------------------------------------------------
{
  const q = new Queue('q', { depth: 3, lanes: 2 })
  q.push('slow', { lane: 1 })
  q.push('urgent', { lane: 0 })
  q.push('slow2', { lane: 1 })
  await throws('queue: depth enforced', () => q.push('overflow'), QueueFullError)
  eq('queue: lane 0 served first', [q.shift().payload, q.shift().payload, q.shift().payload], ['urgent', 'slow', 'slow2'])
  eq('queue: empty afterwards', q.shift(), undefined)
  await throws('queue: bad lane rejected', () => q.push('x', { lane: 9 }), ConfigError)
}

// signature ------------------------------------------------------------------
{
  const { header, value } = sign('topsecret', '{"a":1}', 1700000000000)
  eq('signature: header name from settings', header, tuning('signature').header)
  eq('signature: shape', parseSignature(value)?.timestamp, 1700000000000)
  eq('signature: verifies', verify('topsecret', '{"a":1}', value, { now: 1700000001000 }), { ok: true })
  eq('signature: body tamper detected', verify('topsecret', '{"a":2}', value, { now: 1700000001000 }).reason, 'mismatch')
  eq('signature: stale rejected', verify('topsecret', '{"a":1}', value, { now: 1700000000000 + 10 ** 9 }).reason, 'stale')
  eq('signature: garbage rejected', verify('topsecret', '{"a":1}', 'nope').reason, 'malformed')
}

// dispatcher end to end ------------------------------------------------------
{
  const clock = manualClock(0)
  const transport = memoryTransport((request, index) => (index === 0 ? 503 : 200))
  const relay = createDispatcher({
    clock,
    transport,
    throttle: { windowMs: 50, burst: 10 },
    retry: { attempts: 2, baseMs: 5, capMs: 5, factor: 1 },
  })
  relay.register('Billing', { url: 'https://example.test/hooks', secret: 'k1k1k1k1k1' })
  const events = []
  relay.on('retry', () => events.push('retry'))
  relay.on('delivered', () => events.push('delivered'))
  relay.push('billing', { type: 'invoice.paid', id: 'inv_1' })
  const draining = relay.drain()
  for (let i = 0; i < 8; i++) { await Promise.resolve(); clock.advance(5) }
  eq('dispatcher: drain handles one job', await draining, 1)
  eq('dispatcher: first try failed, second delivered', events, ['retry', 'delivered'])
  eq('dispatcher: two requests hit the transport', transport.requests.length, 2)
  eq('dispatcher: signed with configured header', typeof transport.requests[1].headers[tuning('signature').header], 'string')
  eq('dispatcher: stats counted', relay.stats.count('billing', 'delivered'), 1)
  eq('dispatcher: inspect shows explicit pacer', relay.inspect().pacer.windowMs, 50)
  eq('dispatcher: endpoint names normalised', relay.endpoints(), ['billing'])
  await relay.close()
  await throws('dispatcher: closed refuses pushes', () => relay.push('billing', {}), ConfigError)
}

console.log(`\n${total - failures}/${total} passed`)
process.exit(failures === 0 ? 0 : 1)
