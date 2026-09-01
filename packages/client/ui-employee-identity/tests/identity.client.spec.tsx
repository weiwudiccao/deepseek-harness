// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { EmployeeIdentityRow, type EmployeeIdentityRowProps } from '../src/client/EmployeeIdentityRow.tsx'
import { parseEmployeeIdentity } from '../src/client/identity.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t: EmployeeIdentityRowProps['t'] = (key) => {
  if (key === 'label') return '当前员工'
  if (key === 'designation.unset') return '未设置岗位'
  return key
}

describe('employee identity response', () => {
  it('validates and trims the gateway employee profile', () => {
    expect(parseEmployeeIdentity({
      ok: true,
      employee: { id: ' HR-EMP-0001 ', name: ' 员工甲 ', designation: ' 产品经理 ' },
    })).toEqual({ id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' })
    expect(parseEmployeeIdentity({ ok: true, employee: { name: '员工甲' } })).toBeUndefined()
    expect(parseEmployeeIdentity({ ok: false })).toBeUndefined()
  })
})

describe('employee identity row', () => {
  it('shows employee name and designation in the expanded sidebar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<EmployeeIdentityRow {...({ wide: true, t } as EmployeeIdentityRowProps)} />)

    await waitFor(() => { expect(screen.getByText('员工甲')).toBeTruthy() })
    expect(screen.getByText('产品经理')).toBeTruthy()
    expect(screen.getByLabelText('当前员工')).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/auth/session', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }))
  })

  it('keeps only the identity icon in the collapsed sidebar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      employee: { id: 'HR-EMP-0002', name: '员工乙', designation: '' },
    }), { status: 200 })))
    render(<EmployeeIdentityRow {...({ wide: false, t } as EmployeeIdentityRowProps)} />)

    await waitFor(() => { expect(screen.getByLabelText('当前员工')).toBeTruthy() })
    expect(screen.queryByText('员工乙')).toBeNull()
  })

  it('renders no identity row when the gateway profile is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const view = render(<EmployeeIdentityRow {...({ wide: true, t } as EmployeeIdentityRowProps)} />)
    await waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    expect(view.container.innerHTML).toBe('')
  })

  it('reports a gateway read failure while the row remains mounted', async () => {
    const error = new Error('network unavailable')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw error }))
    render(<EmployeeIdentityRow {...({ wide: true, t } as EmployeeIdentityRowProps)} />)

    await waitFor(() => {
      expect(report).toHaveBeenCalledWith(
        '[ui-employee-identity] reading the employee failed:', error,
      )
    })
    report.mockRestore()
  })

  it('suppresses a pending read failure after unmount', async () => {
    let reject: ((error: Error) => void) | undefined
    const pending = new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const view = render(<EmployeeIdentityRow {...({ wide: true, t } as EmployeeIdentityRowProps)} />)
    view.unmount()
    reject?.(new Error('cancelled request'))
    await Promise.resolve()
    expect(report).not.toHaveBeenCalled()
    report.mockRestore()
  })
})
