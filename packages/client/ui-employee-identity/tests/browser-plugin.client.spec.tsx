// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
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
    children: { 'sidebar.identity': { kind: 'single', scope: 'root' } },
  } as never, () => null)
  const disposeSeat = declare ? declareSeat() : undefined
  return { ctx, slots, declareSeat, disposeSeat }
}

describe('employee identity browser plugin', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('fills declarations before or after apply and tears down with its fiber', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(before.slots.entries('sidebar.identity')[0]?.component).toBe(EmployeeIdentityRow)

    before.disposeSeat?.()
    expect(before.slots.entries('sidebar.identity')).toHaveLength(0)
    before.declareSeat()
    await Promise.resolve()
    expect(before.slots.entries('sidebar.identity')).toHaveLength(1)
    await fiber.dispose()
    expect(before.slots.entries('sidebar.identity')).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('sidebar.identity')).toHaveLength(0)
    after.declareSeat()
    await Promise.resolve()
    expect(after.slots.entries('sidebar.identity')[0]?.component).toBe(EmployeeIdentityRow)
  })
})
