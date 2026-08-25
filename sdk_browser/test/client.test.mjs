import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { ZipLoggerBrowser } from '../index.js'

let server, requests, responses

beforeEach(async () => {
  requests = []
  responses = []
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const status = responses.length ? responses.shift() : 202
      requests.push({
        path: req.url,
        apiKey: req.headers['x-api-key'],
        lines: body.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        status,
      })
      if (status === 429) res.setHeader('Retry-After', '0')
      res.statusCode = status
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(() => server.close())

const makeClient = (overrides = {}) => new ZipLoggerBrowser({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  apiKey: 'zk_test',
  flushIntervalMs: 30,
  retryBaseDelayMs: 10,
  ...overrides,
})

const waitFor = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
  const start = Date.now()
  const timer = setInterval(() => {
    if (predicate()) { clearInterval(timer); resolve() }
    else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('timeout')) }
  }, 10)
})

test('batches NDJSON with api key and defaults', async () => {
  const client = makeClient({ source: 'webapp', release: '2.0.0' })
  for (let i = 0; i < 3; i++) client.log({ severity: 'info', message: `event ${i}`, fields: { i } })
  await client.close()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/ingest/v1/logs')
  assert.equal(requests[0].apiKey, 'zk_test')
  const first = requests[0].lines[0]
  assert.equal(first.source, 'webapp')
  assert.equal(first.release, '2.0.0')
  assert.equal(first.fields.environment, 'production')
})

test('captureError maps stack and fields', async () => {
  const client = makeClient()
  client.captureError(new RangeError('too far'), { step: 'checkout' })
  await client.close()

  const entry = requests[0].lines[0]
  assert.equal(entry.severity, 'error')
  assert.equal(entry.message, 'too far')
  assert.match(entry.stackTrace, /RangeError: too far/)
  assert.equal(entry.fields.exceptionType, 'RangeError')
  assert.equal(entry.fields.step, 'checkout')
})

test('retries on 429 then succeeds', async () => {
  responses = [429, 202]
  const client = makeClient()
  client.log({ severity: 'info', message: 'retry me' })
  await waitFor(() => requests.length >= 2)
  await client.close()
  assert.equal(client.dropped, 0)
})

test('drops after browser-tuned max retries', async () => {
  responses = [500, 500, 500]
  const client = makeClient({ maxRetries: 2 })
  client.log({ severity: 'info', message: 'doomed' })
  await waitFor(() => client.dropped >= 1)
  assert.equal(requests.length, 3)
  await client.close()
})

test('queue overflow drops instead of blocking', async () => {
  const client = makeClient({ queueCapacity: 2, flushIntervalMs: 60_000 })
  for (let i = 0; i < 20; i++) client.log({ severity: 'info', message: `burst ${i}` })
  assert.ok(client.dropped >= 18)
  await client.close()
})

test('keepalive flush sends without retrying', async () => {
  responses = [500]
  const client = makeClient()
  client.log({ severity: 'info', message: 'unloading' })
  await client.flush(true)
  assert.equal(requests.length, 1) // no retries during unload
  assert.equal(client.dropped, 1)
})

test('react error boundary factory logs render errors', async () => {
  const { createErrorBoundary } = await import('../react.js')
  const client = makeClient()

  // Minimal React stand-in: the factory only needs Component with setState-free lifecycle.
  const FakeReact = { Component: class { constructor(props) { this.props = props } } }
  const Boundary = createErrorBoundary(FakeReact, client)
  const boundary = new Boundary({ name: 'AppShell' })
  boundary.componentDidCatch(new Error('render exploded'), { componentStack: '\n  at App\n  at Root' })
  await client.close()

  const entry = requests[0].lines[0]
  assert.match(entry.message, /render exploded/)
  assert.match(entry.fields.componentStack, /at App/)
  assert.equal(entry.fields.boundary, 'AppShell')
})
