/**
 * Tests for automatic conversation summarization: message counting, LLM
 * distillation, JSON parsing, and store writes — with a fake stream and the
 * API embedding path (no network).
 *
 * @module dsh-plugin-semantic-memory/tests/summarize
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AutoSummarizer, collectText, extractTranscript, parseSummary } from "../summarize.js";
import { EmbeddingService } from "../embedding.js";
import { MemoryStore } from "../store.js";
const DIM = 8;
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
}
function fakeLlm(answer) {
    return {
        async *stream() {
            yield { type: 'text-delta', index: 0, text: answer };
            yield { type: 'block-end', index: 0 };
            yield { type: 'finish' };
        },
    };
}
function messageEvent(type, text) {
    return { type, data: { content: [{ type: 'text', text }], source: { kind: type === 'user/message' ? 'user' : 'model' } } };
}
function captureListener(attach) {
    let listener;
    attach({ on: (_name, cb) => { listener = cb; } });
    return {
        emit(session, event) {
            listener?.(session, event);
        },
    };
}
async function freshStore() {
    const dir = await mkdtemp(join(tmpdir(), 'smem-summary-'));
    const store = new MemoryStore(join(dir, 'memories.jsonl'), 86400000);
    return { store, dir };
}
test('parseSummary extracts a valid JSON array and rejects bad input', () => {
    const items = parseSummary('Here you go:\n```json\n[{"kind":"fact","content":"sky is blue"},{"kind":"preference","content":"likes tea"}]```');
    assert.equal(items.length, 2);
    assert.equal(items[0]?.kind, 'fact');
    assert.equal(items[1]?.content, 'likes tea');
    assert.equal(parseSummary('no json here').length, 0);
    assert.equal(parseSummary('[{"kind":"bogus","content":"x"}]').length, 0);
    assert.equal(parseSummary('[{"content":"missing kind"}]').length, 0);
    assert.equal(parseSummary('[]').length, 0);
});
test('collectText concatenates text-delta chunks', async () => {
    const text = await collectText(fakeLlm('part1').stream());
    assert.equal(text, 'part1');
    const multi = await collectText((async function* () {
        yield { type: 'text-delta', index: 0, text: 'a' };
        yield { type: 'text-delta', index: 0, text: 'b' };
        yield { type: 'reasoning-delta', index: 0, text: 'ignored' };
        yield { type: 'text-delta', index: 0, text: 'c' };
    })());
    assert.equal(multi, 'abc');
});
test('extractTranscript keeps recent user/assistant text only', () => {
    const events = [
        messageEvent('user/message', 'first'),
        { type: 'turn/start', data: {} },
        messageEvent('assistant/message', 'reply'),
        messageEvent('user/message', 'second'),
    ];
    const text = extractTranscript(events, 10);
    assert.match(text, /user: first/);
    assert.match(text, /assistant: reply/);
    assert.match(text, /user: second/);
    assert.doesNotMatch(text, /turn\/start/);
    const windowed = extractTranscript(events, 2);
    assert.doesNotMatch(windowed, /first/);
    assert.match(windowed, /second/);
});
test('auto-summarizer triggers every N user messages and writes memories', async () => {
    stubFetch();
    const { store, dir } = await freshStore();
    const embeddings = new EmbeddingService({
        provider: 'api', apiKey: 'k', apiBase: 'http://x', apiModel: 'm',
        localModel: 'unused', remoteHost: 'https://huggingface.co',
        memoryPath: join(dir, 'memories.jsonl'), promptTopK: 3, maxSearchResults: 10,
        minScore: 0, halfLifeMs: 86400000,
        autoSummarizeEvery: 5, summarizeWindow: 12, summarizeMaxTokens: 400, summarizeTemperature: 0.2,
    });
    const llm = fakeLlm('[{"kind":"preference","content":"user prefers tea"},{"kind":"fact","content":"the server uses TLS"}]');
    const summarizer = new AutoSummarizer({
        store,
        embeddings,
        llm: llm,
        defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    }, { every: 5, window: 12, maxTokens: 400, temperature: 0.2 });
    const events = [];
    const session = { id: 'sess-1', events, header: { cwd: 'C:\\work' } };
    const capture = captureListener(ctx => summarizer.attach(ctx));
    for (let i = 1; i <= 4; i += 1) {
        const event = messageEvent('user/message', `message ${i}`);
        events.push(event);
        capture.emit(session, event);
        assert.equal(summarizer.countFor('sess-1'), i);
    }
    assert.equal(store.size, 0); // threshold not reached yet
    const fifth = messageEvent('user/message', 'message 5');
    events.push(fifth);
    capture.emit(session, fifth);
    assert.equal(summarizer.countFor('sess-1'), 5);
    // Wait for the async summary to land.
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (store.size >= 2)
            break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(store.size, 2);
    const entries = store.all();
    const tea = entries.find(e => e.content.includes('tea'));
    const tls = entries.find(e => e.content.includes('TLS'));
    assert.ok(tea !== undefined);
    assert.equal(tea.kind, 'preference');
    assert.deepEqual([...tea.tags], ['auto']);
    assert.equal(tea.workspace, 'C:\\work');
    assert.ok(tls !== undefined);
    assert.equal(tls.source?.sessionId, 'sess-1');
    await embeddings.dispose();
    await rm(dir, { recursive: true, force: true });
});
test('auto-summarizer is silent without llm or defaultModel', async () => {
    const { store, dir } = await freshStore();
    const summarizer = new AutoSummarizer({
        store,
        embeddings: undefined,
        llm: undefined,
        defaultModel: undefined,
    }, { every: 2, window: 12, maxTokens: 400, temperature: 0.2 });
    const capture = captureListener(ctx => summarizer.attach(ctx));
    capture.emit({ id: 's1' }, messageEvent('user/message', 'x'));
    capture.emit({ id: 's1' }, messageEvent('user/message', 'y'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.size, 0);
    await rm(dir, { recursive: true, force: true });
});
