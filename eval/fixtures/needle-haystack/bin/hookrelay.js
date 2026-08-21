#!/usr/bin/env node
/**
 * Tiny CLI, mostly for poking at a deployment:
 *
 *   hookrelay settings            print the effective settings tree
 *   hookrelay sign <secret> <body>   print a signature header for a body
 *   hookrelay verify <secret> <body> <header>
 *   hookrelay send <url> <secret> <json>   deliver one payload now (with retries)
 */

import { createDispatcher, sign, snapshot, verify } from '../src/index.js'
import { describe } from '../src/errors.js'

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr
  out.write([
    'usage:',
    '  hookrelay settings',
    '  hookrelay sign <secret> <body>',
    '  hookrelay verify <secret> <body> <header>',
    '  hookrelay send <url> <secret> <json>',
    '',
  ].join('\n'))
  process.exit(code)
}

async function main(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case 'settings': {
      process.stdout.write(JSON.stringify(snapshot(), null, 2) + '\n')
      return 0
    }
    case 'sign': {
      const [secret, body] = rest
      if (secret === undefined || body === undefined) usage(2)
      const { header, value } = sign(secret, body)
      process.stdout.write(`${header}: ${value}\n`)
      return 0
    }
    case 'verify': {
      const [secret, body, header] = rest
      if (header === undefined) usage(2)
      const result = verify(secret, body, header)
      process.stdout.write(result.ok ? 'ok\n' : `rejected: ${result.reason}\n`)
      return result.ok ? 0 : 1
    }
    case 'send': {
      const [url, secret, json] = rest
      if (json === undefined) usage(2)
      const relay = createDispatcher()
      relay.register('cli', { url, secret })
      relay.on('failed', ({ error }) => process.stderr.write(`failed: ${describe(error)}\n`))
      relay.push('cli', JSON.parse(json))
      await relay.drain()
      await relay.close()
      return relay.stats.count('cli', 'delivered') === 1 ? 0 : 1
    }
    case undefined:
    case '-h':
    case '--help':
      usage(0)
      return 0
    default:
      process.stderr.write(`unknown command "${command}"\n`)
      usage(2)
      return 2
  }
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  error => { process.stderr.write(describe(error) + '\n'); process.exit(1) },
)
