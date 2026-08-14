/**
 * Cordis integration test: mounts the real plugin against the real tools and
 * systemPrompt services, with a stubbed OpenAI-compatible embeddings endpoint
 * (deterministic vectors, no network).
 *
 * @module dsh-plugin-semantic-memory/tests/plugin
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { SemanticMemory } from "../plugin-under-test.js";
const DIM = 8;
const activeContexts = [];
afterEach(async () => {
    for (const ctx of activeContexts.splice(0))
        await ctx.fiber.dispose();
});
/** Deterministic normalized vector from a text. */
function vectorOf(text) {
    const values = [];
    let seed = 0;
    for (const char of text)
        seed = (seed * 31 + char.codePointAt(0)) >>> 0;
    for (let axis = 0; axis < DIM; axis += 1) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        values.push((seed % 1000) / 1000);
    }
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return values.map(v => v / norm);
}
function stubFetch() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: body.input.map(text => ({ embedding: vectorOf(text) })),
            }),
        };
    });
    return original;
}
async function mount() {
    const ctx = new Context();
    activeContexts.push(ctx);
    ctx.plugin(SystemPrompt, {});
    ctx.plugin(ToolRuntime, {});
    const dir = await mkdtemp(join(tmpdir(), 'smem-plugin-'));
    const memoryPath = join(dir, 'memories.jsonl');
    ctx.plugin(SemanticMemory, {
        provider: 'api',
        apiKey: 'test-key',
        apiModel: 'test-model',
        memoryPath,
        promptTopK: 3,
        maxSearchResults: 10,
        minScore: 0,
        halfLifeMs: 86400000,
    });
    assert.ok(ctx.tools !== undefined, 'tools service missing');
    assert.ok(ctx.systemPrompt !== undefined, 'systemPrompt service missing');
    return {
        ctx,
        memoryPath,
        tool: name => toolByName(ctx, name),
    };
}
function toolByName(ctx, name) {
    const definition = ctx.tools.get(name);
    assert.ok(definition !== undefined, `tool ${name} not registered`);
    return definition;
}
function runExec() {
    return { signal: new AbortController().signal };
}
test('plugin registers four tools and the memory prompt section', async () => {
    stubFetch();
    const mounted = await mount();
    for (const name of ['memory_write', 'memory_search', 'memory_forget', 'memory_stats']) {
        assert.ok(mounted.tool(name) !== undefined, `${name} missing`);
    }
    const assembly = await mounted.ctx.systemPrompt.assemble();
    const section = assembly.sections.find(s => s.name === 'memory:semantic');
    assert.ok(section !== undefined, 'memory:semantic section missing');
    assert.equal(section.text, ''); // empty store contributes nothing
    await mounted.ctx.fiber.dispose();
});
test('memory_write upserts by content identity and memory_search recalls it', async () => {
    stubFetch();
    const mounted = await mount();
    const write = mounted.tool('memory_write');
    const first = await write.execute({
        kind: 'fact',
        content: 'user prefers concise Chinese answers',
        tags: ['style'],
        importance: 5,
    }, runExec());
    assert.match(String(first), /memory written: [0-9a-f]{16}/);
    const second = await write.execute({
        kind: 'fact',
        content: 'user prefers concise Chinese answers',
        importance: 4,
    }, runExec());
    assert.match(String(second), /memory updated: [0-9a-f]{16}/);
    assert.equal(String(first).match(/[0-9a-f]{16}/)?.[0], String(second).match(/[0-9a-f]{16}/)?.[0]);
    const search = mounted.tool('memory_search');
    const hits = await search.execute({ query: 'concise Chinese answers' }, runExec());
    assert.match(String(hits), /Found 1 memories/);
    assert.match(String(hits), /user prefers concise Chinese answers/);
    const stats = mounted.tool('memory_stats');
    const summary = await stats.execute({}, runExec());
    assert.match(String(summary), /Total memories: 1/);
    const forget = mounted.tool('memory_forget');
    const id = String(first).match(/[0-9a-f]{16}/)?.[0];
    const forgotten = await forget.execute({ id }, runExec());
    assert.match(String(forgotten), /Memory deleted/);
    const after = await stats.execute({}, runExec());
    assert.match(String(after), /Total memories: 0/);
    await mounted.ctx.fiber.dispose();
});
test('system prompt section injects memories after writes', async () => {
    stubFetch();
    const mounted = await mount();
    await mounted.tool('memory_write').execute({
        kind: 'preference',
        content: 'always summarize with bullet points',
        importance: 5,
    }, runExec());
    const assembly = await mounted.ctx.systemPrompt.assemble();
    const section = assembly.sections.find(s => s.name === 'memory:semantic');
    assert.ok(section !== undefined);
    assert.match(section.text, /## Long-term memory/);
    assert.match(section.text, /always summarize with bullet points/);
    await mounted.ctx.fiber.dispose();
});
test('memory_write rejects empty content', async () => {
    stubFetch();
    const mounted = await mount();
    await assert.rejects(mounted.tool('memory_write').execute({ kind: 'note', content: '   ' }, runExec()), /content must be non-empty/);
    await mounted.ctx.fiber.dispose();
});
