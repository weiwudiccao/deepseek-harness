// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PersonalizationSection, type PersonalizationSectionProps } from '../src/client/PersonalizationSection.tsx'
import { QifuWorkSurface, type QifuWorkSurfaceProps } from '../src/client/QifuWorkSurface.tsx'
import { apply } from '../src/client/index.ts'
import { zh, type QifuWorkSurfaceKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'qifuDesktop')
})

const t = ((key: QifuWorkSurfaceKey) => zh[key]) as QifuWorkSurfaceProps['t']
const sessionSnapshot = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }
const sessionList = {
  getSnapshot: () => sessionSnapshot,
  subscribe: () => () => undefined,
} as unknown as QifuWorkSurfaceProps['sessionList']

function installDesktop(
  responses: Record<string, unknown>,
  mode: 'local' | 'cloud' = 'local',
) {
  const bridge = {
    gatewayRequest: vi.fn(async (path: string) => ({ status: 200, body: responses[path] })),
    runtimeInfo: vi.fn(async () => ({ mode })),
    switchRuntime: vi.fn(async () => ({ ok: true })),
    openFeature: vi.fn(async () => ({ ok: true })),
    syncFile: vi.fn(async () => ({ ok: true })),
    syncSession: vi.fn(async () => ({ ok: true })),
    downloadCloudItem: vi.fn(async () => ({ ok: true })),
  }
  Object.defineProperty(window, 'qifuDesktop', { configurable: true, value: bridge })
  return bridge
}

describe('Qifu employee sidebar composition', () => {
  it('does not register Qifu employee surfaces outside the desktop client', () => {
    const ctx = { effect: vi.fn() } as unknown as Parameters<typeof apply>[0]
    apply(ctx)
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('renders only gateway-authorized apps and separates cloud from local work', async () => {
    const bridge = installDesktop({
      '/qifu/v1/bootstrap': {
        features: [{
          feature_code: 'digital-employee-b1', label: '智剪工坊', icon: 'bot', icon_color: 'blue',
          route_type: 'Digital Employee', route: '/qifu/apps/digital-employees/b1', digital_employee: 'b1',
        }],
      },
      '/qifu/v1/cloud/items?limit=50': {
        items: [{
          id: 'cwi-1', kind: 'Conversation', title: '云端方案讨论', summary: '', status: 'Ready',
          version: 2, downloadable: true, modified: '',
        }],
      },
    })
    render(<QifuWorkSurface {...({ wide: true, workspaces: <div>本机会话甲</div>, sessionList, t } as QifuWorkSurfaceProps)} />)

    await screen.findByText('智剪工坊')
    expect(screen.getByText('功能')).toBeTruthy()
    expect(screen.getByText('云端工作')).toBeTruthy()
    expect(screen.getByText('本机内容')).toBeTruthy()
    expect(screen.getByText('云端方案讨论')).toBeTruthy()
    expect(screen.getByText('本机会话甲')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /智剪工坊/u }))
    expect(bridge.openFeature).toHaveBeenCalledWith(expect.objectContaining({ feature_code: 'digital-employee-b1' }))
    fireEvent.click(screen.getByRole('button', { name: '下载到本机 云端方案讨论' }))
    expect(bridge.downloadCloudItem).toHaveBeenCalledWith('cwi-1', '云端方案讨论')
  })

  it('switches from cloud mode to the device runtime only after an explicit click', async () => {
    const bridge = installDesktop({
      '/qifu/v1/bootstrap': { features: [] },
      '/qifu/v1/cloud/items?limit=50': { items: [] },
    }, 'cloud')
    render(<QifuWorkSurface {...({ wide: true, workspaces: <div>云端会话树</div>, sessionList, t } as QifuWorkSurfaceProps)} />)

    const action = await screen.findByRole('button', { name: '切换到本机内容' })
    expect(bridge.switchRuntime).not.toHaveBeenCalled()
    fireEvent.click(action)
    expect(bridge.switchRuntime).toHaveBeenCalledWith('local')
  })
})

describe('Qifu personalization settings', () => {
  it('starts disabled and persists an employee opt-in through the gateway', async () => {
    const initial = {
      work_profile_read: false,
      memory_read: false,
      memory_write: false,
      local_context_read: false,
      policy_version: '2026-09-02-v1',
    }
    const bridge = installDesktop({
      '/qifu/v1/personalization': { consent: initial },
    })
    bridge.gatewayRequest.mockImplementation(async (_path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST') return { status: 200, body: { consent: init.body } }
      return { status: 200, body: { consent: initial } }
    })
    render(<PersonalizationSection {...({ t } as PersonalizationSectionProps)} />)

    const toggle = await screen.findByRole('checkbox', { name: /读取云端记忆/u })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => { expect(screen.getByText('设置已保存')).toBeTruthy() })
    expect(bridge.gatewayRequest).toHaveBeenCalledWith('/qifu/v1/personalization', {
      method: 'POST',
      body: { ...initial, memory_read: true },
    })
  })

  it('lets the employee confirm or delete only their projected memories', async () => {
    const initial = {
      work_profile_read: true,
      memory_read: true,
      memory_write: true,
      local_context_read: true,
      policy_version: '2026-09-02-v1',
    }
    const bridge = installDesktop({
      '/qifu/v1/personalization': {
        consent: initial,
        memory_items: [
          { id: 'mem-1', category: 'Role Focus', value: '优先处理产品方案', status: 'Proposed' },
          { id: 'mem-2', category: 'Active Topic', value: '正在推进客户端', status: 'Active' },
        ],
      },
    })
    bridge.gatewayRequest.mockImplementation(async (path: string) => {
      if (path === '/qifu/v1/personalization') {
        return {
          status: 200,
          body: {
            consent: initial,
            memory_items: [
              { id: 'mem-1', value: '优先处理产品方案', status: 'Proposed' },
              { id: 'mem-2', value: '正在推进客户端', status: 'Active' },
            ],
          },
        }
      }
      return { status: 200, body: { ok: true } }
    })
    render(<PersonalizationSection {...({ t } as PersonalizationSectionProps)} />)

    fireEvent.click(await screen.findByRole('button', { name: '确认记忆 优先处理产品方案' }))
    await waitFor(() => {
      expect(bridge.gatewayRequest).toHaveBeenCalledWith('/qifu/v1/personalization/memory/confirm', {
        method: 'POST', body: { memory_id: 'mem-1' },
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '删除记忆 正在推进客户端' }))
    await waitFor(() => {
      expect(bridge.gatewayRequest).toHaveBeenCalledWith('/qifu/v1/personalization/memory/forget', {
        method: 'POST', body: { memory_id: 'mem-2' },
      })
    })
  })
})
