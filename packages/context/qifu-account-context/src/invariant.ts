/** Package-owned Qifu account-context invariants. @module @deepseek-ai/dsh-qifu-account-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-qifu-account-context'
const SOURCE_NAME = 'qifu-account-context'
const SECTION_NAME = /^qifu-(?:employee-profile|account-memory)(?:@ctx_[a-z0-9]+)?$/u

/** Cordis companion plugin name. */
export const name = 'qifu-account-context-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

function validateMessage(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const [block] = event.data.content
  if (event.data.content.length !== 1 || block?.type !== 'text') {
    fail('qifu-account-context messages must contain exactly one text block')
  }
  const source = event.data.source
  /* v8 ignore next 2 -- callers select this exact package-owned source before validation. */
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('qifu-account-context source must retain package ownership')
  }
  const sectionValues: unknown = 'sections' in source ? source.sections : undefined
  if (source.form !== 'snapshot' || !Array.isArray(sectionValues)
    || sectionValues.length < 1 || sectionValues.length > 2) {
    fail('qifu-account-context source must contain one or two snapshot sections')
  }
  const seen = new Set<string>()
  const texts: string[] = []
  for (const sectionValue of sectionValues) {
    if (typeof sectionValue !== 'object' || sectionValue === null) {
      fail('qifu-account-context section must be an object')
    }
    const section = sectionValue as Record<string, unknown>
    if (typeof section.name !== 'string' || !SECTION_NAME.test(section.name)) {
      fail('qifu-account-context section name is invalid')
    }
    if (seen.has(section.name)) {
      fail(`qifu-account-context section ${JSON.stringify(section.name)} is duplicated`)
    }
    if (typeof section.text !== 'string' || section.text.length < 1 || section.text.length > 6_000) {
      fail(`qifu-account-context section ${JSON.stringify(section.name)} has invalid text length`)
    }
    seen.add(section.name)
    texts.push(section.text)
  }
  if (texts.join('\n\n') !== block.text) {
    fail('qifu-account-context snapshot sections must exactly reconstruct the model-visible text')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateMessage(event, fail)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateMessage(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the Qifu account-context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
