import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as QifuAccountContext from '@deepseek-ai/dsh-qifu-account-context'
import * as QifuAccountContextInvariant from '@deepseek-ai/dsh-qifu-account-context/invariant'

const CONFIG = {
  endpointEnv: 'QIFU_TEST_CONTEXT_URL',
  tokenEnv: 'QIFU_TEST_CONTEXT_TOKEN',
  localContextEnv: 'QIFU_TEST_CONTEXT_LOCAL',
  timeoutMs: 5_000,
  maxResponseBytes: 16_384,
}

beforeEach(() => {
  process.env['QIFU_TEST_CONTEXT_URL'] = 'https://gateway.example/qifu/v1/personalization/context'
  process.env['QIFU_TEST_CONTEXT_TOKEN'] = 'employee-session-token'
  process.env['QIFU_TEST_CONTEXT_LOCAL'] = 'true'
})

afterEach(() => {
  delete process.env['QIFU_TEST_CONTEXT_URL']
  delete process.env['QIFU_TEST_CONTEXT_TOKEN']
  delete process.env['QIFU_TEST_CONTEXT_LOCAL']
  vi.restoreAllMocks()
})

function sessionAgent(session: Session): Agent {
  return {
    id: SessionId('qifu-account-context-agent'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('qifu-account-context appends through pre-step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function prepare(ctx: Context, step = 1) {
  const session = Session.create(SessionId(`qifu-context-${String(step)}`))
  const message = createUserMessage({
    content: [{ type: 'text', text: '请按我的偏好分析本轮任务' }],
    source: { kind: 'user' },
  })
  return agentEvents(ctx, sessionAgent(session)).waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
}

describe('Qifu account context', () => {
  it('injects consent-filtered profile and memory as one sourced first-step snapshot', async () => {
    const request = vi.fn<typeof fetch>(async (_input, _init) => new Response(JSON.stringify({
      snapshot_id: 'ctx_abc123',
      sections: [
        { name: 'qifu-employee-profile', text: '姓名：员工甲\n岗位：产品经理' },
        { name: 'qifu-account-memory', text: '偏好：回答先给结论' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', request)
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(QifuAccountContext, CONFIG)

    const decision = await prepare(ctx)

    expect(request).toHaveBeenCalledOnce()
    const requestInput = request.mock.calls[0]?.[0]
    const requestUrl = requestInput instanceof Request
      ? requestInput.url
      : requestInput instanceof URL ? requestInput.href : requestInput
    expect(requestUrl).toBe(process.env['QIFU_TEST_CONTEXT_URL'])
    const init = request.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({ authorization: 'Bearer employee-session-token' })
    const requestBody = init?.body
    expect(typeof requestBody).toBe('string')
    if (typeof requestBody !== 'string') throw new Error('request body was not JSON text')
    expect(JSON.parse(requestBody)).toEqual({
      local_context: true,
      message: '请按我的偏好分析本轮任务',
    })
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('request was rejected')
    expect(decision.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '姓名：员工甲\n岗位：产品经理\n\n偏好：回答先给结论' }],
      source: {
        kind: 'plugin',
        plugin: 'qifu-account-context',
        form: 'snapshot',
        sections: [
          { name: 'qifu-employee-profile@ctx_abc123', text: '姓名：员工甲\n岗位：产品经理' },
          { name: 'qifu-account-memory@ctx_abc123', text: '偏好：回答先给结论' },
        ],
      },
    })
  })

  it('does not request account context after the first step', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(QifuAccountContext, CONFIG)

    const decision = await prepare(ctx, 2)

    expect(decision.kind).toBe('enter')
    expect(request).not.toHaveBeenCalled()
  })

  it('fails open when the optional gateway context is unavailable or oversized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(100), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    })))
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(QifuAccountContext, { ...CONFIG, maxResponseBytes: 16 })

    const decision = await prepare(ctx)

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('request was rejected')
    expect(decision.messages).toHaveLength(1)
  })

  it('rejects missing, non-HTTPS, and ambiguous deployment configuration at load', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    delete process.env['QIFU_TEST_CONTEXT_TOKEN']
    await expect(ctx.plugin(QifuAccountContext, CONFIG)).rejects.toThrow(/required environment variable/u)

    process.env['QIFU_TEST_CONTEXT_TOKEN'] = 'employee-session-token'
    process.env['QIFU_TEST_CONTEXT_URL'] = 'http://gateway.example/context'
    await expect(ctx.plugin(QifuAccountContext, CONFIG)).rejects.toThrow(/must use HTTPS/u)

    process.env['QIFU_TEST_CONTEXT_URL'] = 'https://gateway.example/context'
    process.env['QIFU_TEST_CONTEXT_LOCAL'] = 'sometimes'
    await expect(ctx.plugin(QifuAccountContext, CONFIG)).rejects.toThrow(/must be true or false/u)
  })
})

describe('Qifu account-context invariant', () => {
  it('accepts exact snapshot reconstruction and rejects altered model-visible text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(QifuAccountContextInvariant)
    const session = Session.create(SessionId('qifu-context-invariant'))
    const source = {
      kind: 'plugin' as const,
      plugin: 'qifu-account-context',
      form: 'snapshot' as const,
      sections: [{ name: 'qifu-account-memory@ctx_abc123', text: '回答先给结论' }],
    }

    expect(() => {
      ctx.emit('session/event', session, {
        type: 'user/message', seq: 1, time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: '回答先给结论' }], source }),
      })
    }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'user/message', seq: 2, time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: '内容被修改' }], source }),
      })
    }).toThrow(/exactly reconstruct/u)
  })
})
