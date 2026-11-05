import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { browserLaunchGuard } from '../src/browser-guard.ts'

function execution(command: string, name = 'bash'): ToolExecution {
  return { name, arguments: { command } } as ToolExecution
}

describe('Qifu direct browser launch guard', () => {
  it.each([
    'chrome --headless https://example.test/',
    'chromium --headless https://example.test/',
    'google-chrome-stable https://example.test/',
    'msedge https://example.test/',
    '"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" https://example.test/',
    'HOME=/tmp/zkhome TMPDIR=/tmp "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless',
    'mkdir -p /tmp/fixture && HOME=/tmp/zkhome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    'env -u HOME TMPDIR=/tmp /usr/bin/chromium --headless',
    'exec -a browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    'command -p chromium --headless',
    'echo ready; chromium --headless',
    'echo ready\nchromium --headless',
    '# browser test\nchromium --headless',
    'open -a "Google Chrome" https://example.test/',
    'open -b com.google.Chrome https://example.test/',
  ])('rejects the explicit launch %s', (command) => {
    expect(browserLaunchGuard(execution(command))).toMatch(/^QIFU_BROWSER_DIRECT_LAUNCH.*browser_test/u)
  })

  it.each([
    'echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    'echo "first\nchromium --headless"',
    'printf "%s" "chrome; chromium"',
    'rg "chrome|chromium" src',
    'cat /Applications/Google\\ Chrome.app/Contents/Info.plist',
    'command -v chrome',
    'which chromium',
    'HOME=/tmp/fixture npm test',
    'open https://example.test/',
    'open -a TextEdit report.txt',
    'cat <<\'EOF\'\nchromium --headless\nEOF',
    'cat <<EOF\nchrome\nEOF\necho complete',
  ])('keeps a text reference or ordinary command unchanged: %s', (command) => {
    expect(browserLaunchGuard(execution(command))).toBeUndefined()
  })

  it.each([
    'chrome.exe --headless https://example.test/',
    '& chrome.exe --headless',
    "& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --headless",
    '& "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --headless',
    "$env:HOME='C:\\Temp\\qifu'; & 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --headless",
  ])('rejects an explicit first PowerShell browser launch: %s', (command) => {
    expect(browserLaunchGuard(execution(command, 'pwsh'))).toMatch(/^QIFU_BROWSER_DIRECT_LAUNCH.*browser_test/u)
  })

  it.each([
    "Write-Output 'chrome.exe'",
    "Get-Content 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'",
    "'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'",
    '"chrome.exe"',
    '& "$env:CHROME_PATH" --headless',
    "$env:HOME='C:\\Temp\\qifu'; Write-Output 'chrome.exe'",
    'Start-Process -FilePath $browserPath',
  ])('does not parse PowerShell data or indirect commands as explicit launches: %s', (command) => {
    expect(browserLaunchGuard(execution(command, 'pwsh'))).toBeUndefined()
  })

  it('does not change other tools or pretend to inspect encoded and indirect programs', () => {
    expect(browserLaunchGuard(execution('chrome', 'browser_test'))).toBeUndefined()
    expect(browserLaunchGuard(execution('chrome', 'read'))).toBeUndefined()
    expect(browserLaunchGuard(execution('node launch-browser.js'))).toBeUndefined()
    expect(browserLaunchGuard(execution('eval "$GENERATED_COMMAND"'))).toBeUndefined()
    expect(browserLaunchGuard({ name: 'bash', arguments: null } as ToolExecution)).toBeUndefined()
    expect(browserLaunchGuard({ name: 'bash', arguments: { command: 2 } } as ToolExecution)).toBeUndefined()
  })

  it('denies execution after an allowing waterfall and withdraws with its registration', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)
      const run = vi.fn(async () => 'fixture command executed')
      ctx.tools.register({
        name: 'bash', description: 'Fixture shell command',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: run,
      })
      const dispose = ctx.tools.guard(browserLaunchGuard)
      ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
      const call = () => ctx.tools.execute({
        name: 'bash', arguments: { command: 'chromium --headless' },
        callId: ToolCallId('browser-guard-fixture'), signal: new AbortController().signal,
      })
      const denied = await call()
      expect(JSON.stringify(denied)).toContain('QIFU_BROWSER_DIRECT_LAUNCH')
      expect(run).not.toHaveBeenCalled()
      dispose()
      await call()
      expect(run).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
