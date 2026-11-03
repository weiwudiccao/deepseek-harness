/** Browser-safe metadata for employee-owned Office documents. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity admitted by the Office document store. */
export type OfficeDocumentId = Branded<'QifuOfficeDocumentId'>

/** One immutable original or generated document retained by its owning Session. */
export interface OfficeDocument {
  readonly id: OfficeDocumentId
  readonly name: string
  readonly format: string
  readonly kind: 'original' | 'generated'
  readonly bytes: number
  readonly sha256: string
  readonly createdAt: string
}
