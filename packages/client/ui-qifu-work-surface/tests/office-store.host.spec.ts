import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { OfficeStore } from '../src/office-store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(maxBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'qifu-office-store-'))
  roots.push(root)
  const store = new OfficeStore(root, { maxDocumentBytes: maxBytes, maxDocumentsPerSession: 100 })
  return { store, root }
}

describe('employee runtime Office document store', () => {
  it('keeps same-name files independent and reloads only the owning session documents', async () => {
    const { store, root } = await fixture()
    const first = await store.save('session-a', '方案.html', new TextEncoder().encode('<p>第一版</p>'), 'original')
    const second = await store.save('session-a', '方案.html', new TextEncoder().encode('<p>第二版</p>'), 'generated')
    expect(first.id).not.toBe(second.id)
    expect(first).toMatchObject({ name: '方案.html', format: 'html', kind: 'original', bytes: 16 })
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect([...(await store.read('session-a', first.id)).data]).toEqual([...new TextEncoder().encode('<p>第一版</p>')])
    expect(await store.list('session-b')).toEqual([])
    await expect(store.read('session-b', first.id)).rejects.toThrow(/not found/u)
    const reopened = new OfficeStore(root, { maxDocumentBytes: 1024, maxDocumentsPerSession: 100 })
    expect((await reopened.list('session-a')).map(document => document.id).sort()).toEqual([first.id, second.id].sort())
  })

  it('refuses invalid names, oversized files, malformed ids, and digest mismatches', async () => {
    const { store, root } = await fixture(25)
    for (const name of ['../stolen.html', 'a/b.html', 'a\\b.html', '\u0000.html', 'run.exe', '']) {
      await expect(store.save('s', name, new Uint8Array([1]), 'original')).rejects.toThrow()
    }
    await expect(store.save('s', 'large.txt', new Uint8Array(26), 'original')).rejects.toThrow(/size/u)
    await expect(store.read('s', '../outside')).rejects.toThrow(/id/u)
    const saved = await store.save('s', 'report.txt', new TextEncoder().encode('hello'), 'original')
    const { createHash } = await import('node:crypto')
    const storage = join(root, 'qifu-office', 'v1', createHash('sha256').update('s').digest('hex'), saved.id, 'content')
    await writeFile(storage, 'other')
    await expect(store.read('s', saved.id)).rejects.toThrow(/integrity/u)
  })

  it('refuses cancellation before publication and serializes the per-Session quota', async () => {
    const { root } = await fixture()
    const store = new OfficeStore(root, { maxDocumentBytes: 1024, maxDocumentsPerSession: 1 })
    await expect(store.save('cancelled', 'cancelled.txt', new Uint8Array([1]), 'original', AbortSignal.abort())).rejects.toThrow()
    expect(await store.list('cancelled')).toEqual([])
    const settled = await Promise.allSettled([
      store.save('parallel', 'first.txt', new Uint8Array([1]), 'original'),
      store.save('parallel', 'second.txt', new Uint8Array([2]), 'original'),
    ])
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await store.list('parallel')).toHaveLength(1)
  })

  it('refuses symlinked session storage and enforces a complete document quota', async () => {
    const { root } = await fixture()
    const store = new OfficeStore(root, { maxDocumentBytes: 1024, maxDocumentsPerSession: 1 })
    await store.save('s', 'one.txt', new Uint8Array([1]), 'original')
    await expect(store.save('s', 'two.txt', new Uint8Array([2]), 'original')).rejects.toThrow(/limit/u)
    const external = join(root, 'external')
    await mkdir(external)
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('other').digest('hex')
    await symlink(external, join(root, 'qifu-office', 'v1', hash), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.save('other', 'leak.txt', new Uint8Array([1]), 'original')).rejects.toThrow(/symbolic/u)
  })
})
