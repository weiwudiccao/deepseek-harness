import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import test from 'node:test'
import { createFrappeAuthenticator, createGateway, createModelForwarder } from '../src/gateway.mjs'

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server omitted its TCP address')
  return {
    origin: new URL(`http://127.0.0.1:${String(address.port)}/`),
    close: () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

test('Frappe authentication retains the formal OA employee profile', async () => {
  const calls = []
  const responses = [
    new Response(JSON.stringify({ message: { csrf_token: 'csrf-token' } }), {
      status: 200,
      headers: { 'set-cookie': 'sid=guest-session; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({
      message: {
        authenticated: true,
        employee: {
          name: 'HR-EMP-0001',
          employee_name: '员工甲',
          designation: '产品经理',
        },
      },
    }), {
      status: 200,
      headers: { 'set-cookie': 'sid=employee-session; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({ message: 'employee-a@example.com' }), { status: 200 }),
    new Response(JSON.stringify({ message: { csrf_token: 'employee-csrf-token' } }), { status: 200 }),
  ]
  const authenticator = createFrappeAuthenticator({
    baseUrl: 'https://oa.example.com',
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options })
      const response = responses.shift()
      assert.ok(response)
      return response
    },
  })

  const result = await authenticator.login('employee-account', 'test-only-password')

  assert.deepEqual(result, {
    user: 'employee-a@example.com',
    employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
    cookie: 'sid=employee-session',
    csrfToken: 'employee-csrf-token',
  })
  assert.equal(calls[1].url, 'https://oa.example.com/api/method/custom_api_docs.employee_auth.login')
  assert.equal(calls[1].options.headers.cookie, 'sid=guest-session')
  assert.equal(calls[2].options.headers.cookie, 'sid=employee-session')
  assert.equal(calls[3].options.headers.cookie, 'sid=employee-session')
})

test('Frappe bootstrap forwards the authenticated OA session cookie', async () => {
  const calls = []
  const authenticator = createFrappeAuthenticator({
    baseUrl: 'https://oa.example.com',
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options })
      return new Response(JSON.stringify({
        message: {
          version: 1,
          capability_revision: 'revision-1',
          features: [{ feature_code: 'digital-employee-b1' }],
        },
      }), { status: 200 })
    },
  })

  const result = await authenticator.bootstrap('sid=employee-session')

  assert.equal(result.capability_revision, 'revision-1')
  assert.equal(calls[0].url, 'https://oa.example.com/api/method/zkkg_ai.api.client_bootstrap.get_bootstrap')
  assert.equal(calls[0].options.headers.cookie, 'sid=employee-session')
})

test('authenticated bootstrap returns only the OA-authorized feature manifest', async (context) => {
  const bootstrap = {
    version: 1,
    employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
    features: [{ feature_code: 'digital-employee-b1', label: '弈 · Genesis' }],
    capability_revision: 'revision-1',
  }
  const gateway = createGateway({
    authenticator: {
      async login() {
        return {
          user: 'employee-a@example.com',
          employee: bootstrap.employee,
          cookie: 'sid=oa-a',
        }
      },
      async currentUser() { return 'employee-a@example.com' },
      async bootstrap(cookie) {
        assert.equal(cookie, 'sid=oa-a')
        return bootstrap
      },
      async logout() {},
    },
    runtimes: {
      async get() { throw new Error('bootstrap must not start a DSH runtime') },
      dispose() {},
    },
    secureCookies: false,
  })
  context.after(() => gateway.dispose())
  const server = await listen(gateway.handleRequest)
  context.after(server.close)

  const login = await fetch(new URL('/auth/login', server.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'employee-a', password: 'correct-password' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)
  const response = await fetch(new URL('/qifu/v1/bootstrap', server.origin), { headers: { cookie } })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), bootstrap)
})

test('cloud and personalization routes forward only the authenticated OA session', async (context) => {
  const requests = []
  const gateway = createGateway({
    authenticator: {
      async login() {
        return {
          user: 'employee-a@example.com',
          employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
          cookie: 'sid=oa-a',
          csrfToken: 'csrf-oa-a',
        }
      },
      async currentUser() { return 'employee-a@example.com' },
      async request(cookie, csrf, method, pathname, search, body) {
        requests.push({ cookie, csrf, method, pathname, search, body })
        return { items: [{ id: 'cwi-1', title: '云端对话' }] }
      },
      async logout() {},
    },
    runtimes: {
      async get() { throw new Error('OA routes must not start a DSH runtime') },
      dispose() {},
    },
    secureCookies: false,
  })
  context.after(() => gateway.dispose())
  const server = await listen(gateway.handleRequest)
  context.after(server.close)

  const login = await fetch(new URL('/auth/login', server.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'employee-a', password: 'correct-password' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)
  const response = await fetch(new URL('/qifu/v1/cloud/items?kind=Conversation', server.origin), {
    headers: { cookie },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { items: [{ id: 'cwi-1', title: '云端对话' }] })
  const download = await fetch(new URL('/qifu/v1/cloud/item/download', server.origin), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ item_id: 'cwi-1', device_id: 'device-a' }),
  })
  assert.equal(download.status, 200)
  const token = cookie.split('=', 2)[1]
  assert.ok(token)
  const contextResponse = await fetch(new URL('/qifu/v1/personalization/context', server.origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ local_context: false, message: '请先给结论' }),
  })
  assert.equal(contextResponse.status, 200)
  assert.deepEqual(requests, [
    {
      cookie: 'sid=oa-a',
      csrf: 'csrf-oa-a',
      method: 'GET',
      pathname: '/api/method/zkkg_ai.api.cloud_work.list_items',
      search: '?kind=Conversation',
      body: undefined,
    },
    {
      cookie: 'sid=oa-a',
      csrf: 'csrf-oa-a',
      method: 'POST',
      pathname: '/api/method/zkkg_ai.api.cloud_work.download_item',
      search: '',
      body: '{"item_id":"cwi-1","device_id":"device-a"}',
    },
    {
      cookie: 'sid=oa-a',
      csrf: 'csrf-oa-a',
      method: 'POST',
      pathname: '/api/method/zkkg_ai.api.personalization.get_personalization_context',
      search: '',
      body: '{"local_context":false,"message":"请先给结论"}',
    },
  ])
})

test('authenticated employees receive isolated upstream runtimes and employee metadata', async (context) => {
  const upstream = async (label) => listen((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ label, cookie: request.headers.cookie }))
  })
  const employeeA = await upstream('employee-a-runtime')
  const employeeB = await upstream('employee-b-runtime')
  context.after(async () => Promise.all([employeeA.close(), employeeB.close()]))

  const identities = {
    'employee-a': {
      user: 'employee-a@example.com',
      employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
      cookie: 'sid=oa-a',
    },
    'employee-b': {
      user: 'employee-b@example.com',
      employee: { id: 'HR-EMP-0002', name: '员工乙', designation: '研发工程师' },
      cookie: 'sid=oa-b',
    },
  }
  const runtimeByUser = new Map([
    [identities['employee-a'].user, { origin: employeeA.origin, cookie: 'dsh-auth-a=signed', invalidate() {} }],
    [identities['employee-b'].user, { origin: employeeB.origin, cookie: 'dsh-auth-b=signed', invalidate() {} }],
  ])
  const runtimeRequests = []
  const gateway = createGateway({
    authenticator: {
      async login(account) { return identities[account] },
      async currentUser(cookie) { return cookie === 'sid=oa-a' ? identities['employee-a'].user : identities['employee-b'].user },
      async logout() {},
    },
    runtimes: {
      async get(user, token) {
        runtimeRequests.push({ user, token })
        return runtimeByUser.get(user)
      },
      dispose() {},
    },
    secureCookies: false,
  })
  context.after(() => gateway.dispose())
  const publicServer = await listen(gateway.handleRequest)
  context.after(publicServer.close)

  async function login(account) {
    const response = await fetch(new URL('/auth/login', publicServer.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password: 'correct-password' }),
    })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie)
    return cookie
  }

  const cookieA = await login('employee-a')
  const cookieB = await login('employee-b')
  const [sessionA, probeA, probeB] = await Promise.all([
    fetch(new URL('/auth/session', publicServer.origin), { headers: { cookie: cookieA } }).then(response => response.json()),
    fetch(new URL('/probe', publicServer.origin), { headers: { cookie: cookieA } }).then(response => response.json()),
    fetch(new URL('/probe', publicServer.origin), { headers: { cookie: cookieB } }).then(response => response.json()),
  ])

  assert.deepEqual(sessionA.employee, identities['employee-a'].employee)
  assert.deepEqual(probeA, { label: 'employee-a-runtime', cookie: 'dsh-auth-a=signed' })
  assert.deepEqual(probeB, { label: 'employee-b-runtime', cookie: 'dsh-auth-b=signed' })
  assert.deepEqual(runtimeRequests.map(request => request.user), [
    'employee-a@example.com',
    'employee-b@example.com',
  ])
  assert.ok(runtimeRequests.every(request => typeof request.token === 'string' && request.token.length > 0))
})

test('local runtimes use their employee session token without receiving the server model credential', async (context) => {
  const observed = []
  const model = await listen(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    observed.push({
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
      url: request.url,
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"ok":true}\n\n')
  })
  context.after(model.close)
  const gateway = createGateway({
    authenticator: {
      async login() {
        return {
          user: 'employee-a@example.com',
          employee: { id: 'HR-EMP-0001', name: '员工甲', designation: '产品经理' },
          cookie: 'sid=oa-a',
          csrfToken: 'csrf-oa-a',
        }
      },
      async currentUser() { return 'employee-a@example.com' },
      async logout() {},
    },
    modelForwarder: createModelForwarder({
      baseUrl: model.origin.href,
      apiKey: 'server-only-model-key',
      allowHttp: true,
    }),
    runtimes: {
      async get() { throw new Error('model routes must not start a cloud DSH runtime') },
      dispose() {},
    },
    secureCookies: false,
  })
  context.after(() => gateway.dispose())
  const server = await listen(gateway.handleRequest)
  context.after(server.close)
  const login = await fetch(new URL('/auth/login', server.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'employee-a', password: 'correct-password' }),
  })
  const token = login.headers.get('set-cookie')?.split(';', 1)[0]?.split('=', 2)[1]
  assert.ok(token)
  const response = await fetch(new URL('/qifu-model/v1/chat/completions', server.origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
  })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'data: {"ok":true}\n\n')
  assert.deepEqual(observed, [{
    authorization: 'Bearer server-only-model-key',
    body: '{"model":"deepseek-chat","messages":[]}',
    url: '/chat/completions',
  }])
})
