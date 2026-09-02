import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createDshRuntimeProvider, employeeStorageKey, ensureEmployeeWebProfile } from '../src/runtime.mjs'

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

  await ensureEmployeeWebProfile(root)
  await ensureEmployeeWebProfile(root)

  const profileDir = join(root, 'profiles', 'web')
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-qifu-account-context'], '0.1.2-alpha.3')
  assert.equal(patch.match(/id: qifu-account-context$/gmu)?.length, 1)
  assert.match(patch, /@deepseek-ai\/dsh-qifu-account-context\/invariant/u)
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
  assert.equal(directories.length, 2)
  assert.match(spawns[0].options.env.DSH_HOME, /\/var\/lib\/qifuaigent\/users\/[a-f0-9]{64}\/\.dsh$/u)
  assert.notEqual(spawns[0].options.env.DSH_HOME, spawns[1].options.env.DSH_HOME)
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
