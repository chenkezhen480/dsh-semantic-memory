/**
 * dsh-plugin-semantic-memory — embedding-based long-term memory for
 * DeepSeek Harness.
 *
 * The plugin persists a cross-session memory store (JSONL under `$DSH_HOME`),
 * embeds entries with a local ONNX model or an OpenAI-compatible API, exposes
 * four model-facing tools (`memory_write`, `memory_search`, `memory_forget`,
 * `memory_stats`), watches the session event stream for new user messages and
 * proactively recalls memories relevant to the current question into every
 * system-prompt assembly, and auto-summarizes conversations every N turns.
 *
 * Configuration flows through the harness settings service when available:
 * the `semantic-memory` namespace layers the user document
 * (`$DSH_HOME/settings.yaml`) UNDER the composition (cordis patch) config —
 * in-package config overrides outer layers (包内覆盖外层). Provider selection
 * is `mode`-driven (`local` / `cloud`) or automatic: a non-empty `apiKey`
 * uses the API, otherwise the local model. Settings changes hot-reload
 * without a restart.
 *
 * @module dsh-plugin-semantic-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, resolveConfig, SETTINGS_NAMESPACE, type Config as ConfigValue } from './config.ts';
export declare const name = "semantic-memory";
export { Config, SETTINGS_NAMESPACE, resolveConfig };
export { MemoryStore, contentHash, strengthOf, type MemoryEntry, type SearchHit } from './store.ts';
export { EmbeddingService } from './embedding.ts';
export { RecallCache, extractUserText, type RecallState } from './recall.ts';
export { AutoSummarizer, parseSummary, extractTranscript, type SummarizeConfig } from './summarize.ts';
/** Capability services required by the model-facing consumer. */
export declare const inject: string[];
export declare function apply(ctx: Context, config: ConfigValue): void;
