import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  createDshRuntimeProvider,
  employeeStorageKey,
  ensureEmployeeCloudWorkspace,
  ensureEmployeeWebProfile,
} from '../src/runtime.mjs'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode = null
  signalCode = null
  killedWith = []

  kill(signal) {
    this.killedWith.push(signal)
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }
}

test('employee storage keys are stable, distinct, and filesystem-safe', () => {
  const first = employeeStorageKey('employee-a@example.com')
  assert.equal(first, employeeStorageKey('employee-a@example.com'))
  assert.notEqual(first, employeeStorageKey('employee-b@example.com'))
  assert.match(first, /^[a-f0-9]{64}$/u)
})

test('employee Web profiles contain the managed context plugin exactly once', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qifu-runtime-profile-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  const profileDir = join(root, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), '# Generated empty overlay.\n[]\n')

  await ensureEmployeeWebProfile(root)
  await ensureEmployeeWebProfile(root)

  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-qifu-account-context'], '0.1.2-alpha.3')
  assert.ok(!patch.includes('[]'))
  assert.equal(patch.match(/id: qifu-account-context$/gmu)?.length, 1)
  assert.ok(!patch.includes('/invariant'))
})

test('employee cloud Workspace is registered idempotently and receives its product title', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push({ url: String(url), init, request })
    if (request.method === 'workspace/create') {
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            created: true,
            workspace: { workspaceId: 'cloud', title: 'cloud-workspace' },
          },
        },
      })
    }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: { workspace: { workspaceId: 'cloud', title: '云端工作区' } },
      },
    })
  }

  const workspace = await ensureEmployeeCloudWorkspace(
    new URL('http://127.0.0.1:41234/'),
    'dsh-auth-41234=signed',
    '/var/lib/qifuaigent/users/key/cloud-workspace',
    fetchImpl,
  )

  assert.deepEqual(workspace, { workspaceId: 'cloud', title: '云端工作区' })
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:41234/api/workspace/create',
    'http://127.0.0.1:41234/api/workspace/rename',
  ])
  assert.equal(calls[0].init.headers.cookie, 'dsh-auth-41234=signed')
  assert.deepEqual(calls[0].request.payload, {
    args: { request: { path: '/var/lib/qifuaigent/users/key/cloud-workspace' } },
  })
  assert.deepEqual(calls[1].request.payload, {
    args: { request: { workspaceId: 'cloud', title: '云端工作区' } },
  })
})

test('employee cloud Workspace keeps the managed title without a rename', async () => {
  let calls = 0
  const workspace = await ensureEmployeeCloudWorkspace(
    new URL('http://127.0.0.1:41235/'),
    'dsh-auth-41235=signed',
    '/var/lib/qifuaigent/users/key/cloud-workspace',
    async (_url, init) => {
      calls++
      const request = JSON.parse(init.body)
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            created: false,
            workspace: { workspaceId: 'cloud', title: '云端工作区' },
          },
        },
      })
    },
  )

  assert.equal(workspace.title, '云端工作区')
  assert.equal(calls, 1)
})

test('one employee reuses one runtime while different employees get separate homes', async () => {
  const spawns = []
  const directories = []
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    certificatePath: '/etc/qifuaigent-gateway/tls.crt',
    contextOrigin: 'https://gateway.example',
    mkdirImpl: async (path, options) => { directories.push({ path, options }) },
    prepareHomeImpl: async () => {},
    ensureWorkspaceImpl: async (origin, cookie, path) => {
      directories.push({ origin: origin.href, cookie, path })
    },
    spawnImpl: (command, args, options) => {
      const child = new FakeChild()
      spawns.push({ child, command, args, options })
      queueMicrotask(() => {
        child.stdout.write(`dsh web: http://127.0.0.1:${String(41000 + spawns.length)}/?token=private-token\n`)
      })
      return child
    },
    exchangeImpl: async origin => `dsh-auth-${origin.port}=signed`,
  })

  const [first, same] = await Promise.all([
    provider.get('employee-a@example.com', 'session-token-a'),
    provider.get('employee-a@example.com', 'session-token-a'),
  ])
  const second = await provider.get('employee-b@example.com', 'session-token-b')

  assert.equal(first, same)
  assert.notEqual(first.origin.port, second.origin.port)
  assert.equal(spawns.length, 2)
  assert.equal(directories.length, 6)
  assert.match(directories[1].path, /\/var\/lib\/qifuaigent\/users\/[a-f0-9]{64}\/cloud-workspace$/u)
  assert.equal(directories[2].cookie, 'dsh-auth-41001=signed')
  assert.equal(directories[2].origin, 'http://127.0.0.1:41001/')
  assert.match(spawns[0].options.env.DSH_HOME, /\/var\/lib\/qifuaigent\/users\/[a-f0-9]{64}\/\.dsh$/u)
  assert.notEqual(spawns[0].options.env.DSH_HOME, spawns[1].options.env.DSH_HOME)
  assert.equal(spawns[0].options.env.DEEPSEEK_API_KEY, 'session-token-a')
  assert.equal(spawns[0].options.env.DEEPSEEK_BASE_URL, 'https://gateway.example/qifu-model/v1')
  assert.equal(spawns[0].options.env.QIFUAI_CONTEXT_URL, 'https://gateway.example/qifu/v1/personalization/context')
  assert.equal(spawns[0].options.env.QIFUAI_CONTEXT_TOKEN, 'session-token-a')
  assert.equal(spawns[0].options.env.QIFUAI_CONTEXT_LOCAL, 'false')
  assert.equal(spawns[0].options.env.NODE_EXTRA_CA_CERTS, '/etc/qifuaigent-gateway/tls.crt')

  first.invalidate()
  assert.deepEqual(spawns[0].child.killedWith, ['SIGTERM'])
  await provider.get('employee-a@example.com', 'session-token-a')
  assert.equal(spawns.length, 3)
  provider.dispose()
})

test('a renewed employee gateway token replaces the old cloud runtime', async () => {
  const children = []
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    certificatePath: '/etc/qifuaigent-gateway/tls.crt',
    contextOrigin: 'https://gateway.example',
    mkdirImpl: async () => {},
    prepareHomeImpl: async () => {},
    ensureWorkspaceImpl: async () => {},
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.stdout.write(`dsh web: http://127.0.0.1:${String(41500 + children.length)}/?token=private-token\n`))
      return child
    },
    exchangeImpl: async origin => `dsh-auth-${origin.port}=signed`,
  })

  await provider.get('employee-a', 'session-token-old')
  await provider.get('employee-a', 'session-token-new')

  assert.equal(children.length, 2)
  assert.deepEqual(children[0].killedWith, ['SIGTERM'])
  provider.dispose()
})

test('a cloud Workspace initialization failure rejects and stops the employee runtime', async () => {
  const child = new FakeChild()
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    certificatePath: '/etc/qifuaigent-gateway/tls.crt',
    contextOrigin: 'https://gateway.example',
    mkdirImpl: async () => {},
    prepareHomeImpl: async () => {},
    ensureWorkspaceImpl: async () => { throw new Error('Workspace unavailable') },
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:41999/?token=private-token\n'))
      return child
    },
    exchangeImpl: async () => 'dsh-auth-41999=signed',
  })

  await assert.rejects(provider.get('employee-a', 'session-token-a'), /Workspace unavailable/u)
  assert.deepEqual(child.killedWith, ['SIGTERM'])
  provider.dispose()
})

test('dispose terminates every owned employee runtime', async () => {
  const children = []
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    certificatePath: '/etc/qifuaigent-gateway/tls.crt',
    contextOrigin: 'https://gateway.example',
    mkdirImpl: async () => {},
    prepareHomeImpl: async () => {},
    ensureWorkspaceImpl: async () => {},
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.stdout.write(`dsh web: http://127.0.0.1:${String(42000 + children.length)}/?token=private-token\n`))
      return child
    },
    exchangeImpl: async origin => `dsh-auth-${origin.port}=signed`,
  })
  await Promise.all([
    provider.get('employee-a', 'session-token-a'),
    provider.get('employee-b', 'session-token-b'),
  ])
  provider.dispose()
  assert.deepEqual(children.map(child => child.killedWith), [['SIGTERM'], ['SIGTERM']])
  await assert.rejects(provider.get('employee-c', 'session-token-c'), /disposed/u)
})
