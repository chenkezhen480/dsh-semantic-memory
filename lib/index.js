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
import { Config, plainConfig, resolveConfig, SETTINGS_NAMESPACE } from "./config.js";
import { EmbeddingService } from "./embedding.js";
import { registerMemoryPrompt } from "./prompt.js";
import { RecallCache } from "./recall.js";
import { MemoryStore } from "./store.js";
import { createSummarizer } from "./summarize.js";
import { registerMemoryTools } from "./tools.js";
export const name = 'semantic-memory';
export { Config, SETTINGS_NAMESPACE, resolveConfig };
export { MemoryStore, contentHash, strengthOf } from "./store.js";
export { EmbeddingService } from "./embedding.js";
export { RecallCache, extractUserText } from "./recall.js";
export { AutoSummarizer, parseSummary, extractTranscript } from "./summarize.js";
/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt'];
export function apply(ctx, config) {
    // A single mutable resolved config drives every consumer; a settings commit
    // replaces it in place through `loader/volatile-update` below.
    let resolved = resolveConfig(plainConfig(config));
    let summarizer;
    const applyResolved = (next) => {
        resolved = next;
        embeddings.setConfig(next);
        store.halfLifeMs = next.halfLifeMs;
        if (summarizer !== undefined) {
            summarizer.setConfig({
                every: next.autoSummarizeEvery,
                window: next.summarizeWindow,
                maxTokens: next.summarizeMaxTokens,
                temperature: next.summarizeTemperature,
            });
        }
        ensureSummarizer();
    };
    const store = new MemoryStore(resolved.memoryPath, resolved.halfLifeMs);
    const embeddings = new EmbeddingService(resolved);
    const recall = new RecallCache(store, embeddings, {
        topK: () => resolved.promptTopK,
        minScore: () => resolved.minScore,
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
    registerMemoryTools(ctx, { store, embeddings }, () => ({
        maxSearchResults: resolved.maxSearchResults,
        minScore: resolved.minScore,
    }));
    if (resolved.promptTopK > 0) {
        recall.attach(ctx);
        registerMemoryPrompt(ctx, store, recall, { topK: () => resolved.promptTopK });
    }
    // Auto-summarization is best-effort: it activates only when the deployment
    // provides the llm and agentDefaultModel services. Lazy creation lets a
    // settings reload flip it on (or re-tune it) without duplicate listeners.
    const llm = ctx.get('llm');
    const defaultModel = ctx.get('agentDefaultModel');
    function ensureSummarizer() {
        if (summarizer !== undefined)
            return;
        if (resolved.autoSummarizeEvery < 1) {
            ctx.logger.info('semantic-memory: auto-summarize disabled (autoSummarizeEvery=%d)', resolved.autoSummarizeEvery);
            return;
        }
        if (llm === undefined || defaultModel === undefined) {
            ctx.logger.warn('semantic-memory: auto-summarize unavailable — llm=%s agentDefaultModel=%s', llm === undefined ? 'missing' : 'ok', defaultModel === undefined ? 'missing' : 'ok');
            return;
        }
        const created = createSummarizer({ store, embeddings, llm, defaultModel }, resolved);
        if (created === undefined)
            return;
        summarizer = created;
        created.attach(ctx);
        ctx.logger.info('semantic-memory: auto-summarize enabled (every %d user messages)', resolved.autoSummarizeEvery);
    }
    ensureSummarizer();
    // Settings integration (current Loader contract). This entry's Config IS the
    // registration: the Settings service projects its volatile fields into a form
    // keyed by the entry id, and a form write persists into the profile patch. The
    // Loader then commits the new values into the running volatile references and
    // emits `loader/volatile-update` on this fiber; re-resolve here so the
    // embedding provider, the decay policy, and the summarizer adopt them without
    // a restart. Without the Loader the event never fires and the composition
    // config alone keeps applying.
    ctx.on('loader/volatile-update', () => {
        try {
            applyResolved(resolveConfig(plainConfig(config)));
            ctx.logger.info('semantic-memory: settings reloaded (provider=%s)', resolved.provider);
        }
        catch (error) {
            // An invalid candidate must not tear down the working configuration.
            ctx.logger.warn(`semantic-memory: settings update rejected: ${String(error)}`);
        }
    });
    ctx.effect(() => () => {
        void embeddings.dispose();
    }, 'semantic-memory embedding disposal');
}
