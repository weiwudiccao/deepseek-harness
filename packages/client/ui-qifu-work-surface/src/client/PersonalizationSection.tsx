import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { readConsent, writeConsent, type QifuConsent } from './api.ts'
import type { QifuWorkSurfaceKey } from './locales.ts'
import css from './PersonalizationSection.module.css'

/** Full props supplied by the Settings section seat. */
export type PersonalizationSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'qifuWorkSurface'>

const ROWS = [
  ['work_profile_read', 'personalization.workProfile', 'personalization.workProfile.help'],
  ['memory_read', 'personalization.memoryRead', 'personalization.memoryRead.help'],
  ['memory_write', 'personalization.memoryWrite', 'personalization.memoryWrite.help'],
  ['local_context_read', 'personalization.localContext', 'personalization.localContext.help'],
] as const

/** Render the four independent opt-in controls backed by the OA consent record. */
export function PersonalizationSection({ t }: PersonalizationSectionProps) {
  const [consent, setConsent] = useState<QifuConsent | undefined>()
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  useEffect(() => {
    let live = true
    void readConsent().then((value) => { if (live) setConsent(value) }, () => { if (live) setStatus('error') })
    return () => { live = false }
  }, [])

  const update = (field: keyof Omit<QifuConsent, 'policy_version'>, value: boolean): void => {
    if (consent === undefined || saving) return
    const next = { ...consent, [field]: value }
    setConsent(next)
    setSaving(true)
    setStatus('idle')
    void writeConsent(next).then((saved) => {
      setConsent(saved)
      setStatus('saved')
    }, () => {
      setConsent(consent)
      setStatus('error')
    }).finally(() => { setSaving(false) })
  }

  return (
    <section className={css.root}>
      <h2 className={css.title}>{t('personalization.title')}</h2>
      <p className={css.description}>{t('personalization.description')}</p>
      <div className={css.rows}>
        {ROWS.map(([field, label, help]) => (
          <label key={field} className={css.row}>
            <span className={css.copy}>
              <span className={css.label}>{t(label satisfies QifuWorkSurfaceKey)}</span>
              <span className={css.help}>{t(help satisfies QifuWorkSurfaceKey)}</span>
            </span>
            <input
              type="checkbox"
              className={css.toggle}
              checked={consent?.[field] ?? false}
              disabled={consent === undefined || saving}
              onChange={(event) => { update(field, event.currentTarget.checked) }}
            />
          </label>
        ))}
      </div>
      <div className={css.status} role="status">
        {status === 'saved' ? t('personalization.saved') : status === 'error' ? t('personalization.error') : ''}
      </div>
    </section>
  )
}
