/** Qifu employee work-surface Host operations and browser plugin companion. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installOfficeHost } from './office-host.ts'

/** Qifu-specific document processing opt-in and deployment limits. */
export interface Config {
  /** Environment variable that enables Office operations only when it equals true. */
  readonly enabledEnv?: string
  /** Employee-specific Harness home; omitted follows DSH_HOME and then ~/.dsh. */
  readonly dshHome?: string
  /** Accepted raw bytes per document, at most the 25 MiB client ceiling. */
  readonly maxDocumentBytes?: number
  /** Maximum UTF-8 bytes of extracted text or Markdown supplied for generation. */
  readonly maxTextBytes?: number
  /** Maximum immutable original and generated documents retained for one Session. */
  readonly maxDocumentsPerSession?: number
  /** Maximum extracted text lines returned by one office_read call. */
  readonly maxReadLines?: number
  /** Concurrent parsing or generation operations; a full runtime rejects without queuing. */
  readonly maxConcurrentOperations?: number
}

/** Validate the employee runtime's optional Office configuration. */
export const Config: z<Config> = z.object({
  enabledEnv: z.string().default('QIFUAI_OFFICE_ENABLED'),
  dshHome: z.string(),
  maxDocumentBytes: z.number().step(1).min(1).max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  maxTextBytes: z.number().step(1).min(1).default(1024 * 1024),
  maxDocumentsPerSession: z.number().step(1).min(1).default(100),
  maxReadLines: z.number().step(1).min(1).default(2000),
  maxConcurrentOperations: z.number().step(1).min(1).default(2),
})

/** No required services before the Qifu-specific deployment opt-in is evaluated. */
export const inject: string[] = []

/**
 * Register private Office operations only in explicitly enabled Qifu profiles.
 * @param ctx - Host plugin context whose browser half owns the Qifu UI.
 * @param config - opt-in variable, home, and bounded file-processing policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const enabledEnv = config.enabledEnv ?? 'QIFUAI_OFFICE_ENABLED'
  if (!/^[A-Z][A-Z0-9_]*$/u.test(enabledEnv)) throw new Error('Qifu Office enabledEnv must name an environment variable')
  const enabled = process.env[enabledEnv]
  if (enabled === undefined || enabled === 'false') return
  if (enabled !== 'true') throw new Error(`Qifu Office ${enabledEnv} must be true or false`)
  const options = {
    dshHome: resolveDshHome(config.dshHome),
    maxDocumentBytes: config.maxDocumentBytes ?? 25 * 1024 * 1024,
    maxTextBytes: config.maxTextBytes ?? 1024 * 1024,
    maxDocumentsPerSession: config.maxDocumentsPerSession ?? 100,
    maxReadLines: config.maxReadLines ?? 2000,
    maxConcurrentOperations: config.maxConcurrentOperations ?? 2,
  }
  for (const [field, value] of Object.entries(options)) {
    if (field !== 'dshHome' && (!Number.isSafeInteger(value) || Number(value) < 1)) throw new Error(`Qifu Office ${field} must be a positive integer`)
  }
  if (options.maxDocumentBytes > 25 * 1024 * 1024) throw new Error('Qifu Office maxDocumentBytes cannot exceed 25 MiB')
  ctx.inject(['connection', 'sessionController', 'tools', 'systemPrompt'], (active) => { installOfficeHost(active, options) })
}
