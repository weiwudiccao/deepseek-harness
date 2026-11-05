import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { installBrowserHost } from '../src/browser-host.ts'

const { run, dispose } = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn(async () => undefined) }))
vi.mock('../src/browser-runner.ts', () => ({ BrowserRunner: class { run = run; dispose = dispose } }))

const options = { timeoutMs: 30_000, maxDomBytes: 1024, maxConcurrentOperations: 1 }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function fixture() {
  const tools = new Map<string, ToolDefinition>()
  const removers: (() => unknown)[] = []
  const ctx = {
    tools: {
      register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      guard: vi.fn(() => () => undefined),
    },
    systemPrompt: { section: vi.fn(), getSectionOrder: () => 100 },
    effect: (factory: () => unknown) => { removers.push(factory() as () => unknown) },
  } as unknown as Context
  installBrowserHost(ctx, options)
  return { ctx, tools, dispose: async () => { for (const remove of removers.reverse()) await remove() } }
}
function execution(): ToolRunContext {
  return { signal: new AbortController().signal, agent: { session: { id: SessionId('employee-session') } } } as ToolRunContext
}

describe('Qifu background browser Host', () => {
  it('enables browser services independently from Office only with an explicit desktop opt-in', () => {
    vi.stubEnv('QIFUAI_OFFICE_ENABLED', 'false')
    vi.stubEnv('QIFUAI_BROWSER_TEST_ENABLED', 'true')
    const inject = vi.fn()
    apply({ inject } as unknown as Context)
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0]).toEqual(['tools', 'systemPrompt'])
    expect(() => { apply({ inject } as unknown as Context, { browserTimeoutMs: 0 }) }).toThrow(/positive integer/u)
    expect(() => { apply({ inject } as unknown as Context, { browserTimeoutMs: 30_001 }) }).toThrow(/cannot exceed/u)
    expect(() => { apply({ inject } as unknown as Context, { browserMaxDomBytes: 1024 * 1024 + 1 }) }).toThrow(/cannot exceed/u)
    vi.stubEnv('QIFUAI_BROWSER_TEST_ENABLED', 'yes')
    expect(() => { apply({ inject } as unknown as Context) }).toThrow(/true or false/u)
  })

  it('requires an owning Session and returns DOM evidence without shell or file-policy arguments', async () => {
    const f = fixture()
    const tool = f.tools.get('browser_test')
    if (tool === undefined) throw new Error('Browser tool not registered')
    const exec = execution()
    run.mockResolvedValueOnce({ url: 'http://127.0.0.1:3000/', dom: '<p>ready</p>', domTruncated: false })
    expect(await tool.execute({ url: 'http://127.0.0.1:3000/' }, exec)).toEqual({ url: 'http://127.0.0.1:3000/', dom: '<p>ready</p>', domTruncated: false })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:3000/', signal: exec.signal }))
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('sandboxPolicy')
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['url'])
    await expect(tool.execute({ url: 'https://example.invalid/' }, { signal: exec.signal } as ToolRunContext)).rejects.toThrow(/Session/u)
    await f.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(f.tools.size).toBe(0)
  })

  it('rejects overlapping work and releases its slot when an invocation settles', async () => {
    const f = fixture()
    const tool = f.tools.get('browser_test')
    if (tool === undefined) throw new Error('Browser tool not registered')
    let finish: (() => void) | undefined
    run.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = tool.execute({ url: 'https://example.invalid/' }, execution())
    await expect(tool.execute({ url: 'https://example.invalid/' }, execution())).rejects.toThrow(/BROWSER_BUSY/u)
    if (finish === undefined) throw new Error('Browser did not start')
    finish()
    await first
    run.mockResolvedValueOnce({ dom: 'ready' })
    await expect(tool.execute({ url: 'https://example.invalid/' }, execution())).resolves.toEqual({ dom: 'ready' })
    await f.dispose()
  })
})
