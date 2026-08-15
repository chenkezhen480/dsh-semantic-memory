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
import type { Context } from '@deepseek-ai/cordis';
import type { EmbeddingService } from './embedding.ts';
import type { MemoryKind, ResolvedConfig } from './config.ts';
import type { MemoryStore } from './store.ts';
export interface SummarizeConfig {
    /** Trigger a summary every N user messages. 0 disables. */
    readonly every: number;
    /** Number of most recent user+assistant messages to include. */
    readonly window: number;
    readonly maxTokens: number;
    readonly temperature: number;
}
/** Structural LLM surface (avoids a hard dsh-llm peer dependency). */
export interface LlmLike {
    stream(options: {
        provider: string;
        model: string;
        reasoningEffort?: string;
        system?: string;
        messages: readonly unknown[];
        temperature?: number;
        maxTokens?: number;
        stop?: readonly string[];
        signal?: AbortSignal;
    }): AsyncIterable<unknown>;
}
/** Structural default-model surface (avoids a hard dsh-agent-default-model dep). */
export interface DefaultModelLike {
    currentSelection(): {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    };
}
interface SummarizerServices {
    readonly store: MemoryStore;
    readonly embeddings: EmbeddingService;
    readonly llm: LlmLike | undefined;
    readonly defaultModel: DefaultModelLike | undefined;
}
interface SummaryItem {
    readonly kind: MemoryKind;
    readonly content: string;
}
export declare class AutoSummarizer {
    private readonly services;
    private readonly counts;
    private readonly busy;
    /** Per-session seq cursor: events at or below this seq were already summarized. */
    private readonly cursors;
    private every;
    private window;
    private maxTokens;
    private temperature;
    constructor(services: SummarizerServices, config: SummarizeConfig);
    /** Apply a settings hot-reload; threshold and window move immediately. */
    setConfig(config: SummarizeConfig): void;
    /** Listen for user messages; the listener is owned by ctx. */
    attach(ctx: Context): void;
    /** Number of user messages seen for one session (test/observation surface). */
    countFor(sessionId: string): number;
    private trigger;
    private summarize;
}
/** Seq of the last user/assistant message event, or undefined when none. */
export declare function lastMessageSeq(events: readonly unknown[] | undefined): number | undefined;
/**
 * Recent user/assistant transcript as one text block, restricted to events
 * newer than `afterSeq` (the per-session summarization cursor) and capped to
 * the most recent `window` messages.
 */
export declare function extractTranscript(events: readonly unknown[] | undefined, window: number, afterSeq?: number): string;
/** Extract text blocks from a user/assistant message payload. */
export declare function extractMessageText(data: unknown): string;
/** Collect text-delta chunks from a stream. */
export declare function collectText(stream: AsyncIterable<unknown>): Promise<string>;
/** Parse the model's JSON-array answer, tolerating fences and prose. */
export declare function parseSummary(text: string): SummaryItem[];
/** Convenience for index.ts: build a summarizer from resolved config. */
export declare function createSummarizer(services: SummarizerServices, config: ResolvedConfig): AutoSummarizer | undefined;
export {};
