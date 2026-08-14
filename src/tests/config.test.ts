/**
 * Tests for automatic provider selection and embedding hot-reload.
 *
 * @module dsh-plugin-semantic-memory/tests/config
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../config.ts'
import { EmbeddingService } from '../embedding.ts'
import { MemoryStore, strengthOf } from '../store.ts'

test('resolveConfig auto-selects api when apiKey is set', () => {
  const local = resolveConfig({})
  assert.equal(local.provider, 'local')

  const api = resolveConfig({ apiKey: 'sk-test' })
  assert.equal(api.provider, 'api')

  // Explicit provider still overrides the automatic selection.
  const forcedLocal = resolveConfig({ apiKey: 'sk-test', provider: 'local' })
  assert.equal(forcedLocal.provider, 'local')
  const forcedApi = resolveConfig({ provider: 'api', apiKey: 'sk-test' })
  assert.equal(forcedApi.provider, 'api')
})

test('resolveConfig rejects api without a key when explicitly requested', () => {
  assert.throws(() => resolveConfig({ provider: 'api' }), /api provider requires apiKey/)
})

test('EmbeddingService.setConfig rebuilds the provider on identity change', async () => {
  const base = resolveConfig({})
  const service = new EmbeddingService(base)

  // No identity change: same resolved values keep the (not yet started) provider.
  service.setConfig(resolveConfig({}))
  assert.equal((service as unknown as { provider: unknown }).provider, undefined)

  // apiKey appears: identity changed, provider is dropped for lazy rebuild.
  service.setConfig(resolveConfig({ apiKey: 'sk-test', apiBase: 'http://x' }))
  assert.equal((service as unknown as { provider: unknown }).provider, undefined)
  assert.equal((service as unknown as { cache: Map<string, unknown> }).cache.size, 0)

  // Same api config again: nothing to rebuild.
  const before = (service as unknown as { starting: unknown }).starting
  service.setConfig(resolveConfig({ apiKey: 'sk-test', apiBase: 'http://x' }))
  assert.equal((service as unknown as { starting: unknown }).starting, before)

  await service.dispose()
})

test('store half-life is mutable for settings hot-reloads', async () => {
  const store = new MemoryStore('unused-path', 1000)
  const now = Date.now()
  const entry = {
    id: 'x', kind: 'fact' as const, content: 'x', tags: [], importance: 5,
    embedding: [], createdAt: now, updatedAt: now, accessCount: 0, lastAccessAt: now,
  }
  // base = importance/5 = 1; one half-life halves it.
  assert.equal(strengthOf(entry, now + 1000, store.halfLifeMs), 0.5)
  // A shorter half-life decays faster at the same age.
  store.halfLifeMs = 100
  assert.equal(strengthOf(entry, now + 100, store.halfLifeMs), 0.5)
  assert.equal(strengthOf(entry, now + 200, store.halfLifeMs), 0.25)
})
