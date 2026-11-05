/** Qifu employee work-surface Host operations and browser plugin companion. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installOfficeHost } from './office-host.ts'
import { installBrowserHost } from './browser-host.ts'

/** Qifu-specific document processing opt-in and deployment limits. */
export interface Config {
  /** Environment variable that enables Office operations only when it equals true. */
  readonly enabledEnv?: string
  /** Environment variable enabling local isolated desktop DOM reads. */
  readonly browserEnabledEnv?: string
  /** Maximum duration of one desktop DOM read, at most 30000 milliseconds. */
  readonly browserTimeoutMs?: number
  /** Maximum retained DOM bytes per read, at most 1 MiB. */
  readonly browserMaxDomBytes?: number
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
  browserEnabledEnv: z.string().default('QIFUAI_BROWSER_TEST_ENABLED'),
  browserTimeoutMs: z.number().step(1).min(1).max(30_000).default(30_000),
  browserMaxDomBytes: z.number().step(1).min(1).max(1024 * 1024).default(1024 * 1024),
  dshHome: z.string(),
  maxDocumentBytes: z.number().step(1).min(1).max(25 * 1024 * 1024).default(25 * 1024 * 1024),
  maxTextBytes: z.number().step(1).min(1).default(1024 * 1024),
  maxDocumentsPerSession: z.number().step(1).min(1).default(100),
  maxReadLines: z.number().step(1).min(1).default(2000),
  maxConcurrentOperations: z.number().step(1).min(1).default(2),
})

/** No required services before the Qifu-specific deployment opt-in is evaluated. */
export const inject: string[] = []

function enabled(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error('Qifu enabledEnv must name an environment variable')
  const value = process.env[name]
  if (value === undefined || value === 'false') return false
  if (value !== 'true') throw new Error(`Qifu ${name} must be true or false`)
  return true
}

function positiveLimits(options: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(options)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`Qifu ${field} must be a positive integer`)
  }
}

/**
 * Register private Office and browser operations in independently enabled Qifu profiles.
 * @param ctx - Host plugin context whose browser half owns the Qifu UI.
 * @param config - opt-in variable, home, and bounded file-processing policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (enabled(config.browserEnabledEnv ?? 'QIFUAI_BROWSER_TEST_ENABLED')) {
    const browserOptions = {
      timeoutMs: config.browserTimeoutMs ?? 30_000,
      maxDomBytes: config.browserMaxDomBytes ?? 1024 * 1024,
      maxConcurrentOperations: config.maxConcurrentOperations ?? 2,
    }
    positiveLimits(browserOptions)
    if (browserOptions.timeoutMs > 30_000 || browserOptions.maxDomBytes > 1024 * 1024) {
      throw new Error('Qifu browser limits cannot exceed 30 seconds or 1 MiB')
    }
    ctx.inject(['tools', 'systemPrompt'], (active) => { installBrowserHost(active, browserOptions) })
  }
  if (!enabled(config.enabledEnv ?? 'QIFUAI_OFFICE_ENABLED')) return
  const options = {
    dshHome: resolveDshHome(config.dshHome),
    maxDocumentBytes: config.maxDocumentBytes ?? 25 * 1024 * 1024,
    maxTextBytes: config.maxTextBytes ?? 1024 * 1024,
    maxDocumentsPerSession: config.maxDocumentsPerSession ?? 100,
    maxReadLines: config.maxReadLines ?? 2000,
    maxConcurrentOperations: config.maxConcurrentOperations ?? 2,
  }
  positiveLimits(options)
  if (options.maxDocumentBytes > 25 * 1024 * 1024) throw new Error('Qifu Office maxDocumentBytes cannot exceed 25 MiB')
  ctx.inject(['connection', 'sessionController', 'tools', 'systemPrompt'], (active) => { installOfficeHost(active, options) })
}
