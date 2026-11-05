/** Own Electron's test directory until the native process and its open file handles are gone. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'check-electron-browser-runtime.cjs');
const phase = message => process.stderr.write(`[browser-acceptance] ${message}\n`);

/**
 * Run the real Electron fixture, then remove its private userData after native process closure.
 * @param options Test argv and process/filesystem adapters used by focused teardown regressions.
 * @returns The verified fixture report with parent-owned temporary-file cleanup.
 */
export async function runBrowserAcceptance({ argumentsList, electronPath = require('electron'), spawnProcess = spawn, makeTemporary = mkdtemp, removeTemporary = rm, timeoutMs = 180_000 }) {
  const root = await makeTemporary(join(tmpdir(), 'qifu-electron-browser-accept-'));
  let child; let closed = false; let output = ''; let stderr = ''; let timedOut = false; let failure;
  let timer; let forced;
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|DEEPSEEK|NODE_OPTIONS|ELECTRON_RUN_AS_NODE/iu.test(name)));
    phase('start-electron');
    child = spawnProcess(electronPath, [fixture, ...argumentsList], { env: { ...environment, QIFU_BROWSER_ACCEPTANCE_ROOT: root }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-65_536); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-65_536); process.stderr.write(chunk); });
    const completion = new Promise(resolve => {
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal, spawnError }); });
    });
    const forcedFailure = new Promise((_resolve, reject) => { forced = reject; });
    timer = setTimeout(() => {
      timedOut = true; phase('deadline: terminating owned Electron process tree');
      void (async () => {
        if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000, windowsHide: true });
        else if (!closed) process.kill(-child.pid, 'SIGKILL');
        const endTimer = setTimeout(() => forced(new Error('Owned Electron process did not close after termination')), 10_000);
        try { await completion; } finally { clearTimeout(endTimer); }
      })().catch(forced);
    }, timeoutMs);
    const result = await Promise.race([completion, forcedFailure]);
    phase('electron-closed');
    if (result.spawnError) throw result.spawnError;
    assert.equal(timedOut, false, 'Electron browser acceptance exceeded its total deadline');
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(report.domMarker, true); assert.equal(report.directLaunchRefused, true);
    return { ...report, temporaryFilesRemoved: true };
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); failure = error; throw error; }
  finally {
    clearTimeout(timer);
    if (child && !closed) {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      phase('cleanup failed: owned Electron process is not confirmed closed');
      if (!failure) throw new Error('Electron closure was not confirmed');
    } else {
      phase('remove-private-root');
      try { await removeTemporary(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 100 }); }
      catch (error) { process.stderr.write(`${error.stack ?? error}\n`); if (failure) throw new AggregateError([failure, error], 'Electron acceptance and temporary-file cleanup failed'); throw error; }
      phase('private-root-removed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.QIFUAI_BROWSER_TEST_URL) {
    process.argv.push('--browser');
    await import('./check-office-runtime.mjs');
  } else {
    try { process.stdout.write(`${JSON.stringify(await runBrowserAcceptance({ argumentsList: process.argv.slice(2) }))}\n`); }
    catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
  }
}
