/** Employee metadata returned by the same-origin authentication gateway. */
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
 * Read the current employee from the authenticated same-origin gateway.
 * @param signal - Cancellation signal tied to the rendering component.
 * @param fetchImpl - Browser fetch implementation.
 * @returns validated employee metadata, or undefined when unavailable.
 */
export async function readEmployeeIdentity(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<EmployeeIdentity | undefined> {
  const response = await fetchImpl('/auth/session', {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) return undefined
  return parseEmployeeIdentity(await response.json())
}
