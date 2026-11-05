/** Qifu-specific refusal of statically identifiable direct browser launches. */
import { parse } from 'shell-quote'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u
const BROWSER = /^(?:google-chrome|chrome|chromium(?:-browser)?|microsoft-edge|msedge)(?:-(?:stable|beta|dev|canary|for-testing))?$/iu
const GOOGLE_BUNDLE = /^com\.google\.chrome(?:\.(?:canary|beta|dev))?$/iu
const EDGE_BUNDLE = /^com\.microsoft\.edgemac(?:\.(?:beta|dev|canary))?$/iu
const REFUSAL = 'QIFU_BROWSER_DIRECT_LAUNCH: use browser_test for isolated browser testing; '
  + 'do not launch Chrome, Chromium, or Edge through shell commands or change HOME to bypass the system keychain.'

type ShellToken = ReturnType<typeof parse>[number]

function basename(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? ''
}

function operation(token: ShellToken | undefined): string | undefined {
  return typeof token === 'object' && 'op' in token ? token.op : undefined
}

function isBrowser(value: string): boolean {
  return BROWSER.test(basename(value).replace(/\.(?:app|exe)$/u, '').replaceAll(' ', '-'))
}

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let remaining: string | undefined = command.replace(/\\\r?\n/gu, '').replace(/\r?\n/gu, '\n;')
  while (remaining !== undefined) {
    const source: string = remaining
    remaining = undefined
    for (const token of parse(source, name => `\${${name}}`)) {
      if (typeof token === 'object' && 'comment' in token) {
        const newline = token.comment.indexOf('\n')
        if (newline >= 0) remaining = token.comment.slice(newline + 1)
      } else tokens.push(token)
    }
  }
  return tokens
}

function directLaunch(words: readonly string[]): boolean {
  let index = 0
  while (index < words.length) {
    while (ASSIGNMENT.test(words[index] ?? '')) index += 1
    const program = basename(words[index] ?? '')
    index += 1
    if (isBrowser(program)) return true
    if (program === 'open') {
      for (; index < words.length; index += 1) {
        const option = words[index]
        const application = words[index + 1]
        if (option === '-a' && application !== undefined && isBrowser(application)) return true
        if (option === '-b' && application !== undefined
          && (GOOGLE_BUNDLE.test(application) || EDGE_BUNDLE.test(application) || application === 'org.chromium.Chromium')) return true
      }
      return false
    }
    if (program !== 'env' && program !== 'exec' && program !== 'command' && program !== 'nohup') return false
    while (words[index]?.startsWith('-') === true) {
      const option = words[index]
      if (option === undefined) return false
      index += 1
      if (option === '--') break
      if (program === 'command' && (option === '-v' || option === '-V')) return false
      if ((program === 'env' && (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir'))
        || (program === 'exec' && option === '-a')) {
        index += 1
      } else if (!((program === 'env' && (option === '-i' || option === '--ignore-environment' || /^--(?:unset|chdir)=/u.test(option)))
        || (program === 'exec' && (option === '-c' || option === '-l')) || (program === 'command' && option === '-p'))) {
        return false
      }
    }
  }
  return false
}

function powerShellLaunch(command: string): boolean {
  // shortcut: PowerShell inspection recognizes only the first literal program and a literal HOME assignment.
  const source = command.replace(/^\s*\$env:HOME\s*=\s*(?:'[^']*'|"[^"$`]*"|[^\s;'"$`]+)\s*;\s*/iu, '')
  const called = /^\s*&\s*(?:'([^']+)'|"([^"$`]+)"|([^\s;&|'"`$]+))(?:\s|$)/u.exec(source)
  const bare = /^\s*([^\s;&|'"`$]+)(?:\s|$)/u.exec(source)
  return isBrowser(called?.[1] ?? called?.[2] ?? called?.[3] ?? bare?.[1] ?? '')
}

/**
 * Refuse identifiable browser launches in Qifu Bash and first-command PowerShell calls without changing their environment.
 * @param execution - immutable tool call facts; other tools remain outside this guard.
 * @returns a browser_test instruction when a direct launch is recognized.
 */
export function browserLaunchGuard(execution: Readonly<ToolExecution>): string | undefined {
  const name = execution.name.toLowerCase()
  if (name !== 'bash' && name !== 'pwsh') return undefined
  const args = execution.arguments
  if (typeof args !== 'object' || args === null || !('command' in args) || typeof args.command !== 'string') return undefined
  if (name === 'pwsh') return powerShellLaunch(args.command) ? REFUSAL : undefined
  // shortcut: aliases, scripts, dynamic evaluation, and here-documents are not resolved;
  // use process-level policy if indirect launches must be prohibited.
  let tokens: ShellToken[]
  try {
    tokens = shellTokens(args.command)
  } catch {
    return undefined
  }
  if (tokens.some((token, index) => operation(token) === '<<'
    || (operation(token) === '<' && operation(tokens[index + 1]) === '<'))) return undefined
  let words: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') words.push(token)
    else if (SEPARATORS.has(operation(token) ?? '')) {
      if (directLaunch(words)) return REFUSAL
      words = []
    }
  }
  return directLaunch(words) ? REFUSAL : undefined
}
