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
 * Configuration lives in this plugin's Loader entry (the bundle's
 * `cordis.patch.yml` defaults, overridden by the profile patch or the Settings
 * forms). Every field is volatile, so a Settings edit is committed into the
 * running references and announced through `loader/volatile-update` instead of
 * remounting the plugin; a change to an ordinary field would remount it, which
 * simply runs `apply()` again. Provider selection is `mode`-driven
 * (`local` / `cloud`) or automatic: a non-empty `apiKey` uses the API,
 * otherwise the local model.
 *
 * @module dsh-plugin-semantic-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, resolveConfig, SETTINGS_NAMESPACE, type ConfigInput } from './config.ts';
export declare const name = "semantic-memory";
export { Config, SETTINGS_NAMESPACE, resolveConfig };
export { MemoryStore, contentHash, strengthOf, type MemoryEntry, type SearchHit } from './store.ts';
export { EmbeddingService } from './embedding.ts';
export { RecallCache, extractUserText, type RecallState } from './recall.ts';
export { AutoSummarizer, parseSummary, extractTranscript, type SummarizeConfig } from './summarize.ts';
/** Capability services required by the model-facing consumer. */
export declare const inject: string[];
/**
 * The Loader publishes `loader/volatile-update` on the owning fiber. Declared
 * here so the plugin type-checks without a hard `cordis-plugin-loader`
 * dependency; the runtime event comes from the profile's Loader.
 */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
export declare function apply(ctx: Context, config: ConfigInput): void;
