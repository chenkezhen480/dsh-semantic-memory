/**
 * Automatic long-term memory injection into the system prompt.
 *
 * A dynamic `systemPrompt.section` re-evaluates its text on every assembly and
 * renders, in priority order:
 *
 * 1. **Semantic recall** — the freshest per-session recall seeded by the
 *    current user message (see {@link ../recall.ts}), so the turn starts with
 *    memories relevant to the actual question.
 * 2. **Strength ranking** — fallback when no recall exists yet: the strongest
 *    memories by importance × recency × access (cheap, fixed-size).
 *
 * Deep semantic recall stays a tool call away via `memory_search`.
 *
 * @module dsh-plugin-semantic-memory/prompt
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RecallCache } from './recall.ts';
import type { MemoryStore } from './store.ts';
export interface PromptInjectionConfig {
    /** Current topK; a function so settings hot-reloads take effect immediately. */
    readonly topK: () => number;
}
export declare function registerMemoryPrompt(ctx: Context, store: MemoryStore, recall: RecallCache | undefined, config: PromptInjectionConfig): void;
