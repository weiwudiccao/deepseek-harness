/** Authenticated employee identity at the Web sidebar foot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EmployeeIdentityRow } from './EmployeeIdentityRow.tsx'
import { en, NS, zh } from './locales.ts'

export type { EmployeeIdentityRowProps } from './EmployeeIdentityRow.tsx'
export type { EmployeeIdentity } from './identity.ts'
export { parseEmployeeIdentity, readEmployeeIdentity } from './identity.ts'
export type { EmployeeIdentityKey } from './locales.ts'

/** Services required by the employee identity occupant. */
export const inject = ['slots', 'locale']

/** Register dictionaries and fill the sidebar's authenticated identity seat. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-employee-identity: dictionaries')
  ctx.slots.inject('sidebar.identity', () => ctx.slots.register({
    name: 'sidebar.identity',
    locale: NS,
  }, EmployeeIdentityRow))
}
