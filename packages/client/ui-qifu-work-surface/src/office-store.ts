/** Immutable Office files under one employee runtime's private Harness home. */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeDocument, OfficeDocumentId } from './office-types.ts'

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf', 'html', 'htm', 'csv', 'txt', 'md', 'rtf', 'odt', 'odp', 'ods'])

/** Store limits resolved from the deployment's plugin configuration. */
export interface OfficeStoreLimits {
  readonly maxDocumentBytes: number
  readonly maxDocumentsPerSession: number
}

function sessionKey(sessionId: string): string {
  if (sessionId.trim() === '') throw new Error('Office document session id is required')
  return createHash('sha256').update(sessionId).digest('hex')
}

/**
 * Validate a display-only filename and return its supported extension.
 * @param name - filename without directory components.
 * @returns lowercase Office format.
 */
export function officeFormat(name: string): string {
  if (name.length < 1 || name.length > 180 || name.trim() !== name
    || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(name) || name.startsWith('.')) {
    throw new Error('Office document name must be a filename without paths or control characters')
  }
  const format = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (!name.includes('.') || !FORMATS.has(format)) throw new Error('Office document format is unsupported')
  return format === 'htm' ? 'html' : format
}

async function directory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const info = await lstat(path).catch((error: unknown) => {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return false
  if (info.isSymbolicLink()) throw new Error('Office document storage refuses symbolic links')
  if (!info.isDirectory()) throw new Error('Office document storage is not a directory')
  return true
}

async function boundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Office document storage refuses symbolic links and non-files')
  if (info.size > maxBytes) throw new Error('Office document exceeds its size limit')
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maxBytes) {
      throw new Error('Office document changed while opening')
    }
    const data = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1))
    let bytes = 0
    while (bytes < data.length) {
      const result = await handle.read(data, bytes, data.length - bytes, bytes)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
    }
    if (bytes > maxBytes || bytes !== opened.size) throw new Error('Office document exceeds its size limit or changed during reading')
    return data.subarray(0, bytes)
  } finally {
    await handle.close()
  }
}

function metadata(value: unknown, id: string, limit: number): OfficeDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Office document metadata is invalid')
  const row = value as Record<string, unknown>
  if (row['id'] !== id || typeof row['name'] !== 'string'
    || row['format'] !== officeFormat(row['name']) || (row['kind'] !== 'original' && row['kind'] !== 'generated')
    || typeof row['bytes'] !== 'number' || !Number.isSafeInteger(row['bytes']) || row['bytes'] < 0 || row['bytes'] > limit
    || typeof row['sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(row['sha256'])
    || typeof row['createdAt'] !== 'string' || !Number.isFinite(Date.parse(row['createdAt']))) {
    throw new Error('Office document metadata is invalid')
  }
  return { id: brandString<OfficeDocumentId>(id), name: row['name'], format: row['format'], kind: row['kind'], bytes: row['bytes'], sha256: row['sha256'], createdAt: row['createdAt'] }
}

/** Session-scoped immutable original and generated Office file storage. */
export class OfficeStore {
  private readonly root: string
  private readonly pending = new Map<string, Promise<unknown>>()

  /** @param dshHome - absolute employee-specific Harness home. @param limits - complete input and retained-file limits. */
  constructor(private readonly dshHome: string, private readonly limits: OfficeStoreLimits) {
    if (!isAbsolute(dshHome)) throw new Error('Office document home must be absolute')
    for (const value of [limits.maxDocumentBytes, limits.maxDocumentsPerSession]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Office document limits must be positive integers')
    }
    this.root = join(dshHome, 'qifu-office', 'v1')
  }

  private async sessionDirectory(sessionId: string, create: boolean): Promise<string | undefined> {
    const parent = join(this.dshHome, 'qifu-office')
    if (!await directory(parent, create) || !await directory(this.root, create)) return undefined
    const path = join(this.root, sessionKey(sessionId))
    return await directory(path, create) ? path : undefined
  }

  /**
   * Retain a new document without overwriting an existing file.
   * @param sessionId - owning Session identity.
   * @param name - display-only filename.
   * @param data - complete source or generated bytes.
   * @param kind - whether the file was uploaded or generated.
   * @param signal - cancellation checked before metadata publishes the document.
   * @returns committed immutable document metadata.
   */
  save(sessionId: string, name: string, data: Uint8Array, kind: OfficeDocument['kind'], signal?: AbortSignal): Promise<OfficeDocument> {
    const key = sessionKey(sessionId)
    const before = this.pending.get(key) ?? Promise.resolve()
    const result = before.catch(() => undefined).then(async () => {
      signal?.throwIfAborted()
      const format = officeFormat(name)
      if (data.byteLength > this.limits.maxDocumentBytes) throw new Error('Office document exceeds its size limit')
      const parent = await this.sessionDirectory(sessionId, true)
      if (parent === undefined) throw new Error('Office document storage is unavailable')
      const entries = await readdir(parent)
      if (entries.filter(entry => DOCUMENT_ID.test(entry)).length >= this.limits.maxDocumentsPerSession) {
        throw new Error('Office document count limit reached for this Session')
      }
      const id = brandString<OfficeDocumentId>(randomUUID())
      const destination = join(parent, id)
      await mkdir(destination, { mode: 0o700 })
      const document: OfficeDocument = {
        id, name, format, kind, bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'), createdAt: new Date().toISOString(),
      }
      try {
        await writeFile(join(destination, 'content'), data, { mode: 0o600, flag: 'wx' })
        signal?.throwIfAborted()
        await writeFile(join(destination, 'metadata.json'), `${JSON.stringify(document)}\n`, { mode: 0o600, flag: 'wx' })
        return document
      } catch (error) {
        await rm(destination, { recursive: true, force: true })
        throw error
      }
    })
    this.pending.set(key, result)
    void result.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key) }).catch(() => undefined)
    return result
  }

  /**
   * Read one committed document and verify its stored digest and length.
   * @param sessionId - owning Session identity.
   * @param id - opaque document identity.
   * @returns metadata beside the verified bytes.
   */
  async read(sessionId: string, id: string): Promise<{ document: OfficeDocument; data: Uint8Array }> {
    if (!DOCUMENT_ID.test(id)) throw new Error('Office document id is invalid')
    const parent = await this.sessionDirectory(sessionId, false)
    if (parent === undefined || !await directory(join(parent, id), false)) throw new Error('Office document not found in this Session')
    const document = metadata(JSON.parse(new TextDecoder().decode(await boundedFile(join(parent, id, 'metadata.json'), 4096))), id, this.limits.maxDocumentBytes)
    const data = await boundedFile(join(parent, id, 'content'), this.limits.maxDocumentBytes)
    if (data.byteLength !== document.bytes || createHash('sha256').update(data).digest('hex') !== document.sha256) {
      throw new Error('Office document integrity verification failed')
    }
    return { document, data }
  }

  /**
   * List metadata committed for one Session without reading document content.
   * @param sessionId - owning Session identity.
   * @returns complete bounded metadata in creation order.
   */
  async list(sessionId: string): Promise<OfficeDocument[]> {
    const parent = await this.sessionDirectory(sessionId, false)
    if (parent === undefined) return []
    const ids = (await readdir(parent)).filter(entry => DOCUMENT_ID.test(entry))
    if (ids.length > this.limits.maxDocumentsPerSession) throw new Error('Office document count exceeds its limit')
    const rows: OfficeDocument[] = []
    for (const id of ids) {
      if (!await directory(join(parent, id), false)) continue
      const bytes = await boundedFile(join(parent, id, 'metadata.json'), 4096).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (bytes !== undefined) rows.push(metadata(JSON.parse(new TextDecoder().decode(bytes)), id, this.limits.maxDocumentBytes))
    }
    return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
}
