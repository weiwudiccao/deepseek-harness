import { useEffect, useState } from 'react'
import {
  IconChevronUpOutline14, IconSettingsOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { readEmployeeIdentity, type EmployeeIdentity } from './identity.ts'
import type { EmployeeIdentityKey } from './locales.ts'
import css from './EmployeeIdentityRow.module.css'

type IdentityState =
  | { status: 'loading' }
  | { status: 'ready'; identity: EmployeeIdentity }
  | { status: 'unavailable' }

/** Full props supplied by the settings account seat. */
export type EmployeeIdentityRowProps =
  PropsRuntime<'settings.account'> & PropsLocale<'employeeIdentity'>

function employeeInitials(name: string): string {
  const words = name.trim().split(/\s+/u)
  if (words.length > 1) {
    return words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
  }
  const characters = Array.from(words[0] ?? '')
  const latinName = characters.every(character => /^[\p{Script=Latin}\p{Number}]$/u.test(character))
  return (latinName ? characters.slice(0, 2).join('') : characters[0] ?? '?').toUpperCase()
}

/** Render the authenticated employee as the Settings account-menu trigger. */
export function EmployeeIdentityRow({ wide, openSettings, t }: EmployeeIdentityRowProps) {
  const [state, setState] = useState<IdentityState>({ status: 'loading' })
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void readEmployeeIdentity(controller.signal).then((identity) => {
      if (controller.signal.aborted) return
      setState(identity === undefined ? { status: 'unavailable' } : { status: 'ready', identity })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      console.error('[ui-employee-identity] reading the employee failed:', error)
      setState({ status: 'unavailable' })
    })
    return () => { controller.abort() }
  }, [])

  const settingsLabel = t('settings' satisfies EmployeeIdentityKey)
  if (state.status === 'loading') return null
  if (state.status === 'unavailable') {
    return (
      <Tooltip label={settingsLabel} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={`${css.settingsFallback}${wide ? '' : ` ${css.rail}`}`}
          aria-label={settingsLabel}
          aria-haspopup="dialog"
          onClick={openSettings}
        >
          <IconSettingsOutline16 size={18} />
          {wide && <span>{settingsLabel}</span>}
        </button>
      </Tooltip>
    )
  }

  const { identity } = state
  const designation = identity.designation || t('designation.unset' satisfies EmployeeIdentityKey)
  const tooltip = `${identity.name} · ${designation}`
  const accountLabel = `${t('label' satisfies EmployeeIdentityKey)}：${tooltip}`
  const account = (
    <Menu
      className={`${css.menu}${wide ? '' : ` ${css.railMenu}`}`}
      open={menuOpen}
      side="top"
      align="start"
      portal
      dense
      items={[{
        id: 'settings',
        label: settingsLabel,
        icon: <IconSettingsOutline16 size={16} />,
      }]}
      onSelect={() => {
        setMenuOpen(false)
        openSettings()
      }}
      onClose={() => { setMenuOpen(false) }}
      anchor={(
        <button
          type="button"
          className={`${css.root}${wide ? '' : ` ${css.rail}`}`}
          aria-label={accountLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => { setMenuOpen(open => !open) }}
        >
          <span className={css.avatar} aria-hidden>{employeeInitials(identity.name)}</span>
          {wide && (
            <span className={css.copy}>
              <span className={css.name}>{identity.name}</span>
              <span className={css.designation}>{designation}</span>
            </span>
          )}
          {wide && <IconChevronUpOutline14 className={css.chevron} size={14} />}
        </button>
      )}
    />
  )

  return (
    <Tooltip label={tooltip} side="right" delayMs={500} disabled={wide || menuOpen}>
      <span className={css.tooltipAnchor}>{account}</span>
    </Tooltip>
  )
}
