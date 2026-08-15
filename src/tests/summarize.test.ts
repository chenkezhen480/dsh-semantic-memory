/**
 * Tests for automatic conversation summarization: message counting, LLM
 * distillation, JSON parsing, and store writes — with a fake stream and the
 * API embedding path (no network).
 *
 * @module dsh-plugin-semantic-memory/tests/summarize
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AutoSummarizer, collectText, extractTranscript, lastMessageSeq, parseSummary } from '../summarize.ts'
import { EmbeddingService } from '../embedding.ts'
import { MemoryStore } from '../store.ts'

const DIM = 8

function vectorOf(text: string): number[] {
  const values: number[] = []
  let seed = 0
  for (const char of text) seed = (seed * 31 + char.codePointAt(0)!) >>> 0
  for (let axis = 0; axis < DIM; axis += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0
    values.push((seed % 1000) / 1000)
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0))
  return values.map(v => v / norm)
}

function stubFetch(): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.input.map(text => ({ embedding: vectorOf(text) })),
      }),
    } as unknown as Response
  }) as typeof fetch
}

function fakeLlm(answers: readonly string[]): { stream(): AsyncIterable<unknown> } {
  let call = 0
  return {
    async * stream() {
      const answer = answers[Math.min(call, answers.length - 1)] ?? ''
      call += 1
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0 }
      yield { type: 'finish' }
    },
  }
}

/** A session event with a seq, like the live Session emits. */
function messageEvent(type: 'user/message' | 'assistant/message', text: string, seq: number): unknown {
  return { type, seq, data: { content: [{ type: 'text', text }], source: { kind: type === 'user/message' ? 'user' : 'model' } } }
}

function captureListener(attach: (ctx: { on(name: string, cb: (...args: unknown[]) => void): void }) => void): {
  emit(session: unknown, event: unknown): void
} {
  let listener: ((...args: unknown[]) => void) | undefined
  attach({ on: (_name, cb) => { listener = cb } })
  return {
    emit(session, event) {
      listener?.(session, event)
    },
  }
}

async function freshStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'smem-summary-'))
  const store = new MemoryStore(join(dir, 'memories.jsonl'), 86400000)
  return { store, dir }
}

test('parseSummary extracts a valid JSON array and rejects bad input', () => {
  const items = parseSummary('Here you go:\n```json\n[{"kind":"fact","content":"sky is blue"},{"kind":"preference","content":"likes tea"}]```')
  assert.equal(items.length, 2)
  assert.equal(items[0]?.kind, 'fact')
  assert.equal(items[1]?.content, 'likes tea')
  assert.equal(parseSummary('no json here').length, 0)
  assert.equal(parseSummary('[{"kind":"bogus","content":"x"}]').length, 0)
  assert.equal(parseSummary('[{"content":"missing kind"}]').length, 0)
  assert.equal(parseSummary('[]').length, 0)
})

test('collectText concatenates text-delta chunks', async () => {
  const text = await collectText(fakeLlm(['part1']).stream())
  assert.equal(text, 'part1')
  const multi = await collectText((async function * () {
    yield { type: 'text-delta', index: 0, text: 'a' }
    yield { type: 'text-delta', index: 0, text: 'b' }
    yield { type: 'reasoning-delta', index: 0, text: 'ignored' }
    yield { type: 'text-delta', index: 0, text: 'c' }
  })())
  assert.equal(multi, 'abc')
})

test('extractTranscript keeps recent user/assistant text only, after a cursor', () => {
  const events = [
    messageEvent('user/message', 'first', 1),
    { type: 'turn/start', data: {} },
    messageEvent('assistant/message', 'reply', 2),
    messageEvent('user/message', 'second', 3),
  ]
  const text = extractTranscript(events, 10)
  assert.match(text, /user: first/)
  assert.match(text, /assistant: reply/)
  assert.match(text, /user: second/)
  assert.doesNotMatch(text, /turn\/start/)
  const windowed = extractTranscript(events, 2)
  assert.doesNotMatch(windowed, /first/)
  assert.match(windowed, /second/)
  // Incremental: only events above the cursor are included.
  const incremental = extractTranscript(events, 10, 2)
  assert.doesNotMatch(incremental, /first/)
  assert.doesNotMatch(incremental, /reply/)
  assert.match(incremental, /second/)
  assert.equal(extractTranscript(events, 10, 3), '')
})

test('lastMessageSeq finds the newest message seq', () => {
  const events = [
    messageEvent('user/message', 'a', 1),
    { type: 'turn/end', seq: 2, data: {} },
    messageEvent('assistant/message', 'b', 3),
  ]
  assert.equal(lastMessageSeq(events), 3)
  assert.equal(lastMessageSeq([{ type: 'turn/end', seq: 9, data: {} }]), undefined)
  assert.equal(lastMessageSeq(undefined), undefined)
})

test('auto-summarizer triggers every N user messages and writes memories', async () => {
  stubFetch()
  const { store, dir } = await freshStore()
  const embeddings = new EmbeddingService({
    provider: 'api', apiKey: 'k', apiBase: 'http://x', apiModel: 'm',
    localModel: 'unused', remoteHost: 'https://huggingface.co',
    memoryPath: join(dir, 'memories.jsonl'), promptTopK: 3, maxSearchResults: 10,
    minScore: 0, halfLifeMs: 86400000,
    autoSummarizeEvery: 5, summarizeWindow: 12, summarizeMaxTokens: 400, summarizeTemperature: 0.2,
  })
  const llm = fakeLlm(['[{"kind":"preference","content":"user prefers tea"},{"kind":"fact","content":"the server uses TLS"}]'])
  const summarizer = new AutoSummarizer({
    store,
    embeddings,
    llm: llm as never,
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }, { every: 5, window: 12, maxTokens: 400, temperature: 0.2 })

  const events: unknown[] = []
  const session = { id: 'sess-1', events, header: { cwd: 'C:\\work' } }
  const capture = captureListener(ctx => summarizer.attach(ctx as never))

  for (let i = 1; i <= 4; i += 1) {
    const event = messageEvent('user/message', `message ${i}`, i)
    events.push(event)
    capture.emit(session, event)
    assert.equal(summarizer.countFor('sess-1'), i)
  }
  assert.equal(store.size, 0) // threshold not reached yet

  const fifth = messageEvent('user/message', 'message 5', 5)
  events.push(fifth)
  capture.emit(session, fifth)
  assert.equal(summarizer.countFor('sess-1'), 5)

  // Wait for the async summary to land.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.size >= 2) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(store.size, 2)
  const entries = store.all()
  const tea = entries.find(e => e.content.includes('tea'))
  const tls = entries.find(e => e.content.includes('TLS'))
  assert.ok(tea !== undefined)
  assert.equal(tea.kind, 'preference')
  assert.deepEqual([...tea.tags], ['auto'])
  assert.equal(tea.workspace, 'C:\\work')
  assert.ok(tls !== undefined)
  assert.equal(tls.source?.sessionId, 'sess-1')

  await embeddings.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('incremental summary: the second trigger only covers new messages', async () => {
  stubFetch()
  const { store, dir } = await freshStore()
  const embeddings = new EmbeddingService({
    provider: 'api', apiKey: 'k', apiBase: 'http://x', apiModel: 'm',
    localModel: 'unused', remoteHost: 'https://huggingface.co',
    memoryPath: join(dir, 'memories.jsonl'), promptTopK: 3, maxSearchResults: 10,
    minScore: 0, halfLifeMs: 86400000,
    autoSummarizeEvery: 5, summarizeWindow: 12, summarizeMaxTokens: 400, summarizeTemperature: 0.2,
  })
  // Two calls with different answers: call 1 (turns 1-5), call 2 (turns 6-10).
  const llm = fakeLlm([
    '[{"kind":"fact","content":"first batch fact"}]',
    '[{"kind":"fact","content":"second batch fact"}]',
  ])
  const summarizer = new AutoSummarizer({
    store,
    embeddings,
    llm: llm as never,
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  }, { every: 5, window: 12, maxTokens: 400, temperature: 0.2 })

  const events: unknown[] = []
  const session = { id: 'sess-inc', events }
  const capture = captureListener(ctx => summarizer.attach(ctx as never))
  let seq = 0
  const send = (text: string): void => {
    seq += 1
    const event = messageEvent('user/message', text, seq)
    events.push(event)
    capture.emit(session, event)
  }
  const waitSize = async (size: number): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (store.size >= size) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(`store did not reach size ${size}`)
  }

  for (let i = 1; i <= 5; i += 1) send(`turn ${i}`)
  await waitSize(1)
  assert.ok(store.all().some(e => e.content.includes('first batch fact')))

  for (let i = 6; i <= 10; i += 1) send(`turn ${i}`)
  await waitSize(2)
  const contents = store.all().map(e => e.content)
  assert.ok(contents.some(c => c.includes('second batch fact')), `second batch missing: ${contents}`)
  // The second summary must NOT have re-digested the first batch.
  assert.ok(contents.filter(c => c.includes('first batch fact')).length <= 1, 'first batch duplicated')

  await embeddings.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('auto-summarizer is silent without llm or defaultModel', async () => {
  const { store, dir } = await freshStore()
  const summarizer = new AutoSummarizer({
    store,
    embeddings: undefined as never,
    llm: undefined,
    defaultModel: undefined,
  }, { every: 2, window: 12, maxTokens: 400, temperature: 0.2 })
  const capture = captureListener(ctx => summarizer.attach(ctx as never))
  capture.emit({ id: 's1' }, messageEvent('user/message', 'x', 1))
  capture.emit({ id: 's1' }, messageEvent('user/message', 'y', 2))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(store.size, 0)
  await rm(dir, { recursive: true, force: true })
})
