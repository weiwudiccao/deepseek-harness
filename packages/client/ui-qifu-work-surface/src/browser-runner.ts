/** Authenticated loopback access to the desktop's isolated Electron DOM reader. */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Deployment limits may narrow the desktop service's fixed ceilings. */
export interface BrowserRunnerOptions {
  /** Complete read deadline, in milliseconds; at most 30 seconds. */
  readonly timeoutMs: number
  /** Maximum retained UTF-8 DOM bytes; at most 1 MiB. */
  readonly maxDomBytes: number
}

/** Page URL and caller cancellation for one isolated DOM read. */
export interface BrowserRunRequest {
  readonly url: string
  readonly signal: AbortSignal
}

/** DOM evidence from a disposable sandboxed desktop renderer. */
export interface BrowserRunResult {
  readonly url: string
  readonly dom: string
  readonly domTruncated: boolean
}

type BrowserRequestId = Branded<'QifuBrowserRequestId'>
interface RequestIdentity {
  readonly requestId: BrowserRequestId
  readonly createdAt: number
}

function browserUrl(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new Error('browser check requires an HTTP or HTTPS URL without credentials')
  }
  return url.href
}

function desktopEndpoint(): string {
  const value = process.env['QIFUAI_BROWSER_TEST_URL'] ?? ''
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/qifu-browser-test$/u.test(value)) {
    throw new Error('desktop browser endpoint must be the trusted loopback DOM service')
  }
  const url = new URL(value)
  if (url.port === '') throw new Error('desktop browser endpoint requires a non-default port')
  return url.href
}

function desktopToken(): string {
  const token = process.env['QIFUAI_BROWSER_TEST_TOKEN'] ?? ''
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error('desktop browser token is missing or invalid')
  return token
}

function parseResult(data: Buffer, expectedUrl: string, maxDomBytes: number): BrowserRunResult {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  if (value === null || typeof value !== 'object') throw new Error('desktop browser response must contain DOM fields')
  const record = value as Record<string, unknown>
  if (record['url'] !== expectedUrl || typeof record['dom'] !== 'string' || typeof record['domTruncated'] !== 'boolean') {
    throw new Error('desktop browser response contains invalid DOM fields')
  }
  const bytes = Buffer.from(record['dom'])
  let end = Math.min(bytes.byteLength, maxDomBytes)
  while (end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { url: expectedUrl, dom: bytes.subarray(0, end).toString('utf8'), domTruncated: record['domTruncated'] || end < bytes.byteLength }
}

/** Own DOM requests until the desktop acknowledges renderer destruction. */
export class BrowserRunner {
  private readonly endpoint: string
  private readonly token: string
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<BrowserRunResult>>()
  private disposal: Promise<void> | undefined

  /**
   * @param options - validated deployment limits for the trusted desktop service.
   */
  constructor(private readonly options: BrowserRunnerOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) {
      throw new Error('desktop browser timeout must be between 1 and 30000 milliseconds')
    }
    if (!Number.isSafeInteger(options.maxDomBytes) || options.maxDomBytes < 1 || options.maxDomBytes > 1024 * 1024) {
      throw new Error('desktop browser DOM limit must be between 1 byte and 1 MiB')
    }
    this.endpoint = desktopEndpoint()
    this.token = desktopToken()
  }

  /**
   * Read one HTTP(S) page without a personal browser profile or shell launch.
   * @param request - page URL and caller cancellation.
   * @returns bounded DOM after renderer destruction; cancellation and transport errors reject.
   */
  run(request: BrowserRunRequest): Promise<BrowserRunResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('browser runner is disposed'))
    const operation = this.execute(request)
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => undefined)
    return operation
  }

  /** Cancel active reads and await desktop cleanup acknowledgements. @returns completion after every owned request has settled. */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort(new Error('browser runner is disposed'))
      const settled = await Promise.allSettled([...this.operations])
      const failures = settled.flatMap<unknown>(result =>
        result.status === 'rejected' && result.reason !== this.lifetime.signal.reason ? [result.reason as unknown] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'browser runner disposal failed')
    })()
    return this.disposal
  }

  private transport(
    method: 'POST' | 'DELETE', payload: object, identity: RequestIdentity, signal: AbortSignal, maxBytes: number,
  ): Promise<{ status: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload)
      const request = httpRequest(this.endpoint, {
        method, signal, agent: false,
        headers: {
          authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          'x-qifu-browser-request-id': identity.requestId, 'x-qifu-browser-created-at': identity.createdAt,
        },
      }, (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > maxBytes) {
            const error = new Error('desktop browser response exceeds its byte limit')
            reject(error)
            request.destroy(error)
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('aborted', () => { reject(new Error('desktop browser response was interrupted')) })
        response.once('end', () => { resolve({ status: response.statusCode ?? 0, data: Buffer.concat(chunks) }) })
      })
      request.once('error', reject)
      request.end(body)
    })
  }

  private async execute(request: BrowserRunRequest): Promise<BrowserRunResult> {
    const url = browserUrl(request.url)
    const identity = { requestId: randomUUID() as BrowserRequestId, createdAt: Date.now() }
    const timeout = new AbortController()
    const signal = AbortSignal.any([request.signal, this.lifetime.signal, timeout.signal])
    const timer = setTimeout(() => { timeout.abort(new Error('browser check timed out')) }, this.options.timeoutMs)
    let started = false
    let completed = false
    let failure: unknown
    try {
      signal.throwIfAborted()
      started = true
      const response = await this.transport('POST', {
        requestId: identity.requestId, url, maxDomBytes: this.options.maxDomBytes, timeoutMs: this.options.timeoutMs,
      }, identity, signal, this.options.maxDomBytes * 6 + 4096)
      if (response.status !== 200) throw new Error(`desktop browser service returned HTTP ${response.status}`)
      const result = parseResult(response.data, url, this.options.maxDomBytes)
      signal.throwIfAborted()
      completed = true
      return result
    } catch (error) {
      failure = signal.aborted ? signal.reason as unknown : error
      throw failure
    } finally {
      clearTimeout(timer)
      if (started && !completed) {
        try {
          const response = await this.transport('DELETE', { requestId: identity.requestId }, identity,
            AbortSignal.timeout(this.options.timeoutMs), 4096)
          if (response.status !== 204) throw new Error(`desktop browser cleanup returned HTTP ${response.status}`)
        } catch (error) {
          throw new AggregateError(failure === undefined ? [error] : [failure, error], 'desktop browser cleanup failed')
        }
      }
    }
  }
}
