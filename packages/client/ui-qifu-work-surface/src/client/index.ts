/** Qifu employee work-surface registrations. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PersonalizationSection } from './PersonalizationSection.tsx'
import { QifuWorkSurface } from './QifuWorkSurface.tsx'
import { en, NS, zh } from './locales.ts'

export type { QifuDesktopBridge } from './api.ts'
export type { PersonalizationSectionProps } from './PersonalizationSection.tsx'
export type { QifuWorkSurfaceProps } from './QifuWorkSurface.tsx'
export type { QifuWorkSurfaceKey } from './locales.ts'

/** Services required by the Qifu work-surface plugin. */
export const inject = ['slots', 'locale', 'sessions']

/** Register the sidebar composition and account personalization page. */
export function apply(ctx: ClientContext): void {
  if (window.qifuDesktop === undefined) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-qifu-work-surface: dictionaries')
  ctx.slots.inject('sidebar.workSurface', () => ctx.slots.register({
    name: 'sidebar.workSurface',
    locale: NS,
    inject: () => ({ sessionList: ctx.sessions.list }),
  }, QifuWorkSurface))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qifu-personalization',
    order: 15,
    label: () => t('personalization.nav'),
    locale: NS,
  }, PersonalizationSection))
}
