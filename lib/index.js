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
import { Config, resolveConfig } from "./config.js";
import { EmbeddingService } from "./embedding.js";
import { registerMemoryPrompt } from "./prompt.js";
import { RecallCache } from "./recall.js";
import { MemoryStore } from "./store.js";
import { createSummarizer } from "./summarize.js";
import { registerMemoryTools } from "./tools.js";
export const name = 'semantic-memory';
export { Config };
export { MemoryStore, contentHash, strengthOf } from "./store.js";
export { EmbeddingService } from "./embedding.js";
export { RecallCache, extractUserText } from "./recall.js";
export { AutoSummarizer, parseSummary, extractTranscript } from "./summarize.js";
/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const store = new MemoryStore(resolved.memoryPath, resolved.halfLifeMs);
    const embeddings = new EmbeddingService(resolved);
    const recall = new RecallCache(store, embeddings, {
        topK: resolved.promptTopK,
        minScore: resolved.minScore,
        staleMs: 60 * 1000,
    });
    ctx.effect(function* () {
        yield async () => {
            try {
                await store.ensureLoaded();
            }
            catch (error) {
                ctx.logger.warn(`semantic-memory: failed to load store: ${String(error)}`);
            }
        };
    }, 'semantic-memory store load');
    registerMemoryTools(ctx, { store, embeddings }, {
        maxSearchResults: resolved.maxSearchResults,
        minScore: resolved.minScore,
    });
    if (resolved.promptTopK > 0) {
        recall.attach(ctx);
        registerMemoryPrompt(ctx, store, recall, { topK: resolved.promptTopK });
    }
    // Auto-summarization is best-effort: it activates only when the deployment
    // provides the llm and agentDefaultModel services.
    const llm = ctx.get('llm');
    const defaultModel = ctx.get('agentDefaultModel');
    const summarizer = createSummarizer({ store, embeddings, llm, defaultModel }, resolved);
    if (summarizer !== undefined) {
        summarizer.attach(ctx);
        ctx.logger.info('semantic-memory: auto-summarize enabled (every %d user messages)', resolved.autoSummarizeEvery);
    }
    ctx.effect(() => () => {
        void embeddings.dispose();
    }, 'semantic-memory embedding disposal');
}
