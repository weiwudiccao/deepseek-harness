import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconDataOutline16,
  IconDatabaseOutline16, IconDownloadOutline16, IconFolderClose16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  readBootstrap, readCloudItems, readRuntimeMode, type QifuCloudItem, type QifuCloudItemKind, type QifuFeature,
} from './api.ts'
import type { QifuWorkSurfaceKey } from './locales.ts'
import css from './QifuWorkSurface.module.css'

type SurfaceState =
  | { status: 'loading'; mode: 'cloud' }
  | { status: 'ready'; mode: 'local' | 'cloud'; features: readonly QifuFeature[]; cloud: readonly QifuCloudItem[] }
  | { status: 'unavailable'; mode: 'local' | 'cloud' }

const CLOUD_GROUPS: readonly {
  readonly title: QifuWorkSurfaceKey
  readonly kinds: ReadonlySet<QifuCloudItemKind>
}[] = [
  { title: 'cloud.group.sessions', kinds: new Set(['Conversation', 'Session', 'Harness Session']) },
  { title: 'cloud.group.designs', kinds: new Set(['Presentation']) },
  { title: 'cloud.group.files', kinds: new Set(['File']) },
]

/** Full props supplied by the deployment composition slot. */
export type QifuWorkSurfaceProps = PropsRuntime<'sidebar.workSurface'> & PropsLocale<'qifuWorkSurface'>
  & { readonly sessionList: ObservableSnapshot<SessionListState> }

function Section({
  title, icon, children, initialOpen = true,
}: { title: string; icon: ReactNode; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <section className={css.section}>
      <button
        type="button"
        className={css.sectionHeader}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.headerIcon} aria-hidden>{icon}</span>
        <span className={css.sectionTitle}>{title}</span>
        {open ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
      </button>
      {open && <div className={css.sectionBody}>{children}</div>}
    </section>
  )
}

/** Render permission-derived apps, federated cloud work, and device-local content. */
export function QifuWorkSurface({ wide, workspaces, sessionList, t }: QifuWorkSurfaceProps) {
  const [state, setState] = useState<SurfaceState>({ status: 'loading', mode: 'cloud' })
  const [syncState, setSyncState] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' })
  const sessions = useSyncExternalStore(
    callback => sessionList.subscribe(callback),
    () => sessionList.getSnapshot(),
  )
  const currentSession = sessions.current === undefined ? undefined : sessions.byId[sessions.current]
  useEffect(() => {
    let live = true
    void Promise.all([readRuntimeMode(), readBootstrap(), readCloudItems()]).then(([mode, bootstrap, cloud]) => {
      if (live) setState({ status: 'ready', mode, features: bootstrap.features, cloud })
    }, async () => {
      const mode = await readRuntimeMode().catch(() => 'cloud' as const)
      if (live) setState({ status: 'unavailable', mode })
    })
    return () => { live = false }
  }, [])

  if (!wide) return workspaces
  const desktop = window.qifuDesktop
  const mode = state.mode
  const switchRuntime = (target: 'local' | 'cloud'): void => {
    if (desktop === undefined) return
    setSyncState({ busy: true, message: '' })
    void desktop.switchRuntime(target).then((result) => {
      setSyncState({
        busy: false,
        message: result.ok ? '' : result.message ?? t('runtime.error'),
      })
    }, () => { setSyncState({ busy: false, message: t('runtime.error') }) })
  }
  const runSync = (operation: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>): void => {
    setSyncState({ busy: true, message: '' })
    void operation().then((result) => {
      setSyncState({
        busy: false,
        message: result.cancelled ? '' : result.message ?? (result.ok ? t('sync.done') : t('sync.error')),
      })
    }, () => { setSyncState({ busy: false, message: t('sync.error') }) })
  }
  const syncFile = (): void => {
    if (desktop !== undefined) runSync(() => desktop.syncFile())
  }
  const syncCurrentSession = (): void => {
    if (desktop === undefined || currentSession === undefined) return
    runSync(() => desktop.syncSession(String(currentSession.id), currentSession.displayTitle))
  }
  const downloadCloudItem = (item: QifuCloudItem): void => {
    if (desktop !== undefined) runSync(() => desktop.downloadCloudItem(item.id, item.title))
  }
  const featureRows = state.status === 'ready' && state.features.length > 0
    ? state.features.map(feature => (
      <button
        key={feature.feature_code}
        type="button"
        className={css.row}
        onClick={() => { void window.qifuDesktop?.openFeature(feature) }}
      >
        <span className={css.featureIcon} aria-hidden><IconDataOutline16 size={15} /></span>
        <span className={css.rowCopy}>{feature.label}</span>
      </button>
    ))
    : <div className={css.empty}>{state.status === 'loading' ? t('loading') : t('empty.features')}</div>
  const cloudGroups = state.status === 'ready'
    ? CLOUD_GROUPS.map(group => ({ ...group, items: state.cloud.filter(item => group.kinds.has(item.kind)) }))
      .filter(group => group.items.length > 0)
    : []
  const cloudRows = cloudGroups.length > 0
    ? cloudGroups.map(group => (
      <div key={group.title} className={css.cloudGroup}>
        <div className={css.cloudGroupTitle}>{t(group.title)}</div>
        {group.items.map(item => (
          <div key={item.id} className={css.cloudRow}>
            <button
              type="button"
              className={css.row}
              onClick={() => { if (mode === 'local') switchRuntime('cloud') }}
            >
              <span className={css.cloudItemIcon} aria-hidden><IconDatabaseOutline16 size={15} /></span>
              <span className={css.rowCopy}>
                <span className={css.rowTitle}>{item.title}</span>
                <span className={css.rowMeta}>
                  {`${t(`kind.${item.kind}`)} · ${t('version')} ${item.version}`}
                </span>
              </span>
            </button>
            {item.downloadable && desktop !== undefined && (
              <button
                type="button"
                className={css.downloadButton}
                aria-label={`${t('download')} ${item.title}`}
                disabled={syncState.busy}
                onClick={() => { downloadCloudItem(item) }}
              >
                <IconDownloadOutline16 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
    ))
    : <div className={css.empty}>{state.status === 'loading' ? t('loading') : t('empty.cloud')}</div>

  return (
    <div className={css.root}>
      <Section title={t('features')} icon={<IconDataOutline16 size={16} />}>{featureRows}</Section>
      <Section title={t('cloud')} icon={<IconDatabaseOutline16 size={16} />}>
        {mode === 'cloud' ? workspaces : cloudRows}
        {mode === 'local' && desktop !== undefined && (
          <button
            type="button"
            className={css.switchRow}
            disabled={syncState.busy}
            onClick={() => { switchRuntime('cloud') }}
          >
            {t('switch.cloud')}
          </button>
        )}
      </Section>
      <Section title={t('local')} icon={<IconFolderClose16 size={16} />}>
        {mode === 'local' ? workspaces : (
          window.qifuDesktop === undefined
            ? <div className={css.empty}>{t('unavailable')}</div>
            : <button
              type="button"
              className={css.switchRow}
              disabled={syncState.busy}
              onClick={() => { switchRuntime('local') }}
            >
              {t('switch.local')}
            </button>
        )}
        {desktop !== undefined && (
          <div className={css.syncActions}>
            <button
              type="button"
              className={css.switchRow}
              disabled={syncState.busy}
              onClick={syncFile}
            >
              {t('sync.file')}
            </button>
            {mode === 'local' && (
              <button
                type="button"
                className={css.switchRow}
                disabled={syncState.busy || currentSession === undefined}
                onClick={syncCurrentSession}
              >
                {currentSession === undefined ? t('sync.session.empty') : t('sync.session')}
              </button>
            )}
            {syncState.message !== '' && <div className={css.syncStatus} role="status">{syncState.message}</div>}
          </div>
        )}
      </Section>
    </div>
  )
}
