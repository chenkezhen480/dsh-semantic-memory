/** Deployment configuration for the semantic memory plugin. */

import z from '@deepseek-ai/schemastery'

/** Memory kinds the model may distinguish when writing entries. */
export const MEMORY_KINDS = ['fact', 'decision', 'preference', 'note'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface Config {
  /** Embedding provider: local ONNX inference or an OpenAI-compatible API. */
  readonly provider?: 'local' | 'api'
  /** Local transformer model id (used when provider is `local`). */
  readonly localModel?: string
  /** HuggingFace remote host for model downloads; use a mirror such as https://hf-mirror.com in restricted networks. */
  readonly remoteHost?: string
  /** OpenAI-compatible embeddings endpoint base URL (used when provider is `api`). */
  readonly apiBase?: string
  /** API key for the embeddings endpoint (used when provider is `api`). */
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

/** Schemastery schema for Loader defaults and configuration docs. */
export const Config: z<Config> = z.object({
  provider: z.union([z.const('local'), z.const('api')]).default('local'),
  localModel: z.string().default('Xenova/bge-small-zh-v1.5'),
  remoteHost: z.string().default('https://huggingface.co'),
  apiBase: z.string().default('https://api.siliconflow.cn/v1'),
  apiKey: z.string().default(''),
  apiModel: z.string().default('BAAI/bge-m3'),
  memoryPath: z.string().default(''),
  promptTopK: z.number().step(1).min(0).max(20).default(3),
  maxSearchResults: z.number().step(1).min(1).max(50).default(10),
  minScore: z.number().min(0).max(1).default(0.35),
  halfLifeMs: z.number().min(1).default(30 * 24 * 60 * 60 * 1000),
  autoSummarizeEvery: z.number().step(1).min(0).max(100).default(5),
  summarizeWindow: z.number().step(1).min(1).max(100).default(12),
  summarizeMaxTokens: z.number().step(1).min(64).max(2000).default(400),
  summarizeTemperature: z.number().min(0).max(2).default(0.2),
})

const DEFAULT_MEMORY_FILE = 'memories/memories.jsonl'

/** Resolve the config against process environment defaults. */
export function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'local'
  if (provider !== 'local' && provider !== 'api') {
    throw new TypeError(`semantic-memory: provider must be "local" or "api", got ${String(provider)}`)
  }
  const apiKey = config.apiKey ?? ''
  const memoryPath = (config.memoryPath ?? '').length > 0
    ? config.memoryPath!
    : joinDshHome(DEFAULT_MEMORY_FILE)
  if (provider === 'api' && apiKey.length === 0) {
    throw new TypeError('semantic-memory: api provider requires apiKey')
  }
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
    autoSummarizeEvery: config.autoSummarizeEvery ?? 5,
    summarizeWindow: config.summarizeWindow ?? 12,
    summarizeMaxTokens: config.summarizeMaxTokens ?? 400,
    summarizeTemperature: config.summarizeTemperature ?? 0.2,
  }
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
