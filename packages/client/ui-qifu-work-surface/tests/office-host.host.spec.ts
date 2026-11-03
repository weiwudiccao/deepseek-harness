import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionFetchRoute, ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { installOfficeHost } from '../src/office-host.ts'
import { readOffice } from '../src/office-engine.ts'

vi.mock('../src/office-engine.ts', () => ({
  readOffice: vi.fn(async (data: Uint8Array) => {
    const text = new TextDecoder().decode(data)
    if (text === 'corrupt') throw new Error('Invalid Office document')
    return text
  }),
  createOffice: vi.fn(async (markdown: string) => new TextEncoder().encode(markdown)),
}))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function fixture(maxConcurrentOperations = 2, maxDocumentBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'qifu-office-host-'))
  roots.push(root)
  const tools = new Map<string, ToolDefinition>()
  let rpc: ConnectionRpcHandler | undefined
  let route: ConnectionFetchRoute | undefined
  const removers: (() => unknown)[] = []
  const ctx = {
    connection: {
      rpc: { handle: vi.fn((_path: string, handler: ConnectionRpcHandler) => { rpc = handler; return async () => { rpc = undefined } }) },
      fetch: { register: vi.fn((value: ConnectionFetchRoute) => { route = value; return async () => { route = undefined } }) },
    },
    sessionController: { resolveAgent: vi.fn(async (id: string) => id === 'a' || id === 'b'
      ? { agent: { session: { id: SessionId(id) } } }
      : { error: { code: 'session/not-found', message: 'Session not found' } }) },
    tools: { register: vi.fn((tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } }) },
    systemPrompt: { section: vi.fn(() => () => undefined), getSectionOrder: vi.fn(() => 80) },
    effect: (factory: () => unknown) => { removers.push(factory() as () => unknown) },
  } as unknown as Context
  installOfficeHost(ctx, {
    dshHome: root, maxDocumentBytes, maxTextBytes: 100, maxDocumentsPerSession: 100, maxReadLines: 3, maxConcurrentOperations,
  })
  return {
    ctx, tools,
    call: (endpoint: string, value: unknown, signal = new AbortController().signal) => {
      if (rpc === undefined) throw new Error('Office RPC not registered')
      return rpc(endpoint, value, signal)
    },
    download: (query: string) => {
      if (route === undefined) throw new Error('Office download not registered')
      return route.fetch(new Request(`http://127.0.0.1${route.path}?${query}`))
    },
    dispose: async () => { for (const remove of removers.reverse()) await remove() },
    hasRpc: () => rpc !== undefined,
  }
}
function exec(id = 'a'): ToolRunContext {
  return { signal: new AbortController().signal, agent: { session: { id: SessionId(id) } } } as ToolRunContext
}
function documentId(value: unknown): string {
  const row = value as { ok: true; value: { document: { id: string } } }
  expect(row.ok).toBe(true)
  return row.value.document.id
}

describe('Qifu Office host', () => {
  it('is disabled in generic profiles unless its configured environment opt-in is true', () => {
    const inject = vi.fn()
    const ctx = { inject } as unknown as Context
    apply(ctx, { enabledEnv: 'QIFU_TEST_OFFICE_ENABLED' })
    expect(inject).not.toHaveBeenCalled()
  })

  it('rejects deployment document limits above the client ceiling', () => {
    vi.stubEnv('QIFU_TEST_OFFICE_ENABLED', 'true')
    const inject = vi.fn()
    const ctx = { inject } as unknown as Context
    expect(() => {
      apply(ctx, { enabledEnv: 'QIFU_TEST_OFFICE_ENABLED', maxDocumentBytes: 26 * 1024 * 1024 })
    }).toThrow(/cannot exceed 25 MiB/u)
    expect(inject).not.toHaveBeenCalled()
    apply(ctx, { enabledEnv: 'QIFU_TEST_OFFICE_ENABLED', maxDocumentBytes: 1024 })
    expect(inject).toHaveBeenCalledOnce()
  })

  it('imports, pages, creates, lists, and downloads only the owning Session files', async () => {
    const f = await fixture()
    const imported = await f.call('import', { sessionId: 'a', name: 'plan.txt', data: Buffer.from('一\n二\n三\n四').toString('base64') })
    const id = documentId(imported)
    expect(await f.call('list', { sessionId: 'b' })).toEqual({ ok: true, value: { documents: [] } })
    const read = f.tools.get('office_read')
    if (read === undefined) throw new Error('office_read not registered')
    expect(await read.execute({ document_id: id, offset: 2, limit: 2 }, exec())).toMatchObject({ id, offset: 2, totalLines: 4, text: '二\n三' })
    await expect(read.execute({ document_id: id }, exec('b'))).rejects.toThrow(/not found/u)
    await expect(read.execute({ document_id: id, limit: 4 }, exec())).rejects.toThrow(/limit/u)
    const create = f.tools.get('office_create')
    if (create === undefined) throw new Error('office_create not registered')
    const generated = await create.execute({ name: 'plan.html', markdown: '# 计划', format: 'html' }, exec()) as { id: string }
    expect(generated.id).not.toBe(id)
    const response = await f.download(`sessionId=a&documentId=${id}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('一\n二\n三\n四')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await f.download(`sessionId=b&documentId=${id}`)).status).toBe(404)
    const listed = await f.call('list', { sessionId: 'a' })
    expect(listed).toMatchObject({
      ok: true, value: { documents: [expect.objectContaining({ id }), expect.objectContaining({ id: generated.id })] },
    })
  })

  it('imports and downloads a 20 MiB file through canonical base64 without overflowing the decoder', async () => {
    const f = await fixture(2, 25 * 1024 * 1024)
    const content = Buffer.alloc(20 * 1024 * 1024, 65)
    vi.mocked(readOffice).mockResolvedValueOnce('bounded extracted text')
    const imported = await f.call('import', { sessionId: 'a', name: 'large.pptx', data: content.toString('base64') })
    const id = documentId(imported)
    expect(imported).toMatchObject({
      ok: true, value: { document: { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') } },
    })
    const downloaded = await f.download(`sessionId=a&documentId=${id}`)
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(content)).toBe(true)
    await f.dispose()
  })

  it.each(['AB==', 'A===', 'AA=A', 'AA==AA==', 'AAAA\n'])('rejects malformed or noncanonical base64 %j', async (data) => {
    const f = await fixture()
    expect(await f.call('import', { sessionId: 'a', name: 'reference.txt', data })).toMatchObject({ ok: false })
    expect(await f.call('list', { sessionId: 'a' })).toMatchObject({ ok: true, value: { documents: [] } })
    await f.dispose()
  })

  it('rejects unknown Sessions, malformed uploads, corrupt input, and oversized text before publishing', async () => {
    const f = await fixture()
    const upload = { sessionId: 'a', name: 'plan.txt', data: Buffer.from('hello').toString('base64') }
    for (const value of [
      { ...upload, sessionId: 'unknown' }, { ...upload, name: '../outside.txt' },
      { ...upload, data: '!!!' }, { ...upload, data: Buffer.from('corrupt').toString('base64') },
      { ...upload, data: Buffer.from('x'.repeat(101)).toString('base64') },
    ]) expect(await f.call('import', value)).toMatchObject({ ok: false })
    expect(await f.call('list', { sessionId: 'a' })).toEqual({ ok: true, value: { documents: [] } })
    const create = f.tools.get('office_create')
    if (create === undefined) throw new Error('office_create not registered')
    await expect(create.execute({ name: 'plan.txt', format: 'html', markdown: 'text' }, exec())).rejects.toThrow(/format/u)
    await expect(create.execute({ name: 'plan.txt', format: 'txt', markdown: 'x'.repeat(101) }, exec())).rejects.toThrow(/size/u)
    expect((await f.download('sessionId=unknown&documentId=invalid')).status).toBe(404)
  })

  it('shares a bounded parser slot across import, read, and create and releases it after cancellation', async () => {
    const f = await fixture(1)
    const upload = { sessionId: 'a', name: 'reference.txt', data: Buffer.from('hello').toString('base64') }
    const id = documentId(await f.call('import', upload))
    const aborted = new AbortController()
    let started = false
    vi.mocked(readOffice).mockImplementationOnce((_data, _name, _limits, signal) => new Promise((_resolve, reject) => {
      started = true
      signal?.addEventListener('abort', () => { reject(new Error('Office fixture parsing cancelled')) }, { once: true })
    }))
    const pending = f.call('import', upload, aborted.signal)
    await vi.waitFor(() => { expect(started).toBe(true) })
    const busy = await f.call('import', upload)
    expect(busy.ok).toBe(false)
    if (busy.ok) throw new Error('Office parser admitted work above its limit')
    expect(busy.error.message).toContain('OFFICE_BUSY')
    const create = f.tools.get('office_create')
    const read = f.tools.get('office_read')
    if (create === undefined || read === undefined) throw new Error('Office tools not registered')
    await expect(create.execute({ name: 'new.txt', format: 'txt', markdown: 'hello' }, exec())).rejects.toThrow(/OFFICE_BUSY/u)
    await expect(read.execute({ document_id: id }, exec())).rejects.toThrow(/OFFICE_BUSY/u)
    aborted.abort(new Error('cancelled'))
    expect(await pending).toMatchObject({ ok: false })
    expect(await f.call('import', upload)).toMatchObject({ ok: true })
  })

  it('cancels active parsing and waits for its settlement when the Host unloads', async () => {
    const f = await fixture(1)
    let started = false
    vi.mocked(readOffice).mockImplementationOnce((_data, _name, _limits, signal) => new Promise((_resolve, reject) => {
      started = true
      signal?.addEventListener('abort', () => { reject(new Error('Office fixture parsing cancelled')) }, { once: true })
    }))
    const pending = f.call('import', { sessionId: 'a', name: 'reference.txt', data: Buffer.from('hello').toString('base64') })
    await vi.waitFor(() => { expect(started).toBe(true) })
    await f.dispose()
    expect(await pending).toMatchObject({ ok: false })
    expect(f.hasRpc()).toBe(false)
  })

  it('withdraws tools and transport registrations on disposal', async () => {
    const f = await fixture()
    expect(f.hasRpc()).toBe(true)
    expect(f.tools.size).toBe(2)
    await f.dispose()
    expect(f.hasRpc()).toBe(false)
    expect(f.tools.size).toBe(0)
  })
})
