import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRunner } from '../src/browser-runner.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (failures.length > 0) throw new AggregateError(failures, 'browser fixture cleanup failed')
})

interface RecordedRequest {
  readonly method: string | undefined
  readonly authorization: string | undefined
  readonly requestId: string | string[] | undefined
  readonly createdAt: string | string[] | undefined
  readonly body: Record<string, unknown>
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(handler?: (request: RecordedRequest, response: ServerResponse) => Promise<void> | void, timeoutMs = 30_000) {
  const token = randomBytes(32).toString('hex')
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const record = {
        method: request.method, authorization: request.headers.authorization,
        requestId: request.headers['x-qifu-browser-request-id'], createdAt: request.headers['x-qifu-browser-created-at'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }
      requests.push(record)
      if (handler !== undefined) return handler(record, response)
      if (request.method === 'DELETE') { response.writeHead(204).end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ url: record.body['url'], dom: '<p>ready</p>', domTruncated: false }))
    })().catch((error: unknown) => { response.destroy(error as Error) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/qifu-browser-test`
  vi.stubEnv('QIFUAI_BROWSER_TEST_URL', endpoint)
  vi.stubEnv('QIFUAI_BROWSER_TEST_TOKEN', token)
  const runner = new BrowserRunner({ timeoutMs, maxDomBytes: 128 })
  cleanups.push(() => runner.dispose())
  const request = { url: 'https://example.com/check', signal: new AbortController().signal }
  return { runner, request, requests, token, endpoint }
}

describe('desktop Electron DOM transport runner', () => {
  it('sends only bounded URL-check inputs to the authenticated desktop endpoint', async () => {
    const f = await fixture()
    const result = await f.runner.run(f.request)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({
      method: 'POST', authorization: `Bearer ${f.token}`,
      body: { url: f.request.url, maxDomBytes: 128, timeoutMs: 30_000 },
    })
    expect(Object.keys(f.requests[0]?.body ?? {}).sort()).toEqual(['maxDomBytes', 'requestId', 'timeoutMs', 'url'])
    expect(f.requests[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(f.requests[0]?.requestId).toBe(f.requests[0]?.body['requestId'])
    expect(Number(f.requests[0]?.createdAt)).toBeGreaterThan(0)
    expect(result).toEqual({ url: f.request.url, dom: '<p>ready</p>', domTruncated: false })
  })

  it('rejects missing credentials, remote endpoints, and endpoint URL overrides', () => {
    vi.stubEnv('QIFUAI_BROWSER_TEST_TOKEN', 'test-token-that-is-longer-than-32-characters')
    for (const endpoint of ['', 'https://127.0.0.1:3000/qifu-browser-test', 'http://localhost:3000/qifu-browser-test',
      'http://127.0.0.1:3000/other', 'http://127.0.0.1:3000/qifu-browser-test?x=1',
      'http://user:password@127.0.0.1:3000/qifu-browser-test']) {
      vi.stubEnv('QIFUAI_BROWSER_TEST_URL', endpoint)
      expect(() => new BrowserRunner({ timeoutMs: 1000, maxDomBytes: 128 })).toThrow(/desktop browser/u)
    }
    vi.stubEnv('QIFUAI_BROWSER_TEST_URL', 'http://127.0.0.1:3000/qifu-browser-test')
    vi.stubEnv('QIFUAI_BROWSER_TEST_TOKEN', '')
    expect(() => new BrowserRunner({ timeoutMs: 1000, maxDomBytes: 128 })).toThrow(/token/u)
  })

  it('rejects unsafe page URLs before contacting the service', async () => {
    const f = await fixture()
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,test',
      'https://user:password@example.com', 'not a URL']) {
      await expect(f.runner.run({ ...f.request, url })).rejects.toThrow()
    }
    expect(f.requests).toHaveLength(0)
  })

  it('bounds multibyte DOM and validates the native response fields', async () => {
    const f = await fixture((request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204).end(); return }
      response.end(JSON.stringify({ url: request.body['url'], dom: '汉'.repeat(100), domTruncated: false }))
    })
    const result = await f.runner.run(f.request)
    expect(Buffer.byteLength(result.dom)).toBeLessThanOrEqual(128)
    expect(result.dom).not.toContain('\ufffd')
    expect(result.domTruncated).toBe(true)
    const invalid = await fixture((request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204).end(); return }
      response.end(JSON.stringify({ url: 'file:///secret', dom: 12, domTruncated: false }))
    })
    await expect(invalid.runner.run(invalid.request)).rejects.toThrow(/response/u)
  })

  it.each([302, 502])('rejects HTTP %i without following redirects or exposing its token', async (status) => {
    const f = await fixture((request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204).end(); return }
      response.writeHead(status, { location: 'https://example.invalid/should-never-receive-token' }).end('native renderer failed')
    })
    await expect(f.runner.run(f.request)).rejects.toThrow(`HTTP ${status}`)
    expect(f.requests.at(-1)?.method).toBe('DELETE')
  })

  it('rejects oversized response bodies and confirms request cleanup', async () => {
    const f = await fixture((request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204).end(); return }
      response.end('x'.repeat(16_384))
    })
    await expect(f.runner.run(f.request)).rejects.toThrow(/response.*limit/u)
    expect(f.requests.at(-1)?.method).toBe('DELETE')
  })

  it('waits for cancellation acknowledgement before settling the operation', async () => {
    const started = deferred()
    const cancelling = deferred()
    const destroyed = deferred()
    const f = await fixture(async (request, response) => {
      if (request.method === 'POST') { started.resolve(); return }
      cancelling.resolve()
      await destroyed.promise
      response.writeHead(204).end()
    })
    cleanups.push(async () => { destroyed.resolve() })
    const abort = new AbortController()
    let settled = false
    const running = f.runner.run({ ...f.request, signal: abort.signal }).catch((error: unknown) => { settled = true; return error })
    await started.promise
    abort.abort()
    await cancelling.promise
    expect(settled).toBe(false)
    destroyed.resolve()
    expect(await running).toBe(abort.signal.reason)
    expect(f.requests[1]?.body['requestId']).toBe(f.requests[0]?.body['requestId'])
    expect(f.requests[1]?.createdAt).toBe(f.requests[0]?.createdAt)
  })

  it('reports deadline independently after acknowledged native cleanup', async () => {
    const f = await fixture((request, response) => {
      if (request.method === 'DELETE') response.writeHead(204).end()
    }, 100)
    await expect(f.runner.run(f.request)).rejects.toThrow('browser check timed out')
    expect(f.requests.at(-1)?.method).toBe('DELETE')
  })

  it('disposes active requests only after acknowledgement and rejects new work', async () => {
    const started = deferred()
    const cancelling = deferred()
    const destroyed = deferred()
    const f = await fixture(async (request, response) => {
      if (request.method === 'POST') { started.resolve(); return }
      cancelling.resolve()
      await destroyed.promise
      response.writeHead(204).end()
    })
    cleanups.push(async () => { destroyed.resolve() })
    const running = f.runner.run(f.request).catch((error: unknown) => error)
    await started.promise
    let stopped = false
    const stopping = f.runner.dispose().then(() => { stopped = true })
    await cancelling.promise
    expect(stopped).toBe(false)
    destroyed.resolve()
    await stopping
    expect(await running).toMatchObject({ message: 'browser runner is disposed' })
    await expect(f.runner.run(f.request)).rejects.toThrow(/disposed/u)
  })

  it('propagates failed cleanup acknowledgement rather than claiming cancellation completed', async () => {
    const started = deferred()
    const f = await fixture((request, response) => {
      if (request.method === 'POST') { started.resolve(); return }
      response.writeHead(503).end()
    })
    const abort = new AbortController()
    const running = f.runner.run({ ...f.request, signal: abort.signal })
    await started.promise
    abort.abort()
    await expect(running).rejects.toThrow(/cleanup/u)
  })
})
