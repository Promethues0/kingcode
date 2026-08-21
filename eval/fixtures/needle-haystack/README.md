# hookrelay

A small, dependency-free webhook relay for Node. You hand it outbound events,
it queues them per endpoint, signs the payload, paces delivery, retries on
failure and reports what happened.

```js
import { createDispatcher } from 'hookrelay'

const relay = createDispatcher({
  transport: { timeoutMs: 5000 },
})

relay.register('billing', { url: 'https://example.test/hooks/billing', secret: 'k1' })
await relay.push('billing', { type: 'invoice.paid', id: 'inv_42' })
await relay.drain()
```

## Configuration

Every tunable has a built-in value. You can override it three ways, from lowest
to highest precedence:

1. environment variables prefixed with `HOOKRELAY_` (see `src/env.js`)
2. `configure({...})` at startup — `config/staging.example.json` shows the shape
3. per-call options passed to `createDispatcher()` / `register()`

Run the test-suite with `npm test`.
