// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OfficeDocuments, type OfficeDocumentsProps } from '../src/client/OfficeDocuments.tsx'
import { apply } from '../src/client/index.ts'
import type { OfficeDocumentsInjected } from '../src/client/OfficeDocuments.tsx'
import { zh, type QifuWorkSurfaceKey } from '../src/client/locales.ts'

const document = { id: 'doc-1', name: '季度报告.xlsx', format: 'xlsx', kind: 'original', bytes: 100, sha256: 'a'.repeat(64), createdAt: '2026-11-03' }
const t = ((key: QifuWorkSurfaceKey, parameters?: Record<string, unknown>) => {
  let text = zh[key]
  for (const [name, value] of Object.entries(parameters ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}) as OfficeDocumentsProps['t']

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'qifuDesktop')
})

function bench(overrides: Partial<OfficeDocumentsProps> = {}) {
  const request = vi.fn(async (endpoint: string): Promise<unknown> => endpoint === 'list' ? { documents: [] } : { document })
  const appendReference = vi.fn(() => true)
  const registerFileIntake = vi.fn(() => () => undefined)
  const props = {
    sessionId: 'session-1', useSession: (select: (state: { running: boolean; removed: boolean }) => unknown) => select({ running: false, removed: false }),
    input: { phase: 'plain' }, request, appendReference, registerFileIntake, t,
    ...overrides,
  } as unknown as OfficeDocumentsProps
  const view = render(<OfficeDocuments {...props} />)
  const open = () => { fireEvent.click(screen.getByRole('button', { name: '办公文件' })) }
  return { props, request, appendReference, registerFileIntake, view, open }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Qifu office document intake', () => {
  it('shows office files and session-authorized downloads without executing HTML', async () => {
    const request = vi.fn(async () => ({ documents: [{ ...document, id: 'id &?', name: '<script>.html', format: 'html' }] }))
    const test = bench({ request })
    test.open()
    expect(await screen.findByText('<script>.html')).toBeTruthy()
    const link = screen.getByRole('link', { name: '下载 <script>.html' })
    expect(link.getAttribute('href')).toBe('/api/qifu.office.download?sessionId=session-1&documentId=id+%26%3F')
    expect(link.getAttribute('download')).toBe('<script>.html')
    expect(screen.getByLabelText('选择办公文件').getAttribute('accept')).toContain('.pptx')
    expect(screen.getByLabelText('选择办公文件').getAttribute('accept')).toContain('.xlsx')
    expect(test.view.container.querySelector('iframe')).toBeNull()
  })

  it('imports file bytes then appends a document reference without submitting a message', async () => {
    const test = bench()
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['office bytes'], '季度报告.xlsx')] } })
    await waitFor(() => { expect(test.appendReference).toHaveBeenCalledWith('办公文档：季度报告.xlsx（文档 ID：doc-1）') })
    expect(test.request).toHaveBeenCalledWith('import', { sessionId: 'session-1', name: '季度报告.xlsx', data: 'b2ZmaWNlIGJ5dGVz' }, expect.any(AbortSignal))
    expect(screen.getByRole('status').textContent).toContain('已加入当前草稿')
  })

  it('imports dropped office files in order without opening the document panel', async () => {
    let intake: ((files: readonly File[]) => void) | undefined
    const unregister = vi.fn()
    const documents: unknown[] = []
    const request = vi.fn(async (endpoint: string, payload: { name?: string }) => {
      if (endpoint === 'list') return { documents }
      const imported = { ...document, id: payload.name, name: payload.name }
      documents.push(imported)
      return { document: imported }
    })
    const test = bench({ request, registerFileIntake: (handler) => { intake = handler; return unregister } })
    expect(intake).toBeDefined()
    act(() => { intake?.([new File(['a'], 'one.xlsx'), new File(['b'], 'two.xlsx')]) })
    await waitFor(() => { expect(test.appendReference).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('dialog', { name: '当前会话办公文件' })).toBeNull()
    expect(screen.getByRole('button', { name: '办公文件' }).getAttribute('aria-expanded')).toBe('false')
    expect(request.mock.calls.filter(call => call[0] === 'import').map(call => call[1].name)).toEqual(['one.xlsx', 'two.xlsx'])
    test.open()
    expect(await screen.findByText('one.xlsx')).toBeTruthy()
    expect(await screen.findByText('two.xlsx')).toBeTruthy()
    test.view.unmount()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('keeps a dropped unsupported file out of the image path and explains conversion', async () => {
    let intake: ((files: readonly File[]) => void) | undefined
    const test = bench({ registerFileIntake: (handler) => { intake = handler; return () => undefined } })
    act(() => { intake?.([new File(['legacy'], 'old.ppt')]) })
    expect((await screen.findByRole('alert')).textContent).toContain('请转换为 DOCX')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(test.request.mock.calls.some(call => call[0] === 'import')).toBe(false)
    expect(test.appendReference).not.toHaveBeenCalled()
  })

  it('refuses concurrent drops instead of silently discarding files', async () => {
    let intake: ((files: readonly File[]) => void) | undefined
    const pending = deferred<unknown>()
    const request = vi.fn(async (endpoint: string) => endpoint === 'list' ? { documents: [] } : pending.promise)
    bench({ request, registerFileIntake: (handler) => { intake = handler; return () => undefined } })
    act(() => { intake?.([new File(['a'], 'one.xlsx')]) })
    await waitFor(() => { expect(request.mock.calls.some(call => call[0] === 'import')).toBe(true) })
    act(() => { intake?.([new File(['b'], 'two.xlsx')]) })
    expect((await screen.findByRole('alert')).textContent).toContain('当前正在处理其他办公文件')
    expect(request.mock.calls.filter(call => call[0] === 'import')).toHaveLength(1)
    await act(async () => { pending.resolve({ document }) })
    expect(screen.getByRole('alert').textContent).toContain('当前正在处理其他办公文件')
  })

  it.each(['oversized', 'failed'])('shows a %s drop error without opening the panel', async (kind) => {
    let intake: ((files: readonly File[]) => void) | undefined
    const request = vi.fn(async () => { throw new Error('文件已损坏') })
    const test = bench({ request, registerFileIntake: (handler) => { intake = handler; return () => undefined } })
    const file = new File(['bytes'], 'report.xlsx')
    if (kind === 'oversized') Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 })
    act(() => { intake?.([file]) })
    expect((await screen.findByRole('alert')).textContent).toContain(kind === 'oversized' ? '25 MiB' : '文件已损坏')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(test.appendReference).not.toHaveBeenCalled()
  })

  it('keeps a manually closed panel closed when an import finishes', async () => {
    const pending = deferred<unknown>()
    const request = vi.fn(async (endpoint: string) => endpoint === 'list' ? { documents: [] } : pending.promise)
    const test = bench({ request })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], 'report.xlsx')] } })
    await waitFor(() => { expect(request.mock.calls.some(call => call[0] === 'import')).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await act(async () => { pending.resolve({ document }) })
    expect(test.appendReference).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retains an imported document when the composer cannot accept a reference yet', async () => {
    const test = bench({ appendReference: vi.fn(() => false) })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], '季度报告.xlsx')] } })
    await screen.findByText('季度报告.xlsx')
    expect(screen.getByRole('status').textContent).toContain('上传完成')
    expect(screen.getByRole('button', { name: '引用 季度报告.xlsx' })).toBeTruthy()
  })

  it('rejects unsupported and oversized files before reading or uploading them', async () => {
    const test = bench()
    test.open()
    const input = screen.getByLabelText('选择办公文件')
    fireEvent.change(input, { target: { files: [new File(['bytes'], 'old.ppt')] } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '此格式暂不支持，请转换为 DOCX、XLSX、PPTX、PDF 或其他受支持格式。')
    const large = new File(['bytes'], 'large.pdf')
    Object.defineProperty(large, 'size', { value: 25 * 1024 * 1024 + 1 })
    fireEvent.change(input, { target: { files: [large] } })
    expect(screen.getByRole('alert').textContent).toBe('单个办公文件不能超过 25 MiB。')
    expect(test.request.mock.calls.some(call => call[0] === 'import')).toBe(false)
  })

  it('aborts an unmounted import and ignores a late successful response', async () => {
    const pending = deferred<unknown>()
    let uploadSignal: AbortSignal | undefined
    const request = vi.fn(async (endpoint: string, _payload: unknown, signal: AbortSignal) => {
      if (endpoint === 'list') return { documents: [] }
      uploadSignal = signal
      return pending.promise
    })
    const test = bench({ request })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], 'report.pdf')] } })
    await waitFor(() => { expect(uploadSignal).toBeDefined() })
    test.view.unmount()
    expect(uploadSignal?.aborted).toBe(true)
    await act(async () => { pending.resolve({ document }) })
    expect(test.appendReference).not.toHaveBeenCalled()
  })

  it('does not put a previous session import into the next session', async () => {
    const pending = deferred<unknown>()
    const request = vi.fn(async (endpoint: string) => endpoint === 'list' ? { documents: [] } : pending.promise)
    const test = bench({ request })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], 'report.pdf')] } })
    await waitFor(() => { expect(request.mock.calls.some(call => call[0] === 'import')).toBe(true) })
    test.view.rerender(<OfficeDocuments {...test.props} sessionId={'session-2' as OfficeDocumentsProps['sessionId']} />)
    await act(async () => { pending.resolve({ document }) })
    expect(test.appendReference).not.toHaveBeenCalled()
    expect(screen.queryByText('季度报告.xlsx')).toBeNull()
  })

  it('keeps an import failure visible and does not append a reference', async () => {
    const request = vi.fn(async (endpoint: string) => {
      if (endpoint === 'list') return { documents: [] }
      throw new Error('文件已损坏')
    })
    const test = bench({ request })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], 'report.pdf')] } })
    expect((await screen.findByRole('alert')).textContent).toContain('文件已损坏')
    expect(test.appendReference).not.toHaveBeenCalled()
  })

  it.each([
    ['OFFICE_PDF_TEXT_REQUIRED', '此 PDF 没有可提取的文字，可能是扫描件。请先进行 OCR 文字识别，再重新导入。'],
    ['OFFICE_BUSY', '当前正在处理其他办公文件，请稍后重试。'],
  ])('explains %s without showing an internal error code', async (code, message) => {
    const request = vi.fn(async (endpoint: string) => {
      if (endpoint === 'list') return { documents: [] }
      throw new Error(code)
    })
    const test = bench({ request })
    test.open()
    fireEvent.change(screen.getByLabelText('选择办公文件'), { target: { files: [new File(['bytes'], 'report.pdf')] } })
    const error = await screen.findByRole('alert')
    expect(error.textContent).toBe(`办公文件导入失败：${message}`)
    expect(error.textContent).not.toContain(code)
    expect(test.appendReference).not.toHaveBeenCalled()
  })

  it('refreshes generated documents when a running turn finishes', async () => {
    let running = true
    const request = vi.fn(async () => ({ documents: running ? [] : [document] }))
    const useSession = ((select: (value: { running: boolean; removed: boolean }) => unknown) => select({ running, removed: false })) as OfficeDocumentsProps['useSession']
    const test = bench({ request, useSession })
    test.open()
    await screen.findByText('当前会话暂无办公文件')
    running = false
    test.view.rerender(<OfficeDocuments {...test.props} />)
    expect(await screen.findByText('季度报告.xlsx')).toBeTruthy()
  })
})


describe('Qifu office composer registration', () => {
  it('reads the latest draft when an import completes and keeps the Session binding fixed', () => {
    const registrations: { name: string; inject?: (id: string) => OfficeDocumentsInjected }[] = []
    let draft = 'first draft'
    let phase = 'plain'
    const setDraft = vi.fn((text: string) => { draft = text })
    const binding = { ctx: { session: 'session-1' }, session: { getSnapshot: () => ({ removed: false }) } }
    const resolveBinding = vi.fn(() => binding)
    const registerFileIntake = vi.fn(() => () => undefined)
    const rpc = vi.fn(async () => ({ ok: true, value: { documents: [] } }))
    const ctx = {
      effect: (effect: () => unknown) => effect(),
      locale: { register: () => () => undefined, bind: () => t },
      slots: {
        inject: (_name: string, effect: () => unknown) => effect(),
        register: (spec: typeof registrations[number]) => { registrations.push(spec); return () => undefined },
      },
      sessions: { list: {}, binding: resolveBinding },
      get: () => ({ rpc: { call: rpc } }),
      conversation: { registerFileIntake, input: { for: () => ({ state: { getSnapshot: () => ({ draft, phase }) }, setDraft }) } },
    } as unknown as Parameters<typeof apply>[0]
    Object.defineProperty(window, 'qifuDesktop', { configurable: true, value: {} })
    apply(ctx)
    const registration = registrations.find(item => item.name === 'conversation.input.left')
    expect(registration).toBeDefined()
    const actions = registration?.inject?.('session-1')
    const receive = () => undefined
    actions?.registerFileIntake(receive)
    expect(registerFileIntake).toHaveBeenCalledWith('session-1', receive)
    draft = 'text typed while uploading'
    expect(actions?.appendReference('office reference')).toBe(true)
    expect(setDraft).toHaveBeenLastCalledWith('text typed while uploading\noffice reference\n')
    expect(resolveBinding).toHaveBeenCalledWith('session-1')
    phase = 'submitting'
    expect(actions?.appendReference('must wait')).toBe(false)
    expect(setDraft).toHaveBeenCalledTimes(1)
  })
})
