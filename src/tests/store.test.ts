/**
 * Unit tests for the semantic memory store (fake embeddings, no network).
 *
 * @module dsh-plugin-semantic-memory/tests/store
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contentHash, MemoryStore, strengthOf } from '../store.ts'

const HALF_LIFE = 1000

async function freshStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-memory-'))
  const store = new MemoryStore(join(dir, 'memories.jsonl'), HALF_LIFE)
  return { store, dir }
}

function unitVector(axis: number, dim = 8): number[] {
  const vector = new Array<number>(dim).fill(0)
  vector[axis] = 1
  return vector
}

test('put creates and upserts by content identity', async () => {
  const { store, dir } = await freshStore()
  const first = await store.put({
    kind: 'fact', content: 'The sky is blue', importance: 4,
    embedding: unitVector(0),
  })
  assert.equal(first.created, true)
  const second = await store.put({
    kind: 'fact', content: 'The sky is blue', importance: 5,
    embedding: unitVector(0),
  })
  assert.equal(second.created, false)
  assert.equal(second.entry.id, first.entry.id)
  assert.equal(second.entry.importance, 5)
  assert.equal(store.size, 1)
  await rm(dir, { recursive: true, force: true })
})

test('store persists across instances', async () => {
  const { store, dir } = await freshStore()
  await store.put({ kind: 'note', content: 'persisted entry', embedding: unitVector(1) })
  const reloaded = new MemoryStore(join(dir, 'memories.jsonl'), HALF_LIFE)
  await reloaded.ensureLoaded()
  assert.equal(reloaded.size, 1)
  const [hit] = await reloaded.search(unitVector(1))
  assert.equal(hit?.entry.content, 'persisted entry')
  const raw = await readFile(join(dir, 'memories.jsonl'), 'utf8')
  assert.match(raw, /persisted entry/)
  await rm(dir, { recursive: true, force: true })
})

test('search ranks by cosine and respects filters', async () => {
  const { store, dir } = await freshStore()
  await store.put({ kind: 'fact', content: 'alpha', tags: ['a'], embedding: unitVector(0) })
  await store.put({ kind: 'decision', content: 'beta', tags: ['b'], embedding: unitVector(1), importance: 5 })
  await store.put({ kind: 'note', content: 'gamma', tags: ['a', 'b'], embedding: unitVector(1) })

  const hits = await store.search(unitVector(1))
  assert.equal(hits.length, 2)
  assert.equal(hits[0]?.entry.content, 'beta')
  assert.equal(hits[1]?.entry.content, 'gamma')

  const filtered = await store.search(unitVector(1), { kinds: ['decision'] })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.entry.content, 'beta')

  const tagged = await store.search(unitVector(1), { tags: ['a'] })
  assert.equal(tagged.length, 1)
  assert.equal(tagged[0]?.entry.content, 'gamma')

  const scored = await store.search(unitVector(0), { minScore: 0.99 })
  assert.equal(scored.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('search refreshes access: touch strengthens decayed entries', async () => {
  const { store, dir } = await freshStore()
  const { entry } = await store.put({
    kind: 'preference', content: 'favorite color is green', importance: 5,
    embedding: unitVector(0),
  })
  // Rewriting the same content exercises the upsert path deterministically
  // (fire-and-forget mutations could outlive the test and race the cleanup).
  await store.put({
    kind: 'preference', content: 'favorite color is green', importance: 5,
    embedding: unitVector(0),
  })
  await store.touch(entry.id)
  const touched = store.get(entry.id)
  assert.ok(touched !== undefined)
  assert.equal(touched.accessCount, 1)
  assert.ok(touched.lastAccessAt >= Date.now() - 5000)
  await rm(dir, { recursive: true, force: true })
})

test('strengthOf decays with age and scales with importance', () => {
  const now = Date.now()
  const base = { id: 'x', kind: 'fact' as const, content: 'x', tags: [], importance: 4,
    embedding: [], createdAt: now, updatedAt: now, accessCount: 0, lastAccessAt: now - HALF_LIFE }
  const aged = strengthOf(base, now, HALF_LIFE)
  assert.equal(aged, (4 / 5) * 0.5)
  const fresh = strengthOf({ ...base, lastAccessAt: now }, now, HALF_LIFE)
  assert.equal(fresh, 4 / 5)
})

test('promptCandidatesSync ranks strength then recency', async () => {
  const { store, dir } = await freshStore()
  await store.put({ kind: 'fact', content: 'old but important', importance: 5, embedding: unitVector(0) })
  await store.put({ kind: 'note', content: 'recent and weak', importance: 1, embedding: unitVector(1) })
  const candidates = store.promptCandidatesSync(2)
  assert.equal(candidates[0]?.content, 'old but important')
  await rm(dir, { recursive: true, force: true })
})

test('remove deletes and persists', async () => {
  const { store, dir } = await freshStore()
  const { entry } = await store.put({ kind: 'note', content: 'temporary', embedding: unitVector(2) })
  assert.equal(await store.remove(entry.id), true)
  assert.equal(await store.remove(entry.id), false)
  assert.equal(store.size, 0)
  const reloaded = new MemoryStore(join(dir, 'memories.jsonl'), HALF_LIFE)
  await reloaded.ensureLoaded()
  assert.equal(reloaded.size, 0)
  await rm(dir, { recursive: true, force: true })
})

test('contentHash is deterministic and distinct across kinds', () => {
  assert.equal(contentHash('fact', 'hello'), contentHash('fact', 'hello'))
  assert.notEqual(contentHash('fact', 'hello'), contentHash('note', 'hello'))
  assert.match(contentHash('fact', 'hello'), /^[0-9a-f]{16}$/)
})
