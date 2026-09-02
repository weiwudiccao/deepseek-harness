// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { EmployeeIdentityRow } from '../src/client/EmployeeIdentityRow.tsx'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  const declareSeat = () => slots.register({
    name: 'root',
    children: { 'settings.account': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  const disposeSeat = declare ? declareSeat() : undefined
  return { ctx, slots, declareSeat, disposeSeat }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'qifuDesktop')
})

describe('employee identity browser plugin', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('leaves the ordinary Web settings trigger unchanged', async () => {
    const ordinary = await bench()
    await ordinary.ctx.plugin({ inject: [...inject], apply }).await()
    expect(ordinary.slots.entries('settings.account')).toHaveLength(0)
  })

  it('fills declarations before or after apply and tears down with its fiber', async () => {
    Object.defineProperty(window, 'qifuDesktop', { configurable: true, value: { gatewayRequest: vi.fn() } })
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(before.slots.entries('settings.account')[0]?.component).toBe(EmployeeIdentityRow)

    before.disposeSeat?.()
    expect(before.slots.entries('settings.account')).toHaveLength(0)
    before.declareSeat()
    await Promise.resolve()
    expect(before.slots.entries('settings.account')).toHaveLength(1)
    await fiber.dispose()
    expect(before.slots.entries('settings.account')).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.account')).toHaveLength(0)
    after.declareSeat()
    await Promise.resolve()
    expect(after.slots.entries('settings.account')[0]?.component).toBe(EmployeeIdentityRow)
  })
})
