import { useEffect, useState } from 'react'
import { IconCheckOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  confirmMemory, forgetMemory, readPersonalization, writeConsent,
  type QifuConsent, type QifuMemoryItem,
} from './api.ts'
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
  const [memories, setMemories] = useState<readonly QifuMemoryItem[]>([])
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  useEffect(() => {
    let live = true
    void readPersonalization().then((value) => {
      if (!live) return
      setConsent(value.consent)
      setMemories(value.memoryItems)
    }, () => { if (live) setStatus('error') })
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

  const updateMemory = (memory: QifuMemoryItem, action: 'confirm' | 'forget'): void => {
    if (saving) return
    setSaving(true)
    setStatus('idle')
    const operation = action === 'confirm' ? confirmMemory(memory.id) : forgetMemory(memory.id)
    void operation.then(() => {
      setMemories(current => action === 'confirm'
        ? current.map(item => item.id === memory.id ? { ...item, status: 'Active' } : item)
        : current.filter(item => item.id !== memory.id))
      setStatus('saved')
    }, () => { setStatus('error') }).finally(() => { setSaving(false) })
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
      <h3 className={css.memoryTitle}>{t('personalization.memories')}</h3>
      <p className={css.memoryDescription}>{t('personalization.memories.help')}</p>
      <div className={css.memoryList}>
        {memories.length === 0
          ? <div className={css.memoryEmpty}>{t('personalization.memories.empty')}</div>
          : memories.map(memory => (
            <div key={memory.id} className={css.memoryRow}>
              <span className={css.memoryCopy}>
                <span className={css.memoryValue}>{memory.value}</span>
                <span className={css.memoryMeta}>
                  {memory.status === 'Proposed'
                    ? t('personalization.memory.proposed')
                    : t('personalization.memory.active')}
                </span>
              </span>
              {memory.status === 'Proposed' && (
                <button
                  type="button"
                  className={css.memoryAction}
                  aria-label={`${t('personalization.memory.confirm')} ${memory.value}`}
                  disabled={saving || consent?.memory_write !== true}
                  onClick={() => { updateMemory(memory, 'confirm') }}
                >
                  <IconCheckOutline16 size={16} />
                </button>
              )}
              <button
                type="button"
                className={css.memoryAction}
                aria-label={`${t('personalization.memory.forget')} ${memory.value}`}
                disabled={saving}
                onClick={() => { updateMemory(memory, 'forget') }}
              >
                <IconTrashOutline16 size={16} />
              </button>
            </div>
          ))}
      </div>
    </section>
  )
}
