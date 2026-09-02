/** Employee metadata returned by the desktop authentication gateway. */
export interface EmployeeIdentity {
  readonly id: string
  readonly name: string
  readonly designation: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the untrusted gateway session response.
 * @param value - Parsed response JSON.
 * @returns validated employee metadata, or undefined for a missing/invalid profile.
 */
export function parseEmployeeIdentity(value: unknown): EmployeeIdentity | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.employee)) return undefined
  const { id, name, designation } = value.employee
  if (typeof id !== 'string' || id.trim() === ''
    || typeof name !== 'string' || name.trim() === ''
    || typeof designation !== 'string') return undefined
  return { id: id.trim(), name: name.trim(), designation: designation.trim() }
}

/**
 * Read the current employee from the authenticated desktop gateway.
 * @param signal - Cancellation signal tied to the rendering component.
 * @returns validated employee metadata, or undefined when unavailable.
 */
export async function readEmployeeIdentity(signal: AbortSignal): Promise<EmployeeIdentity | undefined> {
  const bridge = (window as unknown as {
    qifuDesktop?: {
      gatewayRequest(path: string): Promise<{ readonly status: number; readonly body: unknown }>
    }
  }).qifuDesktop
  if (bridge === undefined) return undefined
  const response = await bridge.gatewayRequest('/auth/session')
  if (signal.aborted || response.status < 200 || response.status >= 300) return undefined
  return parseEmployeeIdentity(response.body)
}
