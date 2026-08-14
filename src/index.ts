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
 * Configuration flows through the harness settings service when available:
 * the `semantic-memory` namespace layers schema defaults, the composition
 * (cordis patch) base, and the user document (`$DSH_HOME/settings.yaml`,
 * editable from the web settings card). Provider selection is automatic:
 * a non-empty `apiKey` uses the API, otherwise the local model. Settings
 * changes hot-reload without a restart.
 *
 * @module dsh-plugin-semantic-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, SETTINGS_NAMESPACE, type Config as ConfigValue, type ResolvedConfig } from './config.ts'
import { EmbeddingService } from './embedding.ts'
import { registerMemoryPrompt } from './prompt.ts'
import { RecallCache } from './recall.ts'
import { MemoryStore } from './store.ts'
import { createSummarizer, type DefaultModelLike, type LlmLike } from './summarize.ts'
import { registerMemoryTools } from './tools.ts'

export const name = 'semantic-memory'

export { Config, SETTINGS_NAMESPACE, resolveConfig }
export { MemoryStore, contentHash, strengthOf, type MemoryEntry, type SearchHit } from './store.ts'
export { EmbeddingService } from './embedding.ts'
export { RecallCache, extractUserText, type RecallState } from './recall.ts'
export { AutoSummarizer, parseSummary, extractTranscript, type SummarizeConfig } from './summarize.ts'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt']

/** Structural settings surface (avoids a hard dsh-settings peer dependency). */
interface SettingsLike {
  register(
    ns: string,
    schema: unknown,
    options?: { base?: unknown },
  ): {
    get(): unknown
    watch(listener: (next: unknown, prev: unknown) => void): () => void
  }
}

export function apply(ctx: Context, config: ConfigValue): void {
  // A single mutable resolved config drives every consumer; settings hot
  // reloads replace it in place.
  let resolved = resolveConfig(config)
  let summarizer: ReturnType<typeof createSummarizer> | undefined
  const applyResolved = (next: ResolvedConfig): void => {
    resolved = next
    embeddings.setConfig(next)
    store.halfLifeMs = next.halfLifeMs
    if (summarizer !== undefined) {
      summarizer.setConfig({
        every: next.autoSummarizeEvery,
        window: next.summarizeWindow,
        maxTokens: next.summarizeMaxTokens,
        temperature: next.summarizeTemperature,
      })
    }
    ensureSummarizer()
  }

  const store = new MemoryStore(resolved.memoryPath, resolved.halfLifeMs)
  const embeddings = new EmbeddingService(resolved)
  const recall = new RecallCache(store, embeddings, {
    topK: () => resolved.promptTopK,
    minScore: () => resolved.minScore,
    staleMs: 60 * 1000,
  })

  ctx.effect(function* () {
    yield async () => {
      try {
        await store.ensureLoaded()
      } catch (error) {
        ctx.logger.warn(`semantic-memory: failed to load store: ${String(error)}`)
      }
    }
  }, 'semantic-memory store load')

  registerMemoryTools(ctx, { store, embeddings }, () => ({
    maxSearchResults: resolved.maxSearchResults,
    minScore: resolved.minScore,
  }))

  if (resolved.promptTopK > 0) {
    recall.attach(ctx)
    registerMemoryPrompt(ctx, store, recall, { topK: () => resolved.promptTopK })
  }

  // Auto-summarization is best-effort: it activates only when the deployment
  // provides the llm and agentDefaultModel services. Lazy creation lets a
  // settings reload flip it on (or re-tune it) without duplicate listeners.
  const llm = ctx.get('llm') as unknown as LlmLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as unknown as DefaultModelLike | undefined
  function ensureSummarizer(): void {
    if (summarizer !== undefined || resolved.autoSummarizeEvery < 1
      || llm === undefined || defaultModel === undefined) return
    const created = createSummarizer({ store, embeddings, llm, defaultModel }, resolved)
    if (created === undefined) return
    summarizer = created
    created.attach(ctx)
    ctx.logger.info('semantic-memory: auto-summarize enabled (every %d user messages)', resolved.autoSummarizeEvery)
  }
  ensureSummarizer()

  // Settings integration: layer the user document over the composition base
  // and hot-reload on every commit. Without a settings provider the plugin
  // keeps resolving the composition config alone.
  const settings = ctx.get('settings') as unknown as SettingsLike | undefined
  if (settings !== undefined) {
    const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config })
    const stored = scope.get()
    if (stored !== undefined) {
      try {
        applyResolved(resolveConfig(stored as ConfigValue))
      } catch (error) {
        ctx.logger.warn(`semantic-memory: stored settings rejected: ${String(error)}`)
      }
    }
    ctx.effect(() => scope.watch((next) => {
      try {
        applyResolved(resolveConfig(next as ConfigValue))
        ctx.logger.info('semantic-memory: settings reloaded (provider=%s)', resolved.provider)
      } catch (error) {
        ctx.logger.warn(`semantic-memory: settings update rejected: ${String(error)}`)
      }
    }), 'semantic-memory settings watcher')
  }

  ctx.effect(() => () => {
    void embeddings.dispose()
  }, 'semantic-memory embedding disposal')
}
