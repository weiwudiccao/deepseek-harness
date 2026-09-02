import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createDshRuntimeProvider, employeeStorageKey } from '../src/runtime.mjs'

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

test('one employee reuses one runtime while different employees get separate homes', async () => {
  const spawns = []
  const directories = []
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    mkdirImpl: async (path, options) => { directories.push({ path, options }) },
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
    provider.get('employee-a@example.com'),
    provider.get('employee-a@example.com'),
  ])
  const second = await provider.get('employee-b@example.com')

  assert.equal(first, same)
  assert.notEqual(first.origin.port, second.origin.port)
  assert.equal(spawns.length, 2)
  assert.equal(directories.length, 2)
  assert.match(spawns[0].options.env.DSH_HOME, /\/var\/lib\/qifuaigent\/users\/[a-f0-9]{64}\/\.dsh$/u)
  assert.notEqual(spawns[0].options.env.DSH_HOME, spawns[1].options.env.DSH_HOME)

  first.invalidate()
  assert.deepEqual(spawns[0].child.killedWith, ['SIGTERM'])
  await provider.get('employee-a@example.com')
  assert.equal(spawns.length, 3)
  provider.dispose()
})

test('dispose terminates every owned employee runtime', async () => {
  const children = []
  const provider = createDshRuntimeProvider({
    cliPath: '/srv/qifuaigent/apps/cli/lib/bin.js',
    cwd: '/srv/qifuaigent',
    dataRoot: '/var/lib/qifuaigent/users',
    mkdirImpl: async () => {},
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.stdout.write(`dsh web: http://127.0.0.1:${String(42000 + children.length)}/?token=private-token\n`))
      return child
    },
    exchangeImpl: async origin => `dsh-auth-${origin.port}=signed`,
  })
  await Promise.all([provider.get('employee-a'), provider.get('employee-b')])
  provider.dispose()
  assert.deepEqual(children.map(child => child.killedWith), [['SIGTERM'], ['SIGTERM']])
  await assert.rejects(provider.get('employee-c'), /disposed/u)
})
