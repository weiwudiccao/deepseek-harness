/** Session-addressed office file intake and output downloads. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeDocument, OfficeDocumentId } from '../office-types.ts'
import type { QifuWorkSurfaceKey } from './locales.ts'
import css from './OfficeDocuments.module.css'

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const FORMATS = ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'htm', 'csv', 'txt', 'md', 'rtf', 'odt', 'ods', 'odp']
const ERROR_MESSAGES: Readonly<Record<string, QifuWorkSurfaceKey>> = {
  OFFICE_PDF_TEXT_REQUIRED: 'office.error.pdfTextRequired',
  OFFICE_READ_FAILED: 'office.error.unreadable',
  OFFICE_PASSWORD_REQUIRED: 'office.error.unreadable',
  OFFICE_PASSWORD_INCORRECT: 'office.error.unreadable',
  OFFICE_TIMEOUT: 'office.error.timeout',
  OFFICE_INPUT_TOO_LARGE: 'office.error.tooLarge',
  OFFICE_OUTPUT_TOO_LARGE: 'office.error.tooLarge',
  OFFICE_TEXT_TOO_LARGE: 'office.error.tooLarge',
  OFFICE_CONTENT_LIMIT: 'office.error.tooLarge',
  OFFICE_BUSY: 'office.error.busy',
  OFFICE_UNSUPPORTED_FORMAT: 'office.unsupported',
}

/** Plain callbacks bound to one Session by the slot registrant. */
export interface OfficeDocumentsInjected {
  /** Call the current runtime's office channel with caller-owned cancellation. */
  request: (endpoint: 'import' | 'list', payload: { sessionId: string; name?: string; data?: string }, signal: AbortSignal) => Promise<unknown>
  /** Append to the latest editable draft; false leaves the document available for a later reference. */
  appendReference: (reference: string) => boolean
  /** Route non-image composer drops and pasted files to this mounted Session. */
  registerFileIntake: (handler: (files: readonly File[]) => void) => () => void
}

/** Office control props assembled at the Session composer seat. */
export type OfficeDocumentsProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'qifuWorkSurface'> & OfficeDocumentsInjected

function officeErrorMessage(error: unknown, t: OfficeDocumentsProps['t']): string {
  const message = error instanceof Error ? error.message : t('office.unknownError')
  const key = Object.hasOwn(ERROR_MESSAGES, message) ? ERROR_MESSAGES[message] : undefined
  return key === undefined ? message : t(key)
}

interface SessionFiles {
  readonly sessionId: string
  readonly documents: readonly OfficeDocument[]
  readonly busy: boolean
  readonly loading: boolean
  readonly error: string
  readonly notice: string
}

interface OfficeScope {
  readonly sessionId: string
  readonly controller: AbortController
  busy: boolean
}

function emptyFiles(sessionId: string): SessionFiles {
  return { sessionId, documents: [], busy: false, loading: false, error: '', notice: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocument(value: unknown): OfficeDocument {
  if (!isRecord(value)
    || typeof value.id !== 'string' || value.id === ''
    || typeof value.name !== 'string' || value.name === ''
    || typeof value.format !== 'string' || !FORMATS.includes(value.format)
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_DOCUMENT_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || typeof value.createdAt !== 'string' || (value.kind !== 'original' && value.kind !== 'generated')) {
    throw new Error('QIFU_OFFICE_RESPONSE_INVALID')
  }
  return {
    id: brandString<OfficeDocumentId>(value.id), name: value.name, format: value.format, kind: value.kind,
    bytes: value.bytes, sha256: value.sha256, createdAt: value.createdAt,
  }
}

function ownsScope(current: OfficeScope | null, expected: OfficeScope): boolean {
  return current === expected && !expected.controller.signal.aborted
}

function encodeFile(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const finish = (): void => { signal.removeEventListener('abort', abort) }
    const abort = (): void => {
      reader.abort()
      finish()
      reject(new Error('QIFU_OFFICE_UPLOAD_CANCELLED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    reader.onload = () => {
      finish()
      const result = reader.result
      if (typeof result !== 'string' || !result.includes(',')) reject(new Error('QIFU_OFFICE_FILE_READ_FAILED'))
      else resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => {
      finish()
      reject(reader.error ?? new Error('QIFU_OFFICE_FILE_READ_FAILED'))
    }
    reader.readAsDataURL(file)
  })
}

/** Import files into the active runtime and expose its Session's document outputs. */
export function OfficeDocuments({ sessionId, useSession, input, request, appendReference, registerFileIntake, t }: OfficeDocumentsProps) {
  const running = useSession(value => value.running)
  const removed = useSession(value => value.removed)
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<SessionFiles>(() => emptyFiles(sessionId))
  const scope = useRef<OfficeScope | null>(null)
  const listRevision = useRef(0)
  const picker = useRef<HTMLInputElement | null>(null)
  const current = files.sessionId === sessionId ? files : emptyFiles(sessionId)
  const blocked = removed || input.phase === 'submitting' || input.phase === 'adjudicating'

  const refresh = useCallback(async (): Promise<void> => {
    const owned = scope.current
    if (owned === null || owned.sessionId !== sessionId || owned.busy) return
    const revision = ++listRevision.current
    setFiles(value => ({ ...value, loading: true }))
    try {
      const result = await request('list', { sessionId }, owned.controller.signal)
      if (!ownsScope(scope.current, owned) || revision !== listRevision.current) return
      if (!isRecord(result) || !Array.isArray(result.documents)) throw new Error('QIFU_OFFICE_RESPONSE_INVALID')
      const documents = result.documents.map(parseDocument)
      setFiles(value => ({ ...value, documents, loading: false, error: '' }))
    } catch (error) {
      if (!ownsScope(scope.current, owned) || revision !== listRevision.current) return
      setFiles(value => ({ ...value, loading: false, error: t('office.loadFailed', { message: officeErrorMessage(error, t) }) }))
    }
  }, [request, sessionId, t])

  useEffect(() => {
    const owned = { sessionId, controller: new AbortController(), busy: false }
    scope.current = owned
    setFiles(emptyFiles(sessionId))
    return () => {
      owned.controller.abort()
      if (scope.current === owned) scope.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, running, refresh])

  const reference = useCallback((document: OfficeDocument): void => {
    const inserted = appendReference(t('office.reference', { name: document.name, id: document.id }))
    setFiles(value => ({ ...value, notice: t(inserted ? 'office.referenced' : 'office.referencePending') }))
  }, [appendReference, t])

  const upload = useCallback(async (selected: readonly File[]): Promise<void> => {
    const owned = scope.current
    if (owned === null || owned.sessionId !== sessionId || blocked || selected.length === 0) return
    if (owned.busy) {
      setFiles(value => ({ ...value, error: t('office.error.busy'), notice: '' }))
      return
    }
    for (const file of selected) {
      const format = file.name.split('.').at(-1)?.toLowerCase()
      if (format === undefined || !FORMATS.includes(format)) {
        setFiles(value => ({ ...value, error: t('office.unsupported'), notice: '' }))
        return
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        setFiles(value => ({ ...value, error: t('office.tooLarge'), notice: '' }))
        return
      }
    }
    owned.busy = true
    ++listRevision.current
    setFiles(value => ({ ...value, busy: true, loading: false, error: '', notice: '' }))
    try {
      for (const file of selected) {
        if (!ownsScope(scope.current, owned)) return
        const data = await encodeFile(file, owned.controller.signal)
        if (!ownsScope(scope.current, owned)) return
        const result = await request('import', { sessionId, name: file.name, data }, owned.controller.signal)
        if (!ownsScope(scope.current, owned)) return
        if (!isRecord(result)) throw new Error('QIFU_OFFICE_RESPONSE_INVALID')
        const document = parseDocument(result.document)
        ++listRevision.current
        setFiles(value => ({
          ...value, loading: false,
          documents: [document, ...value.documents.filter(item => item.id !== document.id)],
        }))
        reference(document)
      }
    } catch (error) {
      if (!ownsScope(scope.current, owned)) return
      setFiles(value => ({ ...value, error: t('office.importFailed', { message: officeErrorMessage(error, t) }) }))
    } finally {
      owned.busy = false
      if (ownsScope(scope.current, owned)) setFiles(value => ({ ...value, busy: false }))
    }
  }, [blocked, reference, request, sessionId, t])

  useEffect(() => registerFileIntake((selected) => { void upload(selected) }), [registerFileIntake, upload])

  return (
    <div className={css.root} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
      <button type="button" className={css.trigger} aria-expanded={open} disabled={removed} onClick={() => { setOpen(value => !value) }}>
        {t('office.button')}
      </button>
      {!open && current.error !== '' && <p className={css.error} role="alert">{current.error}</p>}
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('office.title')}>
          <div className={css.header}>
            <strong>{t('office.title')}</strong>
            <button type="button" className={css.action} onClick={() => { setOpen(false) }}>{t('office.close')}</button>
          </div>
          <p className={css.help}>{t('office.help')}</p>
          <input
            ref={picker}
            className={css.fileInput}
            type="file"
            accept={FORMATS.map(format => `.${format}`).join(',')}
            aria-label={t('office.choose')}
            disabled={current.busy || blocked}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void upload([file])
            }}
          />
          <div className={css.actions}>
            <button type="button" className={css.action} disabled={current.busy || blocked} onClick={() => { picker.current?.click() }}>
              {t(current.busy ? 'office.importing' : 'office.import')}
            </button>
            <button type="button" className={css.action} disabled={current.loading || current.busy} onClick={() => { void refresh() }}>{t('office.refresh')}</button>
          </div>
          {current.error !== '' && <p className={css.error} role="alert">{current.error}</p>}
          {current.notice !== '' && <p className={css.help} role="status">{current.notice}</p>}
          <ul className={css.files}>
            {current.documents.map(document => (
              <li key={document.id} className={css.file}>
                <span className={css.name} title={document.name}>{document.name}</span>
                <span className={css.meta}>{t('office.fileMeta', { kind: t(document.kind === 'original' ? 'office.original' : 'office.generated'), format: document.format.toUpperCase(), bytes: document.bytes.toLocaleString() })}</span>
                <div className={css.actions}>
                  <button type="button" className={css.action} aria-label={t('office.referenceFile', { name: document.name })} disabled={blocked || current.busy} onClick={() => { reference(document) }}>{t('office.referenceAction')}</button>
                  <a className={css.action} download={document.name} href={`/api/qifu.office.download?${new URLSearchParams({ sessionId, documentId: document.id })}`} aria-label={t('office.downloadFile', { name: document.name })}>{t('office.download')}</a>
                </div>
              </li>
            ))}
          </ul>
          {current.documents.length === 0 && <p className={css.help}>{t(current.loading ? 'loading' : 'office.empty')}</p>}
        </div>
      )}
    </div>
  )
}
