/**
 * Proactive semantic recall: watches the session event stream and, on every
 * new user message, asynchronously embeds the message text and searches the
 * memory store. The freshest per-session result is cached and consumed by the
 * system-prompt section provider, so each turn is seeded with memories
 * relevant to the *current question* — no tool call required.
 *
 * Concurrency: a monotonically increasing generation invalidates stale
 * in-flight recalls, so a fast user message never overwrites a newer one.
 * Failures (model not downloaded yet, API down) are silent: the prompt falls
 * back to strength-ranked injection.
 *
 * @module dsh-plugin-semantic-memory/recall
 */
import type { Context } from '@deepseek-ai/cordis';
import type { EmbeddingService } from './embedding.ts';
import type { MemoryStore, SearchHit } from './store.ts';
export interface RecallConfig {
    /** Maximum hits injected per recall. */
    readonly topK: number;
    /** Minimum cosine score for a recall hit. */
    readonly minScore: number;
    /** A recall cache older than this is stale and falls back to strength ranking. */
    readonly staleMs: number;
}
export interface RecallState {
    readonly sessionId: string;
    readonly query: string;
    readonly hits: readonly SearchHit[];
    readonly at: number;
}
export declare class RecallCache {
    private readonly store;
    private readonly embeddings;
    private readonly config;
    private state;
    private generation;
    constructor(store: MemoryStore, embeddings: EmbeddingService, config: RecallConfig);
    /** Listen for user messages on all sessions. Returns nothing (ctx owns the listener). */
    attach(ctx: Context): void;
    /** The current recall for one session, or undefined when absent or stale. */
    recallFor(sessionId: string): RecallState | undefined;
    private startRecall;
}
/** Extract the user-visible text of a user/message payload. */
export declare function extractUserText(data: unknown): string;
