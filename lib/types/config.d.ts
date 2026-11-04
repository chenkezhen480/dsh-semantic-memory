/** Deployment configuration for the semantic memory plugin. */
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Memory kinds the model may distinguish when writing entries. */
export declare const MEMORY_KINDS: readonly ["fact", "decision", "preference", "note"];
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/**
 * Legacy settings-document namespace. The current Settings service projects
 * this plugin's Config entry directly, so nothing registers under this name any
 * more; it stays exported for callers that still import it.
 */
export declare const SETTINGS_NAMESPACE = "semantic-memory";
export interface Config {
    /**
     * Deployment mode. `local` forces the ONNX model, `cloud` forces the
     * OpenAI-compatible API (apiKey required). Omit to keep the automatic
     * selection (a non-empty apiKey means `api`, otherwise `local`).
     */
    readonly mode?: 'local' | 'cloud';
    /**
     * Embedding provider. Omit (or use 'auto') to select automatically:
     * a non-empty apiKey means `api`, otherwise `local`. An explicit value
     * overrides the automatic selection; an explicit `mode` overrides both.
     */
    readonly provider?: 'local' | 'api' | 'auto';
    /** Local transformer model id (used when provider is `local`). */
    readonly localModel?: string;
    /** HuggingFace remote host for model downloads; use a mirror such as https://hf-mirror.com in restricted networks. */
    readonly remoteHost?: string;
    /** OpenAI-compatible embeddings endpoint base URL (used when provider is `api`). */
    readonly apiBase?: string;
    /** API key for the embeddings endpoint. When non-empty and provider is not explicitly `local`, the api provider is used. */
    readonly apiKey?: string;
    /** Embedding model name sent to the API (used when provider is `api`). */
    readonly apiModel?: string;
    /** Absolute path of the memory store file (JSONL). */
    readonly memoryPath?: string;
    /** Maximum memory entries injected into the system prompt per assembly. */
    readonly promptTopK?: number;
    /** Default maximum hits returned by one memory_search call. */
    readonly maxSearchResults?: number;
    /** Minimum cosine score for a search hit (0..1). */
    readonly minScore?: number;
    /** Memory half-life in milliseconds used by the strength decay model. */
    readonly halfLifeMs?: number;
    /** Auto-summarize every N user messages (0 disables). Requires llm + agentDefaultModel services. */
    readonly autoSummarizeEvery?: number;
    /** Number of most recent messages included in one auto-summary. */
    readonly summarizeWindow?: number;
    readonly summarizeMaxTokens?: number;
    readonly summarizeTemperature?: number;
}
export interface ResolvedConfig {
    readonly provider: 'local' | 'api';
    readonly localModel: string;
    readonly remoteHost: string;
    readonly apiBase: string;
    readonly apiKey: string;
    readonly apiModel: string;
    readonly memoryPath: string;
    readonly promptTopK: number;
    readonly maxSearchResults: number;
    readonly minScore: number;
    readonly halfLifeMs: number;
    readonly autoSummarizeEvery: number;
    readonly summarizeWindow: number;
    readonly summarizeMaxTokens: number;
    readonly summarizeTemperature: number;
}
/**
 * Runtime shape of the configuration handed to `apply()` by the Loader: every
 * field is a live reference, because every field below is `.volatile()`.
 */
export type ConfigValues = {
    readonly [K in keyof Required<Config>]: Volatile<Config[K] | undefined>;
};
/**
 * What `apply()` accepts: Loader references in a running profile, or a plain
 * object when the plugin is mounted directly (tests, embedding in another app).
 */
export type ConfigInput = ConfigValues | Config;
/**
 * Schemastery schema for Loader defaults and config docs.
 *
 * Every field is `.volatile()`: the Settings forms project volatile fields, a
 * form write persists into the profile patch, and the Loader then commits the
 * new value into the running reference in place and emits
 * `loader/volatile-update` on this fiber instead of remounting the plugin.
 * Fields must stay at fixed object paths — Schemastery rejects a volatile field
 * nested inside another volatile field.
 */
export declare const Config: z<ConfigValues>;
/**
 * Read plain values out of the configuration `apply()` received.
 *
 * Loader references expose `.get()`; a plain object passes through unchanged, so
 * the same helper serves a profile mount and a direct mount. Reading through it
 * is what makes a committed settings edit visible to the next consumer call.
 */
export declare function plainConfig(config: ConfigInput): Config;
/**
 * Environment variable for the auto-summarize cadence: a positive integer
 * triggers every N user messages, `0` disables the feature. Takes precedence
 * over the configuration document so users can tune it without editing files.
 */
export declare const AUTO_SUMMARIZE_EVERY_ENV = "DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY";
/** Parse the env override: 0..100 integer, or undefined when absent/invalid. */
export declare function summarizeEveryFromEnv(): number | undefined;
/** Resolve the config against environment defaults; provider auto-selects. */
export declare function resolveConfig(config: Config): ResolvedConfig;
/** Equality over the fields that force an embedding-provider rebuild. */
export declare function embeddingIdentityChanged(left: ResolvedConfig, right: ResolvedConfig): boolean;
