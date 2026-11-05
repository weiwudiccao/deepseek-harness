const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PassThrough } = require('node:stream');
const { runInNewContext } = require('node:vm');
const test = require('node:test');

test('parent cleanup failures reject after Electron closes and never report temporary files removed', async () => {
  const { runBrowserAcceptance } = await import('../scripts/check-browser-runtime.mjs');
  const sequence = [];
  const child = new EventEmitter(); Object.assign(child, { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  const operation = runBrowserAcceptance({ argumentsList: [], electronPath: '/test-only/electron', makeTemporary: async () => '/test-only/private-root',
    spawnProcess() { sequence.push('spawn'); setImmediate(() => { child.stdout.write('{"domMarker":true,"directLaunchRefused":true}\n'); sequence.push('closed'); child.emit('close', 0, null); }); return child; },
    removeTemporary: async () => { sequence.push('remove'); throw Object.assign(new Error('test-only EBUSY'), { code: 'EBUSY' }); },
  });
  await assert.rejects(operation, /EBUSY/u);
  assert.deepEqual(sequence, ['spawn', 'closed', 'remove']);
});

test('Electron cleanup failure always exits nonzero and leaves root deletion to its parent', async () => {
  const filename = resolve(__dirname, '../scripts/check-electron-browser-runtime.cjs');
  const source = readFileSync(filename, 'utf8');
  const start = source.indexOf('async function finish(error)'); const end = source.indexOf("process.once('SIGINT'", start);
  const exits = []; const errors = [];
  const context = { deadline: 1, clearTimeout() {}, setTimeout() { return 2; },
    stopChild: async () => { throw new Error('test-only teardown failure'); }, bridge: undefined,
    sockets: new Set(), slowPage: undefined, windows: new Set(), destroyedWindows: new Set(), privateSessions: new Set(),
    scratch: '/test-only/owned-root', rm: async () => { throw new Error('parent must remove userData'); },
    phase() {}, assert,
    process: { stderr: { write: value => errors.push(value) }, stdout: { write() {} } }, app: { exit: code => exits.push(code) },
  };
  runInNewContext(`let exiting, failed=false, report; ${source.slice(start, end)} globalThis.operation = finish();`, context, { filename });
  await context.operation;
  assert.deepEqual(exits, [1]); assert.match(errors.join(''), /test-only teardown failure/u);
});
