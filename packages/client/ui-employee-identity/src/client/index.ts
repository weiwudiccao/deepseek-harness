/** Authenticated employee identity at the Web sidebar foot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EmployeeIdentityRow } from './EmployeeIdentityRow.tsx'
import { en, NS, zh } from './locales.ts'

export type { EmployeeIdentityRowProps } from './EmployeeIdentityRow.tsx'
export type { EmployeeIdentity } from './identity.ts'
export { parseEmployeeIdentity, readEmployeeIdentity } from './identity.ts'
export type { EmployeeIdentityKey } from './locales.ts'

/** Services required by the employee identity occupant. */
export const inject = ['slots', 'locale']

/** Register dictionaries and replace the direct Settings trigger with the employee account menu. */
export function apply(ctx: ClientContext): void {
  if ((window as Window & { qifuDesktop?: unknown }).qifuDesktop === undefined) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-employee-identity: dictionaries')
  ctx.slots.inject('settings.account', () => ctx.slots.register({
    name: 'settings.account',
    locale: NS,
  }, EmployeeIdentityRow))
}
