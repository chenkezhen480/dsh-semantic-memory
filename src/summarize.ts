/**
 * Automatic conversation summarization into long-term memory.
 *
 * Watches the session event stream, counts user messages per session, and
 * every `N`-th message asks the harness LLM to distill the recent transcript
 * into structured memory entries, which are embedded and written to the store
 * like any `memory_write`. One in-flight summary per session; failures are
 * silent so summarization never disturbs the main conversation.
 *
 * @module dsh-plugin-semantic-memory/summarize
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EmbeddingService } from './embedding.ts'
import type { MemoryKind, ResolvedConfig } from './config.ts'
import type { MemoryStore } from './store.ts'

export interface SummarizeConfig {
  /** Trigger a summary every N user messages. 0 disables. */
  readonly every: number
  /** Number of most recent user+assistant messages to include. */
  readonly window: number
  readonly maxTokens: number
  readonly temperature: number
}

/** Structural LLM surface (avoids a hard dsh-llm peer dependency). */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: readonly unknown[]
    temperature?: number
    maxTokens?: number
    stop?: readonly string[]
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** Structural default-model surface (avoids a hard dsh-agent-default-model dep). */
export interface DefaultModelLike {
  read(): { readonly provider: string; readonly model: string }
}

interface SummarizerServices {
  readonly store: MemoryStore
  readonly embeddings: EmbeddingService
  readonly llm: LlmLike | undefined
  readonly defaultModel: DefaultModelLike | undefined
}

interface SummaryItem {
  readonly kind: MemoryKind
  readonly content: string
}

const SUMMARY_SYSTEM_PROMPT = [
  'You distill short conversations into durable long-term memories for the user.',
  'Return ONLY a JSON array, no prose, no markdown fences:',
  '[{"kind":"fact|decision|preference|note","content":"one self-contained sentence"}]',
  'Rules:',
  '- Include durable user preferences, established facts, and explicit decisions.',
  '- Omit transient chatter, task steps, and information already covered.',
  '- Each content is timeless, pronoun-free, and mentions the user only when needed.',
  '- At most 5 items; empty array when nothing is worth remembering.',
].join('\n')

const SUMMARY_STOP = ['\n\n']

export class AutoSummarizer {
  private readonly counts = new Map<string, number>()
  private readonly busy = new Set<string>()

  constructor(
    private readonly services: SummarizerServices,
    private readonly config: SummarizeConfig,
  ) {}

  /** Listen for user messages; the listener is owned by ctx. */
  attach(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = session.id
      const count = (this.counts.get(id) ?? 0) + 1
      this.counts.set(id, count)
      if (count % this.config.every === 0) {
        this.trigger(session)
      }
    })
  }

  /** Number of user messages seen for one session (test/observation surface). */
  countFor(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0
  }

  private trigger(session: { readonly id: string; readonly events?: readonly unknown[] }): void {
    if (this.busy.has(session.id)) return
    this.busy.add(session.id)
    void (async () => {
      try {
        await this.summarize(session)
      } catch (error) {
        // Silent: summarization must never disturb the conversation.
        console.error('[semantic-memory] auto-summary failed:', String(error))
      } finally {
        this.busy.delete(session.id)
      }
    })()
  }

  private async summarize(session: { readonly id: string; readonly events?: readonly unknown[] }): Promise<void> {
    const { llm, defaultModel } = this.services
    if (llm === undefined || defaultModel === undefined) return
    const transcript = extractTranscript(session.events, this.config.window)
    if (transcript.length === 0) return
    const { provider, model } = defaultModel.read()
    const text = await collectText(llm.stream({
      provider,
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: transcript }],
        source: { kind: 'user' },
        id: `semantic-memory-summary-${session.id}`,
      }],
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      stop: SUMMARY_STOP,
    }))
    const items = parseSummary(text)
    if (items.length === 0) return
    const vectors = await this.services.embeddings.embed(items.map(item => item.content))
    const events = session.events ?? []
    const last = events.length > 0 ? events[events.length - 1] as { seq?: number } : undefined
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const vector = vectors[index]
      if (item === undefined || vector === undefined || vector.length === 0) continue
      await this.services.store.put({
        kind: item.kind,
        content: item.content,
        tags: ['auto'],
        workspace: sessionWorkspace(session),
        source: { sessionId: session.id, seq: last?.seq ?? 0 },
        importance: 3,
        embedding: vector,
      })
    }
  }
}

/** Recent user/assistant transcript as one text block. */
export function extractTranscript(events: readonly unknown[] | undefined, window: number): string {
  if (events === undefined || events.length === 0) return ''
  const lines: string[] = []
  for (const event of events.slice(-window)) {
    const record = event as { type?: string; data?: unknown }
    if (record.type !== 'user/message' && record.type !== 'assistant/message') continue
    const text = extractMessageText(record.data)
    if (text.length === 0) continue
    lines.push(`${record.type === 'user/message' ? 'user' : 'assistant'}: ${text}`)
  }
  return lines.join('\n')
}

/** Extract text blocks from a user/assistant message payload. */
export function extractMessageText(data: unknown): string {
  const message = data as { content?: unknown } | undefined
  if (message === undefined || !Array.isArray(message.content)) return ''
  let text = ''
  for (const block of message.content) {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      text += (block as { text: string }).text
    }
  }
  return text.trim()
}

/** Collect text-delta chunks from a stream. */
export async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    const record = chunk as { type?: unknown; text?: unknown }
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      text += record.text
    }
  }
  return text.trim()
}

/** Parse the model's JSON-array answer, tolerating fences and prose. */
export function parseSummary(text: string): SummaryItem[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items: SummaryItem[] = []
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null) continue
    const kind = (value as { kind?: unknown }).kind
    const content = (value as { content?: unknown }).content
    if (typeof kind !== 'string' || typeof content !== 'string') continue
    if (!['fact', 'decision', 'preference', 'note'].includes(kind)) continue
    const trimmed = content.trim()
    if (trimmed.length === 0 || trimmed.length > 2000) continue
    items.push({ kind: kind as MemoryKind, content: trimmed })
  }
  return items.slice(0, 5)
}

function sessionWorkspace(session: { readonly events?: readonly unknown[] }): string | undefined {
  const header = (session as { header?: { cwd?: string } }).header
  return header?.cwd
}

/** Convenience for index.ts: build a summarizer from resolved config. */
export function createSummarizer(
  services: SummarizerServices,
  config: ResolvedConfig,
): AutoSummarizer | undefined {
  if (config.autoSummarizeEvery < 1) return undefined
  return new AutoSummarizer(services, {
    every: config.autoSummarizeEvery,
    window: config.summarizeWindow,
    maxTokens: config.summarizeMaxTokens,
    temperature: config.summarizeTemperature,
  })
}
