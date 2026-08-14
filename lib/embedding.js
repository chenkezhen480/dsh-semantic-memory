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
/** Lazy wrapper that picks the configured provider and single-flights startup. */
export class EmbeddingService {
    config;
    provider;
    starting;
    cache = new Map();
    disposed = false;
    constructor(config) {
        this.config = config;
    }
    async embed(texts, signal) {
        const provider = await this.providerOrStart(signal);
        const uncached = [];
        const positions = [];
        const results = [];
        for (const text of texts) {
            const key = cacheKey(text);
            const hit = this.cache.get(key);
            results.push(hit);
            if (hit === undefined) {
                positions.push(results.length - 1);
                uncached.push(text);
            }
        }
        if (uncached.length > 0) {
            const vectors = await provider.embed(uncached, signal);
            if (vectors.length !== uncached.length) {
                throw new Error('semantic-memory: embedding provider returned an unexpected vector count');
            }
            for (let index = 0; index < uncached.length; index += 1) {
                const vector = vectors[index];
                if (vector === undefined)
                    continue;
                const normalized = normalize(vector);
                this.cache.set(cacheKey(uncached[index] ?? ''), normalized);
                results[positions[index] ?? 0] = normalized;
            }
        }
        return results.map(vector => vector === undefined ? [] : vector);
    }
    get dimension() {
        return this.provider?.dimension;
    }
    async dispose() {
        this.disposed = true;
        const provider = this.provider;
        this.provider = undefined;
        if (provider !== undefined)
            await provider.dispose();
    }
    async providerOrStart(signal) {
        if (this.disposed)
            throw new Error('semantic-memory: embedding service is disposed');
        if (this.provider !== undefined)
            return this.provider;
        this.starting ??= createProvider(this.config).then(provider => {
            this.provider = provider;
            return provider;
        });
        return await this.starting;
    }
}
async function createProvider(config) {
    if (config.provider === 'api') {
        return new ApiEmbeddingProvider(config.apiBase, config.apiKey, config.apiModel);
    }
    return await LocalEmbeddingProvider.create(config.localModel, config.remoteHost);
}
/** Local ONNX embedding through @huggingface/transformers. */
class LocalEmbeddingProvider {
    dimension;
    extractor;
    constructor(extractor, dimension) {
        this.extractor = extractor;
        this.dimension = dimension;
    }
    static async create(model, remoteHost) {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Point model downloads at a reachable hub (a mirror in restricted
        // networks); model files stay cached on the user's machine.
        env.remoteHost = remoteHost;
        env.allowRemoteModels = true;
        const extractor = await pipeline('feature-extraction', model, {
            dtype: 'q8',
            progress_callback: undefined,
        });
        let dimension;
        try {
            const probe = await extractor('probe', { pooling: 'mean', normalize: true });
            dimension = typeof probe === 'object' && probe !== null && 'data' in probe
                ? probe.data.length
                : undefined;
        }
        catch {
            dimension = undefined;
        }
        return new LocalEmbeddingProvider(extractor, dimension);
    }
    async embed(texts, signal) {
        const output = await this.extractor([...texts], {
            pooling: 'mean',
            normalize: true,
        });
        if (output === null || typeof output !== 'object' || !('data' in output)) {
            throw new Error('semantic-memory: local embedding returned an unexpected shape');
        }
        const data = output.data;
        const stride = this.dimension ?? data.length / texts.length;
        if (!Number.isInteger(stride) || stride <= 0) {
            throw new Error('semantic-memory: cannot infer local embedding dimension');
        }
        const vectors = [];
        for (let index = 0; index < texts.length; index += 1) {
            const start = index * stride;
            const vector = [];
            for (let offset = 0; offset < stride; offset += 1) {
                vector.push(Number(data[start + offset] ?? 0));
            }
            vectors.push(vector);
        }
        return vectors;
    }
    async dispose() {
        // transformers.js pipelines have no explicit dispose; GC handles it.
    }
}
/** OpenAI-compatible `POST {base}/embeddings` provider. */
class ApiEmbeddingProvider {
    base;
    apiKey;
    model;
    dimension;
    constructor(base, apiKey, model) {
        this.base = base;
        this.apiKey = apiKey;
        this.model = model;
    }
    async embed(texts, signal) {
        const response = await fetch(`${this.base.replace(/\/+$/u, '')}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: [...texts] }),
            signal,
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`semantic-memory: embeddings API ${response.status}: ${detail.slice(0, 300)}`);
        }
        const payload = await response.json();
        if (payload.error !== undefined) {
            throw new Error(`semantic-memory: embeddings API error: ${payload.error.message ?? 'unknown'}`);
        }
        const data = payload.data ?? [];
        return data
            .slice(0, texts.length)
            .map(item => normalize(item.embedding ?? []));
    }
    async dispose() {
        // Nothing to release.
    }
}
function normalize(vector) {
    let norm = 0;
    for (const value of vector)
        norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0 || !Number.isFinite(norm))
        return vector.map(() => 0);
    return vector.map(value => value / norm);
}
function cacheKey(text) {
    // A cheap identity for exact-repeat texts; the store already dedups content.
    return `${text.length}:${text}`;
}
