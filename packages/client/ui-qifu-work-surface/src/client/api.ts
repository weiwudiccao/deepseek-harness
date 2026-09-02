/** Same-origin or desktop-bridged Qifu gateway client. */

/** One permission-derived feature entry returned for the current employee. */
export interface QifuFeature {
  readonly feature_code: string
  readonly label: string
  readonly icon: string
  readonly icon_color: string
  readonly route_type: string
  readonly route: string
  readonly digital_employee: string
}

/** Safe list projection for one resource in the current employee's cloud workspace. */
export interface QifuCloudItem {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly version: number
  readonly downloadable: boolean
  readonly modified: string
}

/** Four independent employee choices and the policy version accepted by OA. */
export interface QifuConsent {
  readonly work_profile_read: boolean
  readonly memory_read: boolean
  readonly memory_write: boolean
  readonly local_context_read: boolean
  readonly policy_version: string
}

/** One current employee-owned memory shown for review or deletion. */
export interface QifuMemoryItem {
  readonly id: string
  readonly category: string
  readonly value: string
  readonly status: 'Active' | 'Proposed'
  readonly expires_at: string
  readonly modified: string
}

/** Complete employee personalization settings response. */
export interface QifuPersonalization {
  readonly consent: QifuConsent
  readonly memoryItems: readonly QifuMemoryItem[]
}

/** Employee-authorized feature manifest plus its current personalization summary. */
export interface QifuBootstrap {
  readonly features: readonly QifuFeature[]
  readonly personalization: Partial<QifuConsent>
}

interface DesktopGatewayResponse {
  readonly status: number
  readonly body: unknown
}

/** Privileged operations exposed by the Qifu desktop preload allowlist. */
export interface QifuDesktopBridge {
  gatewayRequest(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<DesktopGatewayResponse>
  runtimeInfo(): Promise<{ mode: 'local' | 'cloud' }>
  switchRuntime(target: 'local' | 'cloud'): Promise<{ ok: boolean }>
  openFeature(feature: QifuFeature): Promise<{ ok: boolean }>
  syncFile(): Promise<{ ok: boolean; cancelled?: boolean; message?: string }>
  syncSession(sessionId: string, title: string): Promise<{ ok: boolean; message?: string }>
  downloadCloudItem(itemId: string, title: string): Promise<{ ok: boolean; cancelled?: boolean; message?: string }>
}

declare global {
  interface Window {
    qifuDesktop?: QifuDesktopBridge
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function gatewayJson(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<unknown> {
  if (window.qifuDesktop !== undefined) {
    const response = await window.qifuDesktop.gatewayRequest(path, init)
    if (response.status < 200 || response.status >= 300) throw new Error('QIFU_GATEWAY_REQUEST_FAILED')
    return response.body
  }
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? { accept: 'application/json' } : {
      accept: 'application/json', 'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('QIFU_GATEWAY_REQUEST_FAILED')
  return response.json()
}

/**
 * Read the permission-derived feature manifest.
 * @returns the current employee's validated feature manifest and consent summary.
 */
export async function readBootstrap(): Promise<QifuBootstrap> {
  const value = await gatewayJson('/qifu/v1/bootstrap')
  if (!isRecord(value) || !Array.isArray(value.features)) throw new Error('QIFU_BOOTSTRAP_INVALID')
  const features = value.features.filter(isRecord).flatMap((row): QifuFeature[] => {
    const featureCode = row.feature_code
    const label = row.label
    const route = row.route
    if (typeof featureCode !== 'string' || typeof label !== 'string' || typeof route !== 'string') return []
    return [{
      feature_code: featureCode,
      label,
      route,
      icon: typeof row.icon === 'string' ? row.icon : 'apps',
      icon_color: typeof row.icon_color === 'string' ? row.icon_color : 'blue',
      route_type: typeof row.route_type === 'string' ? row.route_type : '',
      digital_employee: typeof row.digital_employee === 'string' ? row.digital_employee : '',
    }]
  })
  return {
    features,
    personalization: isRecord(value.personalization) ? value.personalization : {},
  }
}

/**
 * Read the current employee's federated cloud catalog.
 * @returns validated recent cloud Work Item projections.
 */
export async function readCloudItems(): Promise<readonly QifuCloudItem[]> {
  const value = await gatewayJson('/qifu/v1/cloud/items?limit=50')
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('QIFU_CLOUD_ITEMS_INVALID')
  return value.items.filter(isRecord).flatMap((row): QifuCloudItem[] => {
    if (typeof row.id !== 'string' || typeof row.kind !== 'string' || typeof row.title !== 'string') return []
    return [{
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: typeof row.summary === 'string' ? row.summary : '',
      status: typeof row.status === 'string' ? row.status : '',
      version: typeof row.version === 'number' && Number.isSafeInteger(row.version) ? row.version : 1,
      downloadable: row.downloadable === true,
      modified: typeof row.modified === 'string' ? row.modified : '',
    }]
  })
}

/**
 * Read the current employee's explicit personalization choices.
 * @returns all four choices and the current OA policy version.
 */
export async function readConsent(): Promise<QifuConsent> {
  return (await readPersonalization()).consent
}

/**
 * Read consent plus employee-owned active and proposed memories.
 * @returns the complete personalization settings surface.
 */
export async function readPersonalization(): Promise<QifuPersonalization> {
  const value = await gatewayJson('/qifu/v1/personalization')
  const consent = isRecord(value) && isRecord(value.consent) ? value.consent : undefined
  if (consent === undefined || typeof consent.policy_version !== 'string') throw new Error('QIFU_CONSENT_INVALID')
  const memoryItems = isRecord(value) && Array.isArray(value.memory_items)
    ? value.memory_items.filter(isRecord).flatMap((row): QifuMemoryItem[] => {
      if (typeof row.id !== 'string'
        || typeof row.value !== 'string'
        || (row.status !== 'Active' && row.status !== 'Proposed')) return []
      return [{
        id: row.id,
        category: typeof row.category === 'string' ? row.category : '',
        value: row.value,
        status: row.status,
        expires_at: typeof row.expires_at === 'string' ? row.expires_at : '',
        modified: typeof row.modified === 'string' ? row.modified : '',
      }]
    })
    : []
  return {
    consent: {
      work_profile_read: consent.work_profile_read === true,
      memory_read: consent.memory_read === true,
      memory_write: consent.memory_write === true,
      local_context_read: consent.local_context_read === true,
      policy_version: consent.policy_version,
    },
    memoryItems,
  }
}

/**
 * Confirm one proposed employee memory.
 * @param memoryId - opaque id from the employee-scoped memory projection.
 */
export async function confirmMemory(memoryId: string): Promise<void> {
  await gatewayJson('/qifu/v1/personalization/memory/confirm', {
    method: 'POST', body: { memory_id: memoryId },
  })
}

/**
 * Remove one employee memory from future context assembly.
 * @param memoryId - opaque id from the employee-scoped memory projection.
 */
export async function forgetMemory(memoryId: string): Promise<void> {
  await gatewayJson('/qifu/v1/personalization/memory/forget', {
    method: 'POST', body: { memory_id: memoryId },
  })
}

/**
 * Persist one complete personalization choice set.
 * @param consent - complete choice set based on the currently accepted policy version.
 * @returns the authoritative saved choice set.
 */
export async function writeConsent(consent: QifuConsent): Promise<QifuConsent> {
  const value = await gatewayJson('/qifu/v1/personalization', { method: 'POST', body: consent })
  const updated = isRecord(value) && isRecord(value.consent) ? value.consent : undefined
  if (updated === undefined || typeof updated.policy_version !== 'string') throw new Error('QIFU_CONSENT_INVALID')
  return {
    work_profile_read: updated.work_profile_read === true,
    memory_read: updated.memory_read === true,
    memory_write: updated.memory_write === true,
    local_context_read: updated.local_context_read === true,
    policy_version: updated.policy_version,
  }
}

/**
 * Resolve whether the current Web surface is backed by the device or cloud runtime.
 * @returns the runtime location selected by the desktop host.
 */
export async function readRuntimeMode(): Promise<'local' | 'cloud'> {
  return window.qifuDesktop === undefined ? 'cloud' : (await window.qifuDesktop.runtimeInfo()).mode
}
