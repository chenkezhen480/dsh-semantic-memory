/**
 * Tests for automatic provider selection and embedding hot-reload.
 *
 * @module dsh-plugin-semantic-memory/tests/config
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTO_SUMMARIZE_EVERY_ENV, resolveConfig, summarizeEveryFromEnv } from "../config.js";
import { EmbeddingService } from "../embedding.js";
import { MemoryStore, strengthOf } from "../store.js";
test('resolveConfig auto-selects api when apiKey is set', () => {
    const local = resolveConfig({});
    assert.equal(local.provider, 'local');
    const api = resolveConfig({ apiKey: 'sk-test' });
    assert.equal(api.provider, 'api');
    // Explicit provider still overrides the automatic selection.
    const forcedLocal = resolveConfig({ apiKey: 'sk-test', provider: 'local' });
    assert.equal(forcedLocal.provider, 'local');
    const forcedApi = resolveConfig({ provider: 'api', apiKey: 'sk-test' });
    assert.equal(forcedApi.provider, 'api');
});
test('summarizeEveryFromEnv parses the env override (0 disables)', () => {
    const key = AUTO_SUMMARIZE_EVERY_ENV;
    const previous = process.env[key];
    try {
        process.env[key] = '10';
        assert.equal(summarizeEveryFromEnv(), 10);
        process.env[key] = '0';
        assert.equal(summarizeEveryFromEnv(), 0);
        process.env[key] = 'abc';
        assert.equal(summarizeEveryFromEnv(), undefined);
        process.env[key] = '-3';
        assert.equal(summarizeEveryFromEnv(), undefined);
        delete process.env[key];
        assert.equal(summarizeEveryFromEnv(), undefined);
    }
    finally {
        if (previous === undefined)
            delete process.env[key];
        else
            process.env[key] = previous;
    }
});
test('env override wins over the config document', () => {
    const key = AUTO_SUMMARIZE_EVERY_ENV;
    const previous = process.env[key];
    try {
        process.env[key] = '10';
        assert.equal(resolveConfig({ autoSummarizeEvery: 5 }).autoSummarizeEvery, 10);
        process.env[key] = '0';
        assert.equal(resolveConfig({ autoSummarizeEvery: 5 }).autoSummarizeEvery, 0);
        delete process.env[key];
        assert.equal(resolveConfig({ autoSummarizeEvery: 5 }).autoSummarizeEvery, 5);
        assert.equal(resolveConfig({}).autoSummarizeEvery, 5);
    }
    finally {
        if (previous === undefined)
            delete process.env[key];
        else
            process.env[key] = previous;
    }
});
test('resolveConfig rejects api without a key when explicitly requested', () => {
    assert.throws(() => resolveConfig({ provider: 'api' }), /api provider requires apiKey/);
});
test('EmbeddingService.setConfig rebuilds the provider on identity change', async () => {
    const base = resolveConfig({});
    const service = new EmbeddingService(base);
    // No identity change: same resolved values keep the (not yet started) provider.
    service.setConfig(resolveConfig({}));
    assert.equal(service.provider, undefined);
    // apiKey appears: identity changed, provider is dropped for lazy rebuild.
    service.setConfig(resolveConfig({ apiKey: 'sk-test', apiBase: 'http://x' }));
    assert.equal(service.provider, undefined);
    assert.equal(service.cache.size, 0);
    // Same api config again: nothing to rebuild.
    const before = service.starting;
    service.setConfig(resolveConfig({ apiKey: 'sk-test', apiBase: 'http://x' }));
    assert.equal(service.starting, before);
    await service.dispose();
});
test('store half-life is mutable for settings hot-reloads', async () => {
    const store = new MemoryStore('unused-path', 1000);
    const now = Date.now();
    const entry = {
        id: 'x', kind: 'fact', content: 'x', tags: [], importance: 5,
        embedding: [], createdAt: now, updatedAt: now, accessCount: 0, lastAccessAt: now,
    };
    // base = importance/5 = 1; one half-life halves it.
    assert.equal(strengthOf(entry, now + 1000, store.halfLifeMs), 0.5);
    // A shorter half-life decays faster at the same age.
    store.halfLifeMs = 100;
    assert.equal(strengthOf(entry, now + 100, store.halfLifeMs), 0.5);
    assert.equal(strengthOf(entry, now + 200, store.halfLifeMs), 0.25);
});
