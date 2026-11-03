/** Qifu employee work-surface registrations. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OfficeDocuments } from './OfficeDocuments.tsx'
import type { OfficeDocumentsInjected } from './OfficeDocuments.tsx'
import { PersonalizationSection } from './PersonalizationSection.tsx'
import { QifuWorkSurface } from './QifuWorkSurface.tsx'
import { en, NS, zh } from './locales.ts'

export type { QifuDesktopBridge } from './api.ts'
export type { PersonalizationSectionProps } from './PersonalizationSection.tsx'
export type { QifuWorkSurfaceProps } from './QifuWorkSurface.tsx'
export type { QifuWorkSurfaceKey } from './locales.ts'

/** Services required by the Qifu work-surface plugin. */
export const inject = ['slots', 'locale', 'sessions', 'connection', 'conversation']

/** Register the sidebar composition and account personalization page. */
export function apply(ctx: ClientContext): void {
  if (window.qifuDesktop === undefined) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-qifu-work-surface: dictionaries')
  ctx.slots.inject('sidebar.workSurface', () => ctx.slots.register({
    name: 'sidebar.workSurface',
    locale: NS,
    inject: () => ({ sessionList: ctx.sessions.list }),
  }, QifuWorkSurface))
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'qifu-office',
    order: 10,
    locale: NS,
    inject: (sessionId): OfficeDocumentsInjected => ({
      request: async (endpoint, payload, signal) => {
        const result = await connection.rpc.call('/qifu-office', endpoint, payload, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      appendReference: (reference) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || binding.session.getSnapshot().removed) return false
        const input = ctx.conversation.input.for(binding.ctx)
        const state = input.state.getSnapshot()
        if (state.phase === 'submitting' || state.phase === 'adjudicating') return false
        input.setDraft(`${state.draft}${state.draft === '' || state.draft.endsWith('\n') ? '' : '\n'}${reference}\n`)
        return true
      },
    }),
  }, OfficeDocuments))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qifu-personalization',
    order: 15,
    label: () => t('personalization.nav'),
    locale: NS,
  }, PersonalizationSection))
}
