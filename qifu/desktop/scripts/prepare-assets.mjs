import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const target = process.argv[2]
const productRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(productRoot, '..', '..')
const buildRoot = resolve(productRoot, 'build')
const runtimeRoot = resolve(productRoot, 'resources', 'dsh-runtime')

const runtimeFiles = target === 'macos-arm64'
  ? [
      'deepseek-harness-sdk-runtime-macos-arm64',
      'deepseek-harness-sdk-runtime-macos-arm64-rg',
      'deepseek-harness-sdk-runtime-macos-arm64-spawn-helper',
    ]
  : target === 'win-x64'
    ? [
        'deepseek-harness-sdk-runtime-win-x64.exe',
        'deepseek-harness-sdk-runtime-win-x64-rg.exe',
      ]
    : undefined

if (runtimeFiles === undefined) throw new Error('target must be macos-arm64 or win-x64')

await Promise.all([mkdir(buildRoot, { recursive: true }), mkdir(runtimeRoot, { recursive: true })])
await copyFile(
  resolve(repositoryRoot, 'apps', 'web', 'public', 'brand', 'qifuai-logo.png'),
  resolve(buildRoot, 'icon.png'),
)
for (const name of runtimeFiles) {
  const destination = resolve(runtimeRoot, basename(name))
  await copyFile(resolve(repositoryRoot, 'dist-exe', name), destination)
  if (target === 'macos-arm64') await chmod(destination, 0o755)
}

process.stdout.write(`Prepared Qifu desktop assets for ${target}.\n`)
