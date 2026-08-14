/**
 * dsh-plugin-semantic-memory — embedding-based long-term memory for
 * DeepSeek Harness.
 *
 * The plugin persists a cross-session memory store (JSONL under `$DSH_HOME`),
 * embeds entries with a local ONNX model or an OpenAI-compatible API, exposes
 * four model-facing tools (`memory_write`, `memory_search`, `memory_forget`,
 * `memory_stats`), watches the session event stream for new user messages and
 * proactively recalls memories relevant to the current question into every
 * system-prompt assembly.
 *
 * @module dsh-plugin-semantic-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export declare const name = "semantic-memory";
export { Config };
export { MemoryStore, contentHash, strengthOf, type MemoryEntry, type SearchHit } from './store.ts';
export { EmbeddingService } from './embedding.ts';
export { RecallCache, extractUserText, type RecallState } from './recall.ts';
export { AutoSummarizer, parseSummary, extractTranscript, type SummarizeConfig } from './summarize.ts';
/** Capability services required by the model-facing consumer. */
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
