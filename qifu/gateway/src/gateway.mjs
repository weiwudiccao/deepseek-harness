import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const LOGIN_PATH = '/auth/login'
const LOGOUT_PATH = '/auth/logout'
const SESSION_PATH = '/auth/session'
const BOOTSTRAP_PATH = '/qifu/v1/bootstrap'
const HEALTH_PATH = '/healthz'
const MODEL_PREFIX = '/qifu-model/v1/'
const BODY_LIMIT_BYTES = 16 * 1024
const OA_BODY_LIMIT_BYTES = 1024 * 1024
const MODEL_BODY_LIMIT_BYTES = 32 * 1024 * 1024
const SESSION_TOKEN_BYTES = 32
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_REVALIDATE_MS = 5 * 60 * 1000
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000
const DEFAULT_RATE_ATTEMPTS = 5
const EMPLOYEE_LOGIN_CSRF_PATH = '/api/method/custom_api_docs.employee_auth.get_login_csrf_token?fresh_login=1'
const EMPLOYEE_LOGIN_PATH = '/api/method/custom_api_docs.employee_auth.login'
const EMPLOYEE_BOOTSTRAP_PATH = '/api/method/zkkg_ai.api.client_bootstrap.get_bootstrap'
const OA_API_ROUTES = new Map([
  ['GET /qifu/v1/cloud/workspaces', '/api/method/zkkg_ai.api.cloud_work.list_workspaces'],
  ['GET /qifu/v1/cloud/items', '/api/method/zkkg_ai.api.cloud_work.list_items'],
  ['GET /qifu/v1/cloud/item', '/api/method/zkkg_ai.api.cloud_work.get_item'],
  ['POST /qifu/v1/cloud/transfers/start', '/api/method/zkkg_ai.api.cloud_work.start_transfer'],
  ['POST /qifu/v1/cloud/transfers/part', '/api/method/zkkg_ai.api.cloud_work.put_transfer_part'],
  ['POST /qifu/v1/cloud/transfers/commit', '/api/method/zkkg_ai.api.cloud_work.commit_transfer'],
  ['POST /qifu/v1/cloud/transfers/cancel', '/api/method/zkkg_ai.api.cloud_work.cancel_transfer'],
  ['GET /qifu/v1/personalization', '/api/method/zkkg_ai.api.personalization.get_personalization'],
  ['POST /qifu/v1/personalization', '/api/method/zkkg_ai.api.personalization.update_personalization'],
  ['POST /qifu/v1/personalization/memory/confirm', '/api/method/zkkg_ai.api.personalization.confirm_memory'],
])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

class InvalidCredentialsError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(`${JSON.stringify(body)}\n`)
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

function sessionHash(token) {
  return createHash('sha256').update(token).digest('base64url')
}

function sessionCookie(name, token, maxAgeSeconds, secure) {
  const secureAttribute = secure ? '; Secure' : ''
  return `${name}=${token}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Strict${secureAttribute}`
}

function expiredSessionCookie(name, secure) {
  const secureAttribute = secure ? '; Secure' : ''
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secureAttribute}`
}

function setCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = headers.get('set-cookie')
  return combined === null ? [] : [combined]
}

function frappeSessionCookie(headers) {
  for (const value of setCookieValues(headers)) {
    const match = /(?:^|[,;]\s*)sid=([^;,\s]+)/u.exec(value)
    if (match?.[1] !== undefined) return `sid=${match[1]}`
  }
  return undefined
}

function employeeProfile(payload, user) {
  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : payload
  const employee = isRecord(message) && isRecord(message.employee) ? message.employee : undefined
  if (employee === undefined) throw new Error('OA employee login omitted its employee profile')
  const id = typeof employee.name === 'string' && employee.name.trim() !== ''
    ? employee.name.trim()
    : user
  const name = typeof employee.employee_name === 'string' && employee.employee_name.trim() !== ''
    ? employee.employee_name.trim()
    : user
  const designation = typeof employee.designation === 'string' ? employee.designation.trim() : ''
  return { id, name, designation }
}

async function readBody(request, limit = BODY_LIMIT_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body exceeds the configured limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readRawBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body exceeds the configured limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseCredentials(body) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    throw new InvalidCredentialsError('invalid JSON')
  }
  if (!isRecord(value)
    || typeof value.account !== 'string'
    || typeof value.password !== 'string') {
    throw new InvalidCredentialsError('missing credentials')
  }
  const account = value.account.trim()
  if (account.length === 0 || account.length > 254 || value.password.length === 0 || value.password.length > 1024) {
    throw new InvalidCredentialsError('invalid credential length')
  }
  return { account, password: value.password }
}

function validateBaseUrl(value, allowHttp) {
  const url = new URL(value)
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Frappe base URL must contain only an origin')
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('Frappe base URL must use HTTPS')
  }
  return url
}

function validateDshOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('DSH origin must be a loopback HTTP origin')
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw new Error('DSH origin must use a loopback hostname')
  }
  return url
}

function validateModelBaseUrl(value, allowHttp) {
  const url = new URL(value)
  if (url.search !== '' || url.hash !== '') throw new Error('model base URL must not contain a query or fragment')
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('model base URL must use HTTPS')
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  return url
}

function allowedModelRequest(method, pathname) {
  if (method === 'POST' && pathname === 'chat/completions') return true
  if ((method === 'POST' || method === 'GET') && pathname === 'files') return true
  if ((method === 'GET' || method === 'DELETE') && /^files\/[^/]+$/u.test(pathname)) return true
  return false
}

/** Proxy the authenticated local runtime to the server-owned model credential. */
export function createModelForwarder({ baseUrl, apiKey, fetchImpl = fetch, allowHttp = false }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('model API key is required')
  const origin = validateModelBaseUrl(baseUrl, allowHttp)
  return async function forwardModel(request, response, gatewayUrl) {
    const method = request.method ?? 'GET'
    const pathname = gatewayUrl.pathname.slice(MODEL_PREFIX.length)
    if (!allowedModelRequest(method, pathname)) {
      json(response, 404, { ok: false, message: '模型接口不存在。' })
      return
    }
    let body
    try {
      body = method === 'GET' || method === 'HEAD'
        ? undefined
        : await readRawBody(request, MODEL_BODY_LIMIT_BYTES)
    } catch {
      json(response, 413, { ok: false, message: '模型请求内容过大。' })
      return
    }
    const target = new URL(`${pathname}${gatewayUrl.search}`, origin)
    const headers = new Headers({
      accept: request.headers.accept ?? 'application/json',
      authorization: `Bearer ${apiKey}`,
    })
    if (typeof request.headers['content-type'] === 'string') {
      headers.set('content-type', request.headers['content-type'])
    }
    let upstream
    try {
      upstream = await fetchImpl(target, { method, headers, body, redirect: 'manual' })
    } catch {
      json(response, 502, { ok: false, message: '模型服务暂时不可用。' })
      return
    }
    const headersOut = {}
    for (const [name, value] of upstream.headers) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') {
        headersOut[name] = value
      }
    }
    response.writeHead(upstream.status, headersOut)
    if (upstream.body === null) {
      response.end()
      return
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body), response)
    } catch {
      response.destroy()
    }
  }
}

/** Validate credentials and resolve the current Frappe user without retaining the password. */
export function createFrappeAuthenticator({ baseUrl, fetchImpl = fetch, allowHttp = false }) {
  const origin = validateBaseUrl(baseUrl, allowHttp)

  async function fetchCsrfToken(cookie) {
    const response = await fetchImpl(new URL(EMPLOYEE_LOGIN_CSRF_PATH, origin), {
      method: 'GET',
      headers: { accept: 'application/json', cookie },
      redirect: 'manual',
    })
    if (!response.ok) throw new Error('OA employee CSRF refresh failed')
    const payload = await response.json()
    const token = isRecord(payload)
      && isRecord(payload.message)
      && typeof payload.message.csrf_token === 'string'
      ? payload.message.csrf_token
      : undefined
    if (token === undefined) throw new Error('OA employee CSRF refresh was incomplete')
    return token
  }

  async function currentUser(cookie) {
    const response = await fetchImpl(new URL('/api/method/frappe.auth.get_logged_user', origin), {
      method: 'GET',
      headers: { accept: 'application/json', cookie },
      redirect: 'manual',
    })
    if (!response.ok) throw new InvalidCredentialsError('Frappe session was rejected')
    const payload = await response.json()
    if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message === 'Guest') {
      throw new InvalidCredentialsError('Frappe session has no employee user')
    }
    return payload.message
  }

  return {
    async login(account, password) {
      const csrfResponse = await fetchImpl(new URL(EMPLOYEE_LOGIN_CSRF_PATH, origin), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
      })
      if (!csrfResponse.ok) throw new Error('OA employee login CSRF request failed')
      const guestCookie = frappeSessionCookie(csrfResponse.headers)
      const csrfPayload = await csrfResponse.json()
      const csrfToken = isRecord(csrfPayload)
        && isRecord(csrfPayload.message)
        && typeof csrfPayload.message.csrf_token === 'string'
        ? csrfPayload.message.csrf_token
        : undefined
      if (guestCookie === undefined || csrfToken === undefined) {
        throw new Error('OA employee login CSRF response was incomplete')
      }

      const response = await fetchImpl(new URL(EMPLOYEE_LOGIN_PATH, origin), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie: guestCookie,
          'x-frappe-csrf-token': csrfToken,
        },
        body: JSON.stringify({ mobile: account, password }),
        redirect: 'manual',
      })
      const payload = await response.json()
      if (response.status === 401 || (isRecord(payload) && payload.exc_type === 'AuthenticationError')) {
        throw new InvalidCredentialsError('OA employee login rejected the credentials')
      }
      if (!response.ok || (isRecord(payload) && typeof payload.exc_type === 'string')) {
        throw new Error('OA employee login request failed')
      }
      const cookie = frappeSessionCookie(response.headers)
      if (cookie === undefined) throw new Error('OA employee login omitted its session cookie')
      const user = await currentUser(cookie)
      return { user, employee: employeeProfile(payload, user), cookie, csrfToken: await fetchCsrfToken(cookie) }
    },
    currentUser,
    async bootstrap(cookie) {
      const response = await fetchImpl(new URL(EMPLOYEE_BOOTSTRAP_PATH, origin), {
        method: 'GET',
        headers: { accept: 'application/json', cookie },
        redirect: 'manual',
      })
      if (response.status === 401 || response.status === 403) {
        throw new InvalidCredentialsError('OA employee bootstrap rejected the session')
      }
      const payload = await response.json()
      if (!response.ok || !isRecord(payload) || !isRecord(payload.message)) {
        throw new Error('OA employee bootstrap request failed')
      }
      return payload.message
    },
    async request(cookie, csrf, method, pathname, search, body) {
      const target = new URL(pathname, origin)
      target.search = search
      const headers = { accept: 'application/json', cookie }
      if (method === 'POST') {
        headers['content-type'] = 'application/json'
        headers['x-frappe-csrf-token'] = csrf
      }
      const response = await fetchImpl(target, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        redirect: 'manual',
      })
      if (response.status === 401 || response.status === 403) {
        throw new InvalidCredentialsError('OA employee API rejected the session')
      }
      const payload = await response.json()
      if (!response.ok || (isRecord(payload) && typeof payload.exc_type === 'string')) {
        const message = isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : '云端工作服务暂时不可用。'
        const error = new Error(message)
        error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502
        throw error
      }
      return isRecord(payload) && Object.hasOwn(payload, 'message') ? payload.message : payload
    },
    async logout(cookie) {
      try {
        await fetchImpl(new URL('/api/method/logout', origin), {
          method: 'GET',
          headers: { accept: 'application/json', cookie },
          redirect: 'manual',
        })
      } catch {
        // Local gateway revocation remains authoritative when OA logout is temporarily unavailable.
      }
    },
  }
}

function createSessionStore({ authenticator, ttlMs, revalidateMs, now }) {
  const sessions = new Map()

  function create(user, employee, oaCookie, csrfToken) {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    const timestamp = now()
    sessions.set(sessionHash(token), {
      user,
      employee,
      oaCookie,
      csrfToken,
      modelInFlight: 0,
      expiresAt: timestamp + ttlMs,
      revalidateAt: timestamp + revalidateMs,
    })
    return token
  }

  async function resolve(token) {
    if (token === undefined) return undefined
    const key = sessionHash(token)
    const record = sessions.get(key)
    if (record === undefined) return undefined
    const timestamp = now()
    if (record.expiresAt <= timestamp) {
      sessions.delete(key)
      return undefined
    }
    if (record.revalidateAt <= timestamp) {
      try {
        const user = await authenticator.currentUser(record.oaCookie)
        if (user !== record.user) throw new InvalidCredentialsError('Frappe user changed')
        record.revalidateAt = timestamp + revalidateMs
      } catch {
        sessions.delete(key)
        return undefined
      }
    }
    return { key, record }
  }

  function remove(token) {
    if (token === undefined) return undefined
    const key = sessionHash(token)
    const record = sessions.get(key)
    sessions.delete(key)
    return record
  }

  function cleanup() {
    const timestamp = now()
    for (const [key, record] of sessions) {
      if (record.expiresAt <= timestamp) sessions.delete(key)
    }
  }

  return { create, resolve, remove, cleanup }
}

function createRateLimiter({ attempts, windowMs, now }) {
  const failures = new Map()

  function retryAfterMs(key) {
    const timestamp = now()
    const record = failures.get(key)
    if (record === undefined) return 0
    if (record.resetAt <= timestamp) {
      failures.delete(key)
      return 0
    }
    return record.count < attempts ? 0 : record.resetAt - timestamp
  }

  function failed(key) {
    const timestamp = now()
    const record = failures.get(key)
    if (record === undefined || record.resetAt <= timestamp) {
      failures.set(key, { count: 1, resetAt: timestamp + windowMs })
      return
    }
    record.count += 1
  }

  function succeeded(key) {
    failures.delete(key)
  }

  return { retryAfterMs, failed, succeeded }
}

function loginRateKey(remote, account) {
  const accountHash = createHash('sha256').update(account.toLowerCase()).digest('base64url')
  return `${remote}:${accountHash}`
}

function requestHeaders(headers, replacements = {}) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
    result[name] = value
  }
  for (const [name, value] of Object.entries(replacements)) {
    if (value === undefined) delete result[name]
    else result[name] = value
  }
  return result
}

function responseHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'set-cookie') continue
    result[name] = value
  }
  return result
}

function proxyHttp(request, response, runtime) {
  const upstream = runtime.origin
  const proxy = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers: requestHeaders(request.headers, {
      host: upstream.host,
      cookie: runtime.cookie,
      origin: undefined,
      'sec-fetch-site': undefined,
    }),
  }, (upstreamResponse) => {
    if (upstreamResponse.statusCode === 401) runtime.invalidate()
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers))
    upstreamResponse.pipe(response)
  })
  proxy.once('error', () => {
    if (!response.headersSent) json(response, 502, { ok: false, message: '企福AI智脑服务暂时不可用。' })
    else response.destroy()
  })
  request.pipe(proxy)
}

function proxyUpgrade(request, socket, head, runtime) {
  const upstream = runtime.origin
  const target = netConnect(Number(upstream.port), upstream.hostname)
  target.once('connect', () => {
    const headers = requestHeaders(request.headers, {
      host: upstream.host,
      cookie: runtime.cookie,
      origin: upstream.origin,
      connection: 'Upgrade',
      upgrade: request.headers.upgrade ?? 'websocket',
    })
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`]
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    target.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) target.write(head)
    socket.pipe(target).pipe(socket)
  })
  const fail = () => socket.destroy()
  target.once('error', fail)
  socket.once('error', () => target.destroy())
}

/** Create the HTTPS gateway request and WebSocket upgrade handlers. */
export function createGateway(options) {
  const authenticator = options.authenticator
  const runtimes = options.runtimes
  const modelForwarder = options.modelForwarder
  const modelConcurrency = options.modelConcurrency ?? 4
  if (!Number.isSafeInteger(modelConcurrency) || modelConcurrency < 1) {
    throw new Error('modelConcurrency must be a positive integer')
  }
  const cookieName = options.cookieName ?? 'qifuai_gateway_session'
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS
  const now = options.now ?? Date.now
  const secureCookies = options.secureCookies ?? true
  const sessions = createSessionStore({ authenticator, ttlMs, revalidateMs, now })
  const limiter = createRateLimiter({
    attempts: options.rateAttempts ?? DEFAULT_RATE_ATTEMPTS,
    windowMs: options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
    now,
  })
  const cleanup = setInterval(() => sessions.cleanup(), Math.min(ttlMs, 60_000))
  cleanup.unref()

  function tokenFrom(request) {
    return cookieValue(request.headers.cookie, cookieName)
  }

  function bearerTokenFrom(request) {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string') return undefined
    const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization)
    return match?.[1]
  }

  async function requireSession(request, response, token = tokenFrom(request)) {
    const session = await sessions.resolve(token)
    if (session !== undefined) return session
    json(response, 401, { ok: false, message: '登录已失效，请重新登录。' })
    return undefined
  }

  async function handleLogin(request, response) {
    const remote = request.socket.remoteAddress ?? 'unknown'
    if (request.method !== 'POST' || !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      json(response, 415, { ok: false, message: '登录请求格式不正确。' })
      return
    }
    let rateKey
    try {
      const credentials = parseCredentials(await readBody(request))
      rateKey = loginRateKey(remote, credentials.account)
      const retryAfterMs = limiter.retryAfterMs(rateKey)
      if (retryAfterMs > 0) {
        const retryAfterSeconds = Math.ceil(retryAfterMs / 1000)
        const retryAfterMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
        json(response, 429, {
          ok: false,
          message: `登录尝试次数过多，请在 ${String(retryAfterMinutes)} 分钟后重试。`,
          retry_after_seconds: retryAfterSeconds,
        }, { 'retry-after': String(retryAfterSeconds) })
        return
      }
      const identity = await authenticator.login(credentials.account, credentials.password)
      const token = sessions.create(identity.user, identity.employee, identity.cookie, identity.csrfToken)
      limiter.succeeded(rateKey)
      json(response, 200, { ok: true, user: identity.user, employee: identity.employee }, {
        'set-cookie': sessionCookie(cookieName, token, Math.floor(ttlMs / 1000), secureCookies),
      })
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        if (rateKey !== undefined) limiter.failed(rateKey)
        json(response, 401, { ok: false, message: '员工手机号或密码不正确。' })
        return
      }
      json(response, 502, { ok: false, message: '正式 OA 登录服务暂时不可用。' })
    }
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'https://gateway.invalid')
    if (url.pathname === HEALTH_PATH) {
      json(response, 200, { ok: true })
      return
    }
    if (url.pathname === LOGIN_PATH) {
      await handleLogin(request, response)
      return
    }
    if (url.pathname === LOGOUT_PATH) {
      const record = sessions.remove(tokenFrom(request))
      if (record !== undefined) void authenticator.logout(record.oaCookie)
      json(response, 200, { ok: true }, {
        'set-cookie': expiredSessionCookie(cookieName, secureCookies),
      })
      return
    }
    if (url.pathname.startsWith(MODEL_PREFIX)) {
      const authenticated = await requireSession(request, response, bearerTokenFrom(request) ?? tokenFrom(request))
      if (authenticated === undefined) return
      if (modelForwarder === undefined) {
        json(response, 503, { ok: false, message: '模型服务尚未配置。' })
        return
      }
      if (authenticated.record.modelInFlight >= modelConcurrency) {
        json(response, 429, { ok: false, message: '并发任务过多，请等待当前任务完成。' }, { 'retry-after': '2' })
        return
      }
      authenticated.record.modelInFlight += 1
      try {
        await modelForwarder(request, response, url)
      } finally {
        authenticated.record.modelInFlight -= 1
      }
      return
    }
    const authenticated = await requireSession(request, response)
    if (authenticated === undefined) return
    if (url.pathname === SESSION_PATH) {
      json(response, 200, {
        ok: true,
        user: authenticated.record.user,
        employee: authenticated.record.employee,
      })
      return
    }
    if (url.pathname === BOOTSTRAP_PATH) {
      try {
        json(response, 200, await authenticator.bootstrap(authenticated.record.oaCookie))
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          sessions.remove(tokenFrom(request))
          json(response, 401, { ok: false, message: '登录已失效，请重新登录。' }, {
            'set-cookie': expiredSessionCookie(cookieName, secureCookies),
          })
          return
        }
        json(response, 502, { ok: false, message: '员工权限服务暂时不可用。' })
      }
      return
    }
    const oaApiPath = OA_API_ROUTES.get(`${request.method ?? 'GET'} ${url.pathname}`)
    if (oaApiPath !== undefined) {
      try {
        const body = request.method === 'POST' ? await readBody(request, OA_BODY_LIMIT_BYTES) : undefined
        json(
          response,
          200,
          await authenticator.request(
            authenticated.record.oaCookie,
            authenticated.record.csrfToken,
            request.method ?? 'GET',
            oaApiPath,
            url.search,
            body,
          ),
        )
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          sessions.remove(tokenFrom(request))
          json(response, 401, { ok: false, message: '登录已失效，请重新登录。' }, {
            'set-cookie': expiredSessionCookie(cookieName, secureCookies),
          })
          return
        }
        json(response, Number.isSafeInteger(error?.statusCode) ? error.statusCode : 502, {
          ok: false,
          message: error instanceof Error ? error.message : '云端工作服务暂时不可用。',
        })
      }
      return
    }
    try {
      proxyHttp(request, response, await runtimes.get(authenticated.record.user))
    } catch {
      json(response, 502, { ok: false, message: '企福AI智脑服务暂时不可用。' })
    }
  }

  async function handleUpgrade(request, socket, head) {
    const authenticated = await sessions.resolve(tokenFrom(request))
    if (authenticated === undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    try {
      proxyUpgrade(request, socket, head, await runtimes.get(authenticated.record.user))
    } catch {
      socket.destroy()
    }
  }

  return {
    handleRequest,
    handleUpgrade,
    dispose() {
      clearInterval(cleanup)
      runtimes.dispose()
    },
  }
}
