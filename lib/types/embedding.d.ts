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
import type { ResolvedConfig } from './config.ts';
export interface EmbeddingProvider {
    readonly dimension: number | undefined;
    embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>>;
    dispose(): Promise<void>;
}
/** Lazy wrapper that picks the configured provider and single-flights startup. */
export declare class EmbeddingService {
    private readonly config;
    private provider;
    private starting;
    private readonly cache;
    private disposed;
    constructor(config: ResolvedConfig);
    embed(texts: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<readonly number[]>>;
    get dimension(): number | undefined;
    dispose(): Promise<void>;
    private providerOrStart;
}
