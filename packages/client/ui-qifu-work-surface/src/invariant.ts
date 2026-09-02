/** Package-owned invariant companion for the Qifu employee work surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-qifu-work-surface'

/** Cordis companion plugin name. */
export const name = 'client-ui-qifu-work-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: data is validated at the gateway response boundary. */
const install: InvariantInstaller = () => {}

/** Register package ownership with the invariant service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
