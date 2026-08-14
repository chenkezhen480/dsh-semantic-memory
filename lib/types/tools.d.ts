/**
 * Model-facing tools for the semantic memory store.
 *
 * Registered through `ctx.tools.register(defineTool(...))`; each tool takes
 * the caller session's cwd as its workspace tag and scopes search to that
 * workspace unless the model opts into cross-workspace recall.
 *
 * @module dsh-plugin-semantic-memory/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { EmbeddingService } from './embedding.ts';
import type { MemoryStore } from './store.ts';
export interface MemoryToolServices {
    readonly store: MemoryStore;
    readonly embeddings: EmbeddingService;
}
export interface MemoryToolConfig {
    readonly maxSearchResults: number;
    readonly minScore: number;
}
export declare function registerMemoryTools(ctx: Context, services: MemoryToolServices, config: () => MemoryToolConfig): void;
