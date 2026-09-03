import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { isAbsolute, join } from 'node:path'

const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=([A-Za-z0-9_-]+)/u
const MAX_STARTUP_OUTPUT_BYTES = 64 * 1024
const QIFU_CONTEXT_PLUGIN_VERSION = '0.1.2-alpha.3'
const CLOUD_WORKSPACE_DIRECTORY = 'cloud-workspace'
const CLOUD_WORKSPACE_TITLE = '云端工作区'
const QIFU_CONTEXT_PATCH = `- insert:
    - id: qifu-account-context
      name: '@deepseek-ai/dsh-qifu-account-context'
      config:
        endpointEnv: QIFUAI_CONTEXT_URL
        tokenEnv: QIFUAI_CONTEXT_TOKEN
        localContextEnv: QIFUAI_CONTEXT_LOCAL
        timeoutMs: 5000
        maxResponseBytes: 16384
`

function validateRuntimeOptions({ cliPath, cwd, dataRoot, certificatePath }) {
  for (const [name, value] of Object.entries({ cliPath, cwd, dataRoot, certificatePath })) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  }
}

function validateContextOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('contextOrigin must be an HTTPS origin')
  }
  return url.origin
}

async function writeAtomic(file, content) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, file)
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/** Ensure one employee runtime profile includes only the managed Qifu context extension. */
export async function ensureEmployeeWebProfile(dshHome) {
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error('DSH_HOME must be an absolute path')
  const profileDir = join(dshHome, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await writeAtomic(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@deepseek-ai/dsh-qifu-account-context': QIFU_CONTEXT_PLUGIN_VERSION },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'startup',
      },
    },
  }, null, 2)}\n`)
  const baseFiles = new Map([
    ['cordis.yml', '[]\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'],
  ])
  for (const [name, content] of baseFiles) {
    const file = join(profileDir, name)
    if (await readOptional(file) === '') await writeAtomic(file, content)
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const existingPatch = await readOptional(patchPath)
  if (existingPatch !== QIFU_CONTEXT_PATCH) await writeAtomic(patchPath, QIFU_CONTEXT_PATCH)
}

function validateRuntimeOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') {
    throw new Error('employee DSH runtime announced a non-loopback origin')
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('employee DSH runtime announced an invalid port')
  }
  return url
}

/** Derive a filesystem-safe, non-reversible storage key from the OA user id. */
export function employeeStorageKey(user) {
  if (typeof user !== 'string' || user.trim() === '') throw new Error('employee user id is required')
  return createHash('sha256').update(user).digest('hex')
}

/** Exchange one DSH launch token for the runtime's signed browser cookie. */
export function exchangeDshToken(origin, token, requestImpl = httpRequest) {
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      hostname: origin.hostname,
      port: origin.port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: origin.host },
    }, (response) => {
      response.resume()
      if (response.statusCode !== 303) {
        reject(new Error(`DSH token exchange returned HTTP ${String(response.statusCode)}`))
        return
      }
      const cookies = response.headers['set-cookie'] ?? []
      const session = cookies.map(value => value.split(';', 1)[0]).find(value => value.startsWith('dsh-auth-'))
      if (session === undefined) reject(new Error('DSH token exchange omitted its session cookie'))
      else resolve(session)
    })
    request.once('error', reject)
    request.end()
  })
}

async function dshRpc(origin, cookie, endpoint, args, fetchImpl) {
  const rpcId = `qifu-${randomUUID()}`
  const response = await fetchImpl(new URL(`/api/${endpoint}`, origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`DSH ${endpoint} returned HTTP ${String(response.status)}`)
  const body = await response.json()
  if (body?.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true) {
    const failure = body?.result?.error
    const detail = typeof failure?.code === 'string' && typeof failure?.message === 'string'
      ? `${failure.code}: ${failure.message}`
      : 'invalid response envelope'
    throw new Error(`DSH ${endpoint} failed: ${detail}`)
  }
  return body.result.value
}

/** Register and name the employee-owned server directory used by cloud conversations. */
export async function ensureEmployeeCloudWorkspace(origin, cookie, path, fetchImpl = fetch) {
  if (!(origin instanceof URL)) throw new Error('employee DSH origin must be a URL')
  validateRuntimeOrigin(origin.href)
  if (typeof cookie !== 'string' || !cookie.startsWith('dsh-auth-')) {
    throw new Error('employee DSH session cookie is required')
  }
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('cloud Workspace path must be absolute')
  const created = await dshRpc(origin, cookie, 'workspace/create', { request: { path } }, fetchImpl)
  const workspace = created?.workspace
  if (typeof workspace?.workspaceId !== 'string' || typeof workspace.title !== 'string') {
    throw new Error('DSH workspace/create omitted its Workspace')
  }
  if (workspace.title === CLOUD_WORKSPACE_TITLE) return workspace
  const renamed = await dshRpc(origin, cookie, 'workspace/rename', {
    request: { workspaceId: workspace.workspaceId, title: CLOUD_WORKSPACE_TITLE },
  }, fetchImpl)
  if (typeof renamed?.workspace?.workspaceId !== 'string'
    || renamed.workspace.workspaceId !== workspace.workspaceId
    || renamed.workspace.title !== CLOUD_WORKSPACE_TITLE) {
    throw new Error('DSH workspace/rename omitted the managed Cloud Workspace')
  }
  return renamed.workspace
}

/** Lazily own one persistent DSH_HOME and one loopback DSH process per OA employee. */
export function createDshRuntimeProvider(options) {
  const cliPath = options.cliPath
  const cwd = options.cwd
  const dataRoot = options.dataRoot
  const certificatePath = options.certificatePath
  validateRuntimeOptions({ cliPath, cwd, dataRoot, certificatePath })
  const contextOrigin = validateContextOrigin(options.contextOrigin)
  const spawnImpl = options.spawnImpl ?? spawn
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const prepareHomeImpl = options.prepareHomeImpl ?? ensureEmployeeWebProfile
  const exchangeImpl = options.exchangeImpl ?? exchangeDshToken
  const ensureWorkspaceImpl = options.ensureWorkspaceImpl ?? ensureEmployeeCloudWorkspace
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  const entries = new Map()
  let disposed = false

  function stop(key, entry) {
    if (entries.get(key) === entry) entries.delete(key)
    if (entry.child !== undefined
      && entry.child.exitCode === null
      && entry.child.signalCode === null) entry.child.kill('SIGTERM')
  }

  async function start(user, sessionToken) {
    if (disposed) throw new Error('employee DSH runtime provider is disposed')
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(sessionToken)) {
      throw new Error('employee gateway session token is required')
    }
    const key = employeeStorageKey(user)
    const tokenHash = createHash('sha256').update(sessionToken).digest('base64url')
    const existing = entries.get(key)
    if (existing !== undefined && existing.tokenHash === tokenHash) return existing.ready
    if (existing !== undefined) stop(key, existing)

    const entry = { child: undefined, ready: undefined, tokenHash }
    entry.ready = (async () => {
      const home = join(dataRoot, key)
      await mkdirImpl(home, { recursive: true, mode: 0o700 })
      const cloudWorkspace = join(home, CLOUD_WORKSPACE_DIRECTORY)
      await mkdirImpl(cloudWorkspace, { recursive: true, mode: 0o700 })
      const dshHome = join(home, '.dsh')
      await prepareHomeImpl(dshHome)
      if (disposed || entries.get(key) !== entry) throw new Error('employee DSH runtime start was superseded')

      const child = spawnImpl('/usr/bin/node', [
        cliPath, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
      ], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          DSH_HOME: dshHome,
          CI: 'true',
          NODE_ENV: 'production',
          NODE_EXTRA_CA_CERTS: certificatePath,
          QIFUAI_CONTEXT_URL: `${contextOrigin}/qifu/v1/personalization/context`,
          QIFUAI_CONTEXT_TOKEN: sessionToken,
          QIFUAI_CONTEXT_LOCAL: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      entry.child = child
      return new Promise((resolve, reject) => {
      let settled = false
      let initializing = false
      let output = ''
      const timeout = setTimeout(() => fail(new Error('employee DSH runtime startup timed out')), startupTimeoutMs)
      timeout.unref?.()

      const cleanupStartupListeners = () => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.stderr.off('data', onData)
        child.off('error', fail)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanupStartupListeners()
        stop(key, entry)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onData = (chunk) => {
        if (settled) return
        output = `${output}${String(chunk)}`.slice(-MAX_STARTUP_OUTPUT_BYTES)
        const match = READY_PATTERN.exec(output)
        if (match === null || initializing) return
        initializing = true
        const origin = validateRuntimeOrigin(match[1])
        const token = match[2]
        void exchangeImpl(origin, token).then(async (cookie) => {
          await ensureWorkspaceImpl(origin, cookie, cloudWorkspace)
          if (settled) return
          if (disposed || entries.get(key) !== entry) {
            throw new Error('employee DSH runtime start was superseded')
          }
          settled = true
          output = ''
          cleanupStartupListeners()
          child.stdout.resume()
          child.stderr.resume()
          child.once('error', () => stop(key, entry))
          resolve({
            origin,
            cookie,
            invalidate: () => stop(key, entry),
          })
        }).catch(fail)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', fail)
      child.once('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(`employee DSH runtime exited during startup (${String(code ?? signal)})`))
          return
        }
        if (entries.get(key) === entry) entries.delete(key)
      })
      })
    })().catch((error) => {
      stop(key, entry)
      throw error
    })
    entries.set(key, entry)
    return entry.ready
  }

  return {
    get: start,
    dispose() {
      if (disposed) return
      disposed = true
      for (const [key, entry] of entries) stop(key, entry)
    },
  }
}
