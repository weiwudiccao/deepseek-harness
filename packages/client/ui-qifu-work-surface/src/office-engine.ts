/** Isolated, bounded office-document parsing and generation. */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

/** Resource ceilings for one isolated office operation. */
export interface OfficeEngineLimits {
  /** Deadline including worker startup and parsing, in milliseconds. */
  timeoutMs?: number
  /** Maximum original file or Markdown size. */
  maxInputBytes?: number
  /** Maximum generated file size. */
  maxOutputBytes?: number
  /** Maximum extracted UTF-8 text size. */
  maxTextBytes?: number
  /** Maximum combined size of decompressed archive entries. */
  maxUncompressedBytes?: number
  /** Maximum archive entries. */
  maxZipEntries?: number
  /** Base cell limit used by the parser's size-adjusted table bound. */
  maxTableCells?: number
  /** Maximum XML elements materialized by a parse. */
  maxXmlElements?: number
  /** Base character limit for repeated document content. */
  maxRepeatedContent?: number
  /** Worker V8 heap ceiling, in MiB. */
  memoryMb?: number
}

const DEFAULT_LIMITS: Required<OfficeEngineLimits> = {
  timeoutMs: 30_000,
  maxInputBytes: 25 * 1024 * 1024,
  maxOutputBytes: 25 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxZipEntries: 5000,
  maxTableCells: 100_000,
  maxXmlElements: 300_000,
  maxRepeatedContent: 2 * 1024 * 1024,
  memoryMb: 512,
}

const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'html', 'csv', 'txt', 'md', 'rtf', 'odt', 'odp', 'ods'])

/** Worker input contains document bytes and ceilings, never ambient credentials. */
export type OfficeWorkerRequest = {
  operation: 'read'
  data: Uint8Array
  format: string
  limits: Required<OfficeEngineLimits>
} | {
  operation: 'create'
  markdown: string
  format: string
  fontData?: Uint8Array
  limits: Required<OfficeEngineLimits>
}

function supportedFormat(value: string): string {
  const extension = value.toLowerCase()
  const format = extension === 'htm' ? 'html' : extension
  if (!FORMATS.has(format)) throw new Error('OFFICE_UNSUPPORTED_FORMAT')
  return format
}

function workerEntry(): string | URL {
  if (!import.meta.url.endsWith('.ts')) return fileURLToPath(new URL('./office-worker.cjs', import.meta.url))
  const bootstrap = [
    `import { register as esm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    `import { register as cjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`,
    'cjs()',
    'esm()',
    `await import(${JSON.stringify(new URL('./office-worker.ts', import.meta.url).href)})`,
  ].join('\n')
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const temporary = tmpdir()
  const env: NodeJS.ProcessEnv = { TMP: temporary, TEMP: temporary, TMPDIR: temporary }
  if (process.platform === 'win32') {
    const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT']
    const windir = process.env['WINDIR'] ?? root
    if (root !== undefined) env['SystemRoot'] = root
    if (windir !== undefined) env['WINDIR'] = windir
  }
  return env
}

async function runWorker(request: OfficeWorkerRequest, signal?: AbortSignal): Promise<string | Uint8Array> {
  signal?.throwIfAborted()
  const worker = new Worker(workerEntry(), {
    workerData: request,
    env: workerEnvironment(),
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: request.limits.memoryMb,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('OFFICE_TIMEOUT')) }, request.limits.timeoutMs)
      onAbort = () => { reject(signal?.reason instanceof Error ? signal.reason : new Error('OFFICE_ABORTED')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      worker.once('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) {
          reject(new Error('OFFICE_WORKER_INVALID_RESULT'))
          return
        }
        if ('error' in message && typeof message.error === 'string') {
          reject(new Error(message.error))
          return
        }
        if ('value' in message && (typeof message.value === 'string' || message.value instanceof Uint8Array)) {
          resolve(message.value)
          return
        }
        reject(new Error('OFFICE_WORKER_INVALID_RESULT'))
      })
      worker.once('error', () => { reject(new Error('OFFICE_WORKER_FAILED')) })
      worker.once('exit', () => { reject(new Error('OFFICE_WORKER_EXITED')) })
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    await worker.terminate()
    worker.removeAllListeners()
  }
}

/**
 * Extract document text without starting an Office application.
 * @param data - original document bytes.
 * @param name - filename selecting the supported input format.
 * @param limits - optional deployment resource ceilings.
 * @param signal - cancels the operation and ends its worker.
 * @returns extracted text.
 */
export async function readOffice(data: Uint8Array, name: string, limits: OfficeEngineLimits = {}, signal?: AbortSignal): Promise<string> {
  const resolved = { ...DEFAULT_LIMITS, ...limits }
  const format = supportedFormat(extname(name).slice(1))
  if (data.byteLength > resolved.maxInputBytes) throw new Error('OFFICE_INPUT_TOO_LARGE')
  const value = await runWorker({ operation: 'read', data, format, limits: resolved }, signal)
  if (typeof value !== 'string') throw new Error('OFFICE_WORKER_INVALID_RESULT')
  return value
}

/**
 * Generate an office document from Markdown.
 * @param markdown - document content.
 * @param format - output extension.
 * @param limits - optional deployment resource ceilings.
 * @param signal - cancels the operation and ends its worker.
 * @returns generated file bytes.
 */
export async function createOffice(
  markdown: string, format: string, limits: OfficeEngineLimits = {}, signal?: AbortSignal,
): Promise<Uint8Array> {
  const resolved = { ...DEFAULT_LIMITS, ...limits }
  const selected = supportedFormat(format)
  if (Buffer.byteLength(markdown, 'utf8') > resolved.maxInputBytes) throw new Error('OFFICE_INPUT_TOO_LARGE')
  signal?.throwIfAborted()
  const fontData = selected === 'pdf' ? await readFile(fileURLToPath(new URL('./assets/NotoSansSC-Regular.ttf', import.meta.url))) : undefined
  const value = await runWorker({ operation: 'create', markdown, format: selected, ...(fontData === undefined ? {} : { fontData }), limits: resolved }, signal)
  if (!(value instanceof Uint8Array)) throw new Error('OFFICE_WORKER_INVALID_RESULT')
  return value
}
