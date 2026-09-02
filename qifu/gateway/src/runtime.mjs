import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { isAbsolute, join } from 'node:path'

const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/)\?token=([A-Za-z0-9_-]+)/u
const MAX_STARTUP_OUTPUT_BYTES = 64 * 1024

function validateRuntimeOptions({ cliPath, cwd, dataRoot }) {
  for (const [name, value] of Object.entries({ cliPath, cwd, dataRoot })) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  }
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

/** Lazily own one persistent DSH_HOME and one loopback DSH process per OA employee. */
export function createDshRuntimeProvider(options) {
  const cliPath = options.cliPath
  const cwd = options.cwd
  const dataRoot = options.dataRoot
  validateRuntimeOptions({ cliPath, cwd, dataRoot })
  const spawnImpl = options.spawnImpl ?? spawn
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const exchangeImpl = options.exchangeImpl ?? exchangeDshToken
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  const entries = new Map()
  let disposed = false

  function stop(key, entry) {
    if (entries.get(key) === entry) entries.delete(key)
    if (entry.child !== undefined
      && entry.child.exitCode === null
      && entry.child.signalCode === null) entry.child.kill('SIGTERM')
  }

  async function start(user) {
    if (disposed) throw new Error('employee DSH runtime provider is disposed')
    const key = employeeStorageKey(user)
    const existing = entries.get(key)
    if (existing !== undefined) return existing.ready

    const entry = { child: undefined, ready: undefined }
    entry.ready = (async () => {
      const home = join(dataRoot, key)
      await mkdirImpl(home, { recursive: true, mode: 0o700 })
      if (disposed) throw new Error('employee DSH runtime provider is disposed')

      const child = spawnImpl('/usr/bin/node', [
        cliPath, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
      ], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          DSH_HOME: join(home, '.dsh'),
          CI: 'true',
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      entry.child = child
      return new Promise((resolve, reject) => {
      let settled = false
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
        if (match === null) return
        const origin = validateRuntimeOrigin(match[1])
        const token = match[2]
        void exchangeImpl(origin, token).then((cookie) => {
          if (settled) return
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
        }, fail)
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
