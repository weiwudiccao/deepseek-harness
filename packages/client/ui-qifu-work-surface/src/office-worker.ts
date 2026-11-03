/** One office operation in a terminable worker without employee credentials. */

import { parentPort, workerData } from 'node:worker_threads'
import { OfficeParser, type OfficeIssue, type OfficeParserConfig, type SupportedDestination, type SupportedFileType } from 'officeparser'
import type { OfficeEngineLimits, OfficeWorkerRequest } from './office-engine.ts'

const SAFE_ENVIRONMENT = new Set(['TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR'])
if (Object.keys(process.env).some(key => !SAFE_ENVIRONMENT.has(key.toUpperCase()))) throw new Error('OFFICE_WORKER_UNSAFE_ENV')

function decodeRequest(value: unknown): OfficeWorkerRequest {
  if (typeof value !== 'object' || value === null) throw new Error('OFFICE_WORKER_INVALID_REQUEST')
  const message = value as Record<string, unknown>
  const limits = message['limits']
  if (typeof limits !== 'object' || limits === null) throw new Error('OFFICE_WORKER_INVALID_REQUEST')
  const ceiling = limits as Record<string, unknown>
  const keys: readonly (keyof OfficeEngineLimits)[] = [
    'timeoutMs', 'maxInputBytes', 'maxOutputBytes', 'maxTextBytes', 'maxUncompressedBytes',
    'maxZipEntries', 'maxTableCells', 'maxXmlElements', 'maxRepeatedContent', 'memoryMb',
  ]
  if (keys.some(key => typeof ceiling[key] !== 'number' || !Number.isSafeInteger(ceiling[key]) || ceiling[key] < 1)) {
    throw new Error('OFFICE_WORKER_INVALID_REQUEST')
  }
  if (typeof message['format'] !== 'string') throw new Error('OFFICE_WORKER_INVALID_REQUEST')
  if (message['operation'] === 'read' && message['data'] instanceof Uint8Array) {
    if (message['data'].byteLength > Number(ceiling['maxInputBytes'])) throw new Error('OFFICE_INPUT_TOO_LARGE')
    return message as OfficeWorkerRequest
  }
  if (message['operation'] === 'create' && typeof message['markdown'] === 'string'
    && (message['fontData'] === undefined || message['fontData'] instanceof Uint8Array)) {
    if (Buffer.byteLength(message['markdown'], 'utf8') > Number(ceiling['maxInputBytes'])) throw new Error('OFFICE_INPUT_TOO_LARGE')
    return message as OfficeWorkerRequest
  }
  throw new Error('OFFICE_WORKER_INVALID_REQUEST')
}

const request = decodeRequest(workerData as unknown)

function parseConfig(format: string): OfficeParserConfig {
  return {
    fileType: format as SupportedFileType,
    allowRemoteAssets: false,
    extractAttachments: false,
    includeRawContent: false,
    ocr: false,
    maxPasswordAttempts: 0,
    decompressionLimits: {
      maxUncompressedBytes: request.limits.maxUncompressedBytes,
      maxZipEntries: request.limits.maxZipEntries,
      maxTableCells: request.limits.maxTableCells,
      maxXmlElements: request.limits.maxXmlElements,
      maxRepeatedContent: request.limits.maxRepeatedContent,
      maxRawContentLength: request.limits.maxTextBytes,
    },
    pdfParserConfig: { separateProcess: false, extractTextColor: false },
    htmlParserConfig: { preserveAttributes: false, preserveIframes: false },
  }
}

function assertNoLimitWarning(issues: readonly OfficeIssue[]): void {
  if (issues.some(issue => /LIMIT_EXCEEDED|CONTENT_NOT_REPRESENTABLE/.test(issue.code))) {
    throw new Error('OFFICE_CONTENT_LIMIT')
  }
}

async function execute(): Promise<string | Uint8Array> {
  if (request.operation === 'read') {
    const text = request.format === 'txt'
      ? new TextDecoder('utf-8', { fatal: true }).decode(request.data)
      : await extractText()
    if (Buffer.byteLength(text, 'utf8') > request.limits.maxTextBytes) throw new Error('OFFICE_TEXT_TOO_LARGE')
    return text
  }
  const ast = await OfficeParser.parseOffice(new TextEncoder().encode(request.markdown), parseConfig('md'))
  assertNoLimitWarning(ast.warnings)
  const destination = (request.format === 'txt' ? 'text' : request.format) as SupportedDestination
  const result = await ast.to(destination, {
    onNode: node => node.type === 'embed' ? false : undefined,
    includeImages: false,
    includeCharts: false,
    renderMetadata: false,
    metadataOverrides: { author: '企福AI智脑', lastModifiedBy: '企福AI智脑', language: 'zh-CN' },
    htmlConfig: { standalone: { scripts: false, headInjections: false, bodyInjections: false }, gatedEmbeds: true },
    pdfConfig: {
      engine: 'native',
      fonts: { regular: request.fontData ?? null },
      subsetFonts: true,
    },
  })
  assertNoLimitWarning(result.messages)
  const value: unknown = result.value
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new Error('OFFICE_GENERATION_FAILED')
  const output = typeof value === 'string' ? new TextEncoder().encode(value) : value
  if (output.byteLength > request.limits.maxOutputBytes) throw new Error('OFFICE_OUTPUT_TOO_LARGE')
  return output
}

async function extractText(): Promise<string> {
  if (request.operation !== 'read') throw new Error('OFFICE_WORKER_INVALID_REQUEST')
  const ast = await OfficeParser.parseOffice(request.data, parseConfig(request.format))
  assertNoLimitWarning(ast.warnings)
  const result = await ast.to('text', { includeImages: false, renderMetadata: false })
  assertNoLimitWarning(result.messages)
  const text = result.value
  if (request.format === 'pdf' && text.trim() === '') throw new Error('OFFICE_PDF_TEXT_REQUIRED')
  return text
}

void execute().then((value) => {
  parentPort?.postMessage({ value })
}).catch((error: unknown) => {
  const code = error instanceof Error && /^OFFICE_[A-Z_]+$/.test(error.message)
    ? error.message
    : request.operation === 'read' ? 'OFFICE_READ_FAILED' : 'OFFICE_GENERATION_FAILED'
  parentPort?.postMessage({ error: code })
})
