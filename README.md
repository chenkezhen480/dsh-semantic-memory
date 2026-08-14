# dsh-plugin-semantic-memory

Semantic long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A `dsh-plugin` (Cordis plugin) that gives the model a persistent, embedding-based
memory across sessions — unlike the harness's built-in `session_query` (literal
FTS5), this store retrieves by *meaning*.

## Features

- **Cross-session semantic memory** — facts, decisions, preferences, and notes
  persisted as JSONL under `$DSH_HOME/memories/memories.jsonl`.
- **Embedding retrieval** — cosine similarity over normalized vectors; provider
  is pluggable:
  - `local` (default): ONNX inference via `@huggingface/transformers` with
    `Xenova/bge-small-zh-v1.5` (offline, ~100 MB model, cached in
    `~/.cache/huggingface`).
  - `api`: any OpenAI-compatible `/embeddings` endpoint (e.g. SiliconFlow,
    Zhipu, DashScope).
- **Memory decay & strengthening** — each entry's effective strength halves
  over the configured half-life since its last access; searching an entry
  refreshes it. Importance (1–5) sets the base strength.
- **Model-facing tools**:
  - `memory_write` — persist a fact / decision / preference / note (content
    hash dedup, repeats update in place).
  - `memory_search` — semantic top-k recall with kind/tag/workspace filters.
  - `memory_forget` — delete by id.
  - `memory_stats` — store summary.
- **Automatic injection** — the plugin watches the session event stream: every
  new user message is embedded and searched asynchronously, and the freshest
  per-session recall is rendered into the system prompt **before the turn's
  prompt assembly** (question-aware). With no fresh recall yet, the strongest
  resident memories are injected as a fixed-size fallback.
- **Proactive writing guidance** — the injected prompt tells the model to call
  `memory_write` on its own when the user states a durable preference, an
  established fact, or an explicit decision (no need to say "remember").
- **Auto-summarization** — every N user messages (default 5), the plugin asks
  the harness LLM to distill the recent transcript into memory entries and
  writes them (tagged `auto`). One in-flight summary per session; silent on
  failure; only active when `llm` and `agentDefaultModel` services exist.
- **Workspace tagging** — entries record the caller session's cwd; search
  scopes to that workspace by default and can opt into cross-workspace recall.

## Install into a DSH profile

1. Build this package (`npm install && npm run build`).
2. Add it to your profile (e.g. `~/.dsh/profiles/web`):
   - `package.json` `dependencies`: `"dsh-plugin-semantic-memory": "file:C:/projects/dsh-embedding"`
   - `cordis.patch.yml`:
     ```yaml
     - id: semantic-memory
       name: 'dsh-plugin-semantic-memory'
       config:
         provider: local
         remoteHost: https://hf-mirror.com
         promptTopK: 3
         autoSummarizeEvery: 5
     ```
3. `pnpm install` in the profile directory, then restart `dsh web`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `auto` | `auto` selects by apiKey (non-empty → `api`, else `local`); explicit `local`/`api` overrides. |
| `localModel` | `Xenova/bge-small-zh-v1.5` | Local transformer model id. |
| `remoteHost` | `https://huggingface.co` | Model download host; set `https://hf-mirror.com` in restricted networks. |
| `apiBase` | `https://api.siliconflow.cn/v1` | API base URL (an `/embeddings` route is appended). |
| `apiKey` | `''` | API key. When non-empty and provider is not explicitly `local`, the API provider is used. |
| `apiModel` | `BAAI/bge-m3` | API embedding model name. |
| `memoryPath` | `$DSH_HOME/memories/memories.jsonl` | Store file path. |
| `promptTopK` | `3` | Memories injected per system-prompt assembly (0 disables). |
| `maxSearchResults` | `10` | Default `memory_search` hit cap. |
| `minScore` | `0.35` | Default minimum relevance for search hits. |
| `halfLifeMs` | 30 days | Memory strength half-life. |
| `autoSummarizeEvery` | `5` | Auto-summarize every N user messages (0 disables; needs llm + agentDefaultModel). |
| `summarizeWindow` | `12` | Most recent messages included in one auto-summary. |
| `summarizeMaxTokens` | `400` | Token budget for the summary call. |
| `summarizeTemperature` | `0.2` | Sampling temperature for the summary call. |

## Memory model

```ts
interface MemoryEntry {
  id: string            // sha1(kind + content), 16 hex chars — upsert key
  kind: 'fact' | 'decision' | 'preference' | 'note'
  content: string       // one-sentence, self-contained text
  tags: string[]
  workspace?: string    // caller session cwd at write time
  source?: { sessionId: string; seq: number }
  importance: number    // 1..5
  embedding: number[]   // normalized vector
  createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessAt: number
}
```

Effective strength = `importance / 5 × 0.5^(age / halfLife)`;
search rank = `cosine(query, entry) × strength`.

## Known Limitations

- **Recall is best-effort and async** — the user-message listener embeds in the
  background; on a cold start (model still downloading) or with a slow API the
  first recall may arrive one step late, and the strength-ranked fallback
  covers that turn. Recall caches are per-session and stale after 60 s.
- **Sync prompt injection** — the injected section renders from resident data
  only; the store is loaded lazily on first tool call, so a brand-new process
  may start with an empty injection for the first assembly.
- **No embedding persistence cache** — vectors are stored inside each entry,
  so no separate index file is needed, but full re-embedding never happens
  either (entries keep their vectors forever).
- **Brute-force search** — O(n) cosine over all entries per query; fine for
  personal-scale stores (thousands), not for millions of entries.
