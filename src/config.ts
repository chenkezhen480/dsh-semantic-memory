/** Deployment configuration for the semantic memory plugin. */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Memory kinds the model may distinguish when writing entries. */
export const MEMORY_KINDS = ['fact', 'decision', 'preference', 'note'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * Legacy settings-document namespace. The current Settings service projects
 * this plugin's Config entry directly, so nothing registers under this name any
 * more; it stays exported for callers that still import it.
 */
export const SETTINGS_NAMESPACE = 'semantic-memory'

export interface Config {
  /**
   * Deployment mode. `local` forces the ONNX model, `cloud` forces the
   * OpenAI-compatible API (apiKey required). Omit to keep the automatic
   * selection (a non-empty apiKey means `api`, otherwise `local`).
   */
  readonly mode?: 'local' | 'cloud'
  /**
   * Embedding provider. Omit (or use 'auto') to select automatically:
   * a non-empty apiKey means `api`, otherwise `local`. An explicit value
   * overrides the automatic selection; an explicit `mode` overrides both.
   */
  readonly provider?: 'local' | 'api' | 'auto'
  /** Local transformer model id (used when provider is `local`). */
  readonly localModel?: string
  /** HuggingFace remote host for model downloads; use a mirror such as https://hf-mirror.com in restricted networks. */
  readonly remoteHost?: string
  /** OpenAI-compatible embeddings endpoint base URL (used when provider is `api`). */
  readonly apiBase?: string
  /** API key for the embeddings endpoint. When non-empty and provider is not explicitly `local`, the api provider is used. */
  readonly apiKey?: string
  /** Embedding model name sent to the API (used when provider is `api`). */
  readonly apiModel?: string
  /** Absolute path of the memory store file (JSONL). */
  readonly memoryPath?: string
  /** Maximum memory entries injected into the system prompt per assembly. */
  readonly promptTopK?: number
  /** Default maximum hits returned by one memory_search call. */
  readonly maxSearchResults?: number
  /** Minimum cosine score for a search hit (0..1). */
  readonly minScore?: number
  /** Memory half-life in milliseconds used by the strength decay model. */
  readonly halfLifeMs?: number
  /** Auto-summarize every N user messages (0 disables). Requires llm + agentDefaultModel services. */
  readonly autoSummarizeEvery?: number
  /** Number of most recent messages included in one auto-summary. */
  readonly summarizeWindow?: number
  readonly summarizeMaxTokens?: number
  readonly summarizeTemperature?: number
}

export interface ResolvedConfig {
  readonly provider: 'local' | 'api'
  readonly localModel: string
  readonly remoteHost: string
  readonly apiBase: string
  readonly apiKey: string
  readonly apiModel: string
  readonly memoryPath: string
  readonly promptTopK: number
  readonly maxSearchResults: number
  readonly minScore: number
  readonly halfLifeMs: number
  readonly autoSummarizeEvery: number
  readonly summarizeWindow: number
  readonly summarizeMaxTokens: number
  readonly summarizeTemperature: number
}

/**
 * Runtime shape of the configuration handed to `apply()` by the Loader: every
 * field is a live reference, because every field below is `.volatile()`.
 */
export type ConfigValues = {
  readonly [K in keyof Required<Config>]: Volatile<Config[K] | undefined>
}

/**
 * What `apply()` accepts: Loader references in a running profile, or a plain
 * object when the plugin is mounted directly (tests, embedding in another app).
 */
export type ConfigInput = ConfigValues | Config

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
export const Config: z<ConfigValues> = z.object({
  mode: z.union([z.const('local'), z.const('cloud')]).volatile(),
  provider: z.union([z.const('local'), z.const('api'), z.const('auto')]).default('auto').volatile(),
  localModel: z.string().default('Xenova/bge-small-zh-v1.5').volatile(),
  remoteHost: z.string().default('https://huggingface.co').volatile(),
  apiBase: z.string().default('https://api.siliconflow.cn/v1').volatile(),
  apiKey: z.string().role('secret').default('').volatile(),
  apiModel: z.string().default('BAAI/bge-m3').volatile(),
  memoryPath: z.string().default('').volatile(),
  promptTopK: z.number().step(1).min(0).max(20).default(3).volatile(),
  maxSearchResults: z.number().step(1).min(1).max(50).default(10).volatile(),
  minScore: z.number().min(0).max(1).default(0.35).volatile(),
  halfLifeMs: z.number().min(1).default(30 * 24 * 60 * 60 * 1000).volatile(),
  autoSummarizeEvery: z.number().step(1).min(0).max(100).default(5).volatile(),
  summarizeWindow: z.number().step(1).min(1).max(100).default(12).volatile(),
  summarizeMaxTokens: z.number().step(1).min(64).max(4000).default(800).volatile(),
  summarizeTemperature: z.number().min(0).max(2).default(0.2).volatile(),
}) as z<ConfigValues>

/** Declared field order; also the order the Settings form renders. */
const CONFIG_FIELDS = [
  'mode', 'provider', 'localModel', 'remoteHost', 'apiBase', 'apiKey', 'apiModel',
  'memoryPath', 'promptTopK', 'maxSearchResults', 'minScore', 'halfLifeMs',
  'autoSummarizeEvery', 'summarizeWindow', 'summarizeMaxTokens', 'summarizeTemperature',
] as const satisfies readonly (keyof Required<Config>)[]

/**
 * Read plain values out of the configuration `apply()` received.
 *
 * Loader references expose `.get()`; a plain object passes through unchanged, so
 * the same helper serves a profile mount and a direct mount. Reading through it
 * is what makes a committed settings edit visible to the next consumer call.
 */
export function plainConfig(config: ConfigInput): Config {
  const plain: Record<string, unknown> = {}
  for (const key of CONFIG_FIELDS) {
    const value = (config as Record<string, unknown>)[key]
    plain[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
      ? (value as Volatile<unknown>).get()
      : value
  }
  return plain as Config
}

const DEFAULT_MEMORY_FILE = 'memories/memories.jsonl'

/**
 * Environment variable for the auto-summarize cadence: a positive integer
 * triggers every N user messages, `0` disables the feature. Takes precedence
 * over the configuration document so users can tune it without editing files.
 */
export const AUTO_SUMMARIZE_EVERY_ENV = 'DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY'

/** Parse the env override: 0..100 integer, or undefined when absent/invalid. */
export function summarizeEveryFromEnv(): number | undefined {
  const raw = process.env[AUTO_SUMMARIZE_EVERY_ENV]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 100) return undefined
  return value
}

/** Resolve the config against environment defaults; provider auto-selects. */
export function resolveConfig(config: Config): ResolvedConfig {
  const apiKey = config.apiKey ?? ''
  const mode = config.mode
  const explicit = config.provider ?? 'auto'
  if (explicit !== 'local' && explicit !== 'api' && explicit !== 'auto') {
    throw new TypeError(`semantic-memory: provider must be "local", "api", or "auto", got ${String(explicit)}`)
  }
  // Deployment mode wins when set: `cloud` forces the API provider,
  // `local` forces the local model. Otherwise provider auto-selects by apiKey.
  const provider = mode === 'cloud' ? 'api'
    : mode === 'local' ? 'local'
    : explicit === 'auto' ? (apiKey.length > 0 ? 'api' : 'local')
    : explicit
  if (provider === 'api' && apiKey.length === 0) {
    throw new TypeError('semantic-memory: api provider requires apiKey')
  }
  const memoryPath = (config.memoryPath ?? '').length > 0
    ? config.memoryPath!
    : joinDshHome(DEFAULT_MEMORY_FILE)
  return {
    provider,
    localModel: config.localModel ?? 'Xenova/bge-small-zh-v1.5',
    remoteHost: config.remoteHost ?? 'https://huggingface.co',
    apiBase: config.apiBase ?? 'https://api.siliconflow.cn/v1',
    apiKey,
    apiModel: config.apiModel ?? 'BAAI/bge-m3',
    memoryPath,
    promptTopK: config.promptTopK ?? 3,
    maxSearchResults: config.maxSearchResults ?? 10,
    minScore: config.minScore ?? 0.35,
    halfLifeMs: config.halfLifeMs ?? 30 * 24 * 60 * 60 * 1000,
    autoSummarizeEvery: summarizeEveryFromEnv() ?? config.autoSummarizeEvery ?? 5,
    summarizeWindow: config.summarizeWindow ?? 12,
    summarizeMaxTokens: config.summarizeMaxTokens ?? 800,
    summarizeTemperature: config.summarizeTemperature ?? 0.2,
  }
}

/** Equality over the fields that force an embedding-provider rebuild. */
export function embeddingIdentityChanged(
  left: ResolvedConfig,
  right: ResolvedConfig,
): boolean {
  return left.provider !== right.provider
    || left.localModel !== right.localModel
    || left.remoteHost !== right.remoteHost
    || left.apiBase !== right.apiBase
    || left.apiKey !== right.apiKey
    || left.apiModel !== right.apiModel
}

function joinDshHome(relative: string): string {
  const home = process.env.DSH_HOME ?? joinHome('.dsh')
  return `${home.replace(/[\\/]+$/u, '')}/${relative}`
}

function joinHome(name: string): string {
  const root = process.env.USERPROFILE ?? process.env.HOME
  if (root === undefined) throw new Error('semantic-memory: cannot locate the user home directory')
  return `${root.replace(/[\\/]+$/u, '')}/${name}`
}
