import { useEffect, useState } from 'react'
import { IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { readEmployeeIdentity, type EmployeeIdentity } from './identity.ts'
import type { EmployeeIdentityKey } from './locales.ts'
import css from './EmployeeIdentityRow.module.css'

/** Full props supplied by the authenticated identity sidebar seat. */
export type EmployeeIdentityRowProps =
  PropsRuntime<'sidebar.identity'> & PropsLocale<'employeeIdentity'>

/** Render the authenticated employee's name and job title above Settings. */
export function EmployeeIdentityRow({ wide, t }: EmployeeIdentityRowProps) {
  const [identity, setIdentity] = useState<EmployeeIdentity>()

  useEffect(() => {
    const controller = new AbortController()
    void readEmployeeIdentity(controller.signal).then(setIdentity, (error: unknown) => {
      if (!controller.signal.aborted) console.error('[ui-employee-identity] reading the employee failed:', error)
    })
    return () => { controller.abort() }
  }, [])

  if (identity === undefined) return null
  const designation = identity.designation || t('designation.unset' satisfies EmployeeIdentityKey)
  const tooltip = `${identity.name} · ${designation}`
  return (
    <Tooltip label={tooltip} side="right" delayMs={500} disabled={wide}>
      <div className={css.root} aria-label={t('label')}>
        <span className={css.avatar} aria-hidden><IconUserOutline16 size={18} /></span>
        {wide && (
          <span className={css.copy}>
            <span className={css.name}>{identity.name}</span>
            <span className={css.designation}>{designation}</span>
          </span>
        )}
      </div>
    </Tooltip>
  )
}
