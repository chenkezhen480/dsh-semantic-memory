/**
 * Embedding providers: local ONNX inference through @huggingface/transformers
 * or an OpenAI-compatible `/embeddings` HTTP endpoint.
 *
 * Both providers return normalized vectors so cosine similarity reduces to a
 * dot product. Initialization is single-flight: concurrent embed requests
 * share one readiness promise, and repeated texts are cached by content hash.
 *
 * @module dsh-plugin-semantic-memory/embedding
 */

import { embeddingIdentityChanged, type ResolvedConfig } from './config.ts'

export interface EmbeddingProvider {
  readonly dimension: number | undefined
  embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>>
  dispose(): Promise<void>
}

/** Lazy wrapper that picks the configured provider and single-flights startup. */
export class EmbeddingService {
  private provider: EmbeddingProvider | undefined
  private starting: Promise<EmbeddingProvider> | undefined
  private readonly cache = new Map<string, readonly number[]>()
  private disposed = false
  private config: ResolvedConfig

  constructor(config: ResolvedConfig) {
    this.config = config
  }

  /**
   * Apply a configuration change. When the embedding identity (provider,
   * model, endpoint, or key) changed, the current provider is disposed and
   * rebuilt lazily on the next embed; the vector cache is dropped because the
   * new provider may use a different dimension or space.
   */
  setConfig(next: ResolvedConfig): void {
    const identityChanged = embeddingIdentityChanged(this.config, next)
    this.config = next
    if (!identityChanged) return
    const provider = this.provider
    this.provider = undefined
    this.starting = undefined
    this.cache.clear()
    if (provider !== undefined) void provider.dispose()
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>> {
    const provider = await this.providerOrStart(signal)
    const uncached: string[] = []
    const positions: number[] = []
    const results: Array<readonly number[] | undefined> = []
    for (const text of texts) {
      const key = cacheKey(text)
      const hit = this.cache.get(key)
      results.push(hit)
      if (hit === undefined) {
        positions.push(results.length - 1)
        uncached.push(text)
      }
    }
    if (uncached.length > 0) {
      const vectors = await provider.embed(uncached, signal)
      if (vectors.length !== uncached.length) {
        throw new Error('semantic-memory: embedding provider returned an unexpected vector count')
      }
      for (let index = 0; index < uncached.length; index += 1) {
        const vector = vectors[index]
        if (vector === undefined) continue
        const normalized = normalize(vector)
        this.cache.set(cacheKey(uncached[index] ?? ''), normalized)
        results[positions[index] ?? 0] = normalized
      }
    }
    return results.map(vector => vector === undefined ? [] : vector)
  }

  get dimension(): number | undefined {
    return this.provider?.dimension
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const provider = this.provider
    this.provider = undefined
    if (provider !== undefined) await provider.dispose()
  }

  private async providerOrStart(signal?: AbortSignal): Promise<EmbeddingProvider> {
    if (this.disposed) throw new Error('semantic-memory: embedding service is disposed')
    if (this.provider !== undefined) return this.provider
    this.starting ??= createProvider(this.config).then(provider => {
      this.provider = provider
      return provider
    })
    return await this.starting
  }
}

async function createProvider(config: ResolvedConfig): Promise<EmbeddingProvider> {
  if (config.provider === 'api') {
    return new ApiEmbeddingProvider(config.apiBase, config.apiKey, config.apiModel)
  }
  return await LocalEmbeddingProvider.create(config.localModel, config.remoteHost)
}

/** Local ONNX embedding through @huggingface/transformers. */
class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number | undefined
  private readonly extractor: import('@huggingface/transformers').FeatureExtractionPipeline
  private constructor(
    extractor: import('@huggingface/transformers').FeatureExtractionPipeline,
    dimension: number | undefined,
  ) {
    this.extractor = extractor
    this.dimension = dimension
  }

  static async create(model: string, remoteHost: string): Promise<LocalEmbeddingProvider> {
    const { pipeline, env } = await import('@huggingface/transformers')
    // Point model downloads at a reachable hub (a mirror in restricted
    // networks); model files stay cached on the user's machine.
    env.remoteHost = remoteHost
    env.allowRemoteModels = true
    const extractor = await pipeline('feature-extraction', model, {
      dtype: 'q8',
      progress_callback: undefined,
    })
    let dimension: number | undefined
    try {
      const probe = await extractor('probe', { pooling: 'mean', normalize: true })
      dimension = typeof probe === 'object' && probe !== null && 'data' in probe
        ? (probe as { data: { length: number } }).data.length
        : undefined
    } catch {
      dimension = undefined
    }
    return new LocalEmbeddingProvider(extractor, dimension)
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>> {
    const output = await this.extractor([...texts], {
      pooling: 'mean',
      normalize: true,
    })
    if (output === null || typeof output !== 'object' || !('data' in output)) {
      throw new Error('semantic-memory: local embedding returned an unexpected shape')
    }
    const data = (output as { data: ArrayLike<number> }).data
    const stride = this.dimension ?? data.length / texts.length
    if (!Number.isInteger(stride) || stride <= 0) {
      throw new Error('semantic-memory: cannot infer local embedding dimension')
    }
    const vectors: number[][] = []
    for (let index = 0; index < texts.length; index += 1) {
      const start = index * stride
      const vector: number[] = []
      for (let offset = 0; offset < stride; offset += 1) {
        vector.push(Number(data[start + offset] ?? 0))
      }
      vectors.push(vector)
    }
    return vectors
  }

  async dispose(): Promise<void> {
    // transformers.js pipelines have no explicit dispose; GC handles it.
  }
}

/** OpenAI-compatible `POST {base}/embeddings` provider. */
class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number | undefined
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>> {
    const response = await fetch(`${this.base.replace(/\/+$/u, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: [...texts] }),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`semantic-memory: embeddings API ${response.status}: ${detail.slice(0, 300)}`)
    }
    const payload = await response.json() as {
      data?: Array<{ embedding?: number[] }>
      error?: { message?: string }
    }
    if (payload.error !== undefined) {
      throw new Error(`semantic-memory: embeddings API error: ${payload.error.message ?? 'unknown'}`)
    }
    const data = payload.data ?? []
    return data
      .slice(0, texts.length)
      .map(item => normalize(item.embedding ?? []))
  }

  async dispose(): Promise<void> {
    // Nothing to release.
  }
}

function normalize(vector: readonly number[]): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0 || !Number.isFinite(norm)) return vector.map(() => 0)
  return vector.map(value => value / norm)
}

function cacheKey(text: string): string {
  // A cheap identity for exact-repeat texts; the store already dedups content.
  return `${text.length}:${text}`
}
