/**
 * Employee-authorized Qifu profile and account-memory request context.
 *
 * @module @deepseek-ai/dsh-qifu-account-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection, UserMessage } from '@deepseek-ai/dsh-llm'
import { z as zod } from 'zod'

/** Cordis plugin name used in durable source attribution. */
export const name = 'qifu-account-context'
/** The agent registry that owns request preparation. */
export const inject = ['agents']

const contextResponseSchema = zod.object({
  snapshot_id: zod.string().regex(/^$|^ctx_[a-z0-9]+$/u),
  sections: zod.array(zod.object({
    name: zod.enum(['qifu-employee-profile', 'qifu-account-memory']),
    text: zod.string().min(1).max(6_000),
  }).strict()).max(2),
}).strict()

/** Named environment variables and network limits for the Qifu context source. */
export interface Config {
  /** Environment variable containing the certificate-validated HTTPS endpoint. */
  endpointEnv: string
  /** Environment variable containing the current employee gateway session token. */
  tokenEnv: string
  /** Environment variable containing `true` for a local workspace or `false` for cloud work. */
  localContextEnv: string
  /** Maximum time allowed for one context request. */
  timeoutMs: number
  /** Maximum JSON response size accepted from the gateway. */
  maxResponseBytes: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  endpointEnv: z.string().required(),
  tokenEnv: z.string().required(),
  localContextEnv: z.string().required(),
  timeoutMs: z.number().required(),
  maxResponseBytes: z.number().required(),
})

function requiredEnvironmentName(field: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(value)) {
    throw new TypeError(`qifu-account-context: ${field} must name an uppercase environment variable`)
  }
  return value
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`qifu-account-context: required environment variable ${name} is missing`)
  }
  return value
}

function positiveSafeInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`qifu-account-context: ${field} must be a positive safe integer`)
  }
  return value
}

function promptText(messages: readonly UserMessage[]): string {
  const selected = messages.findLast(message => message.source.kind === 'user') ?? messages.at(-1)
  return selected?.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .slice(0, 4_000) ?? ''
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response.body?.cancel()
    throw new Error('qifu-account-context: response exceeds maxResponseBytes')
  }
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error('qifu-account-context: response exceeds maxResponseBytes')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

async function loadContext(
  endpoint: URL,
  token: string,
  localContext: boolean,
  message: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ snapshotId: string; sections: ContextSnapshotSection[] }> {
  const controller = new AbortController()
  const abort = () => { controller.abort(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { controller.abort(new Error('context request timed out')) }, timeoutMs)
  timeout.unref()
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ local_context: localContext, message }),
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`qifu-account-context: gateway returned HTTP ${String(response.status)}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('qifu-account-context: gateway response is not JSON')
    }
    const payload = contextResponseSchema.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await responseBytes(response, maxResponseBytes)),
    ))
    const suffix = payload.snapshot_id === '' ? '' : `@${payload.snapshot_id}`
    return {
      snapshotId: payload.snapshot_id,
      sections: payload.sections.map(section => ({ name: `${section.name}${suffix}`, text: section.text })),
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Add the current employee's consent-filtered Qifu context to the first model step of each turn.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - environment names and bounded request limits.
 * @throws when deployment configuration is missing or unsafe.
 */
export function apply(ctx: Context, config: Config): void {
  const endpointEnv = requiredEnvironmentName('endpointEnv', config.endpointEnv)
  const tokenEnv = requiredEnvironmentName('tokenEnv', config.tokenEnv)
  const localContextEnv = requiredEnvironmentName('localContextEnv', config.localContextEnv)
  const endpoint = new URL(requiredEnvironmentValue(endpointEnv))
  if (endpoint.protocol !== 'https:') throw new Error('qifu-account-context: endpoint must use HTTPS')
  const token = requiredEnvironmentValue(tokenEnv)
  const localValue = requiredEnvironmentValue(localContextEnv)
  if (localValue !== 'true' && localValue !== 'false') {
    throw new Error(`qifu-account-context: ${localContextEnv} must be true or false`)
  }
  const timeoutMs = positiveSafeInteger('timeoutMs', config.timeoutMs)
  const maxResponseBytes = positiveSafeInteger('maxResponseBytes', config.maxResponseBytes)

  ctx.on('agent/pre-step', async ({ step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || signal.aborted) return decision
    try {
      const loaded = await loadContext(
        endpoint,
        token,
        localValue === 'true',
        promptText(decision.messages),
        signal,
        timeoutMs,
        maxResponseBytes,
      )
      if (loaded.sections.length === 0) return decision
      const text = loaded.sections.map(section => section.text).join('\n\n')
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: loaded.sections },
          }),
        ],
      }
    } catch {
      // Context is optional; gateway or network failure must not block the employee's task.
      return decision
    }
  }, { prepend: true })
}
