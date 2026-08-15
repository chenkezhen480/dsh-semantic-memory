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
   - `cordis.patch.yml` — new entries must be **inserted** (a bare `- id:` row
     only overrides an existing bundle id and is silently ignored):
     ```yaml
     - insert:
         - id: semantic-memory
           name: 'dsh-plugin-semantic-memory'
           config:
             remoteHost: https://hf-mirror.com
             promptTopK: 3
             autoSummarizeEvery: 5
     ```
   - Leave `provider` unset: selection is automatic (see below).
3. `pnpm install` in the profile directory, then restart `dsh web`.

## Usage

### Provider selection (automatic)

The embedding provider is chosen from the configuration object alone — no
explicit switch needed:

| Configuration | Provider |
|---|---|
| `apiKey` present (non-empty) | **API** (OpenAI-compatible `/embeddings` endpoint) |
| no `apiKey` | **local** (ONNX via `@huggingface/transformers`, offline) |
| `provider: 'local'` (explicit) | local, even with an `apiKey` set |
| `provider: 'api'` (explicit) | API; requires `apiKey` |

Switching is just filling or clearing `apiKey` — a restart is only needed for
the patch file; the settings document (`~/.dsh/settings.yaml`, `semantic-memory:`
section) hot-reloads without one. The first local embed downloads the model
(~100 MB, cached in `~/.cache/huggingface`; use `remoteHost` for a mirror).

### Verify the plugin is live

Open a **new session** (existing sessions keep their original tool set) and ask
the model: *"Do you have memory_* tools?"* — it should list `memory_write`,
`memory_search`, `memory_forget`, and `memory_stats`. The system prompt also
carries a `## Long-term memory` section once memories exist.

### What the model can do

- **Persist on its own** — state a durable preference, fact, or decision; the
  injected guidance makes the model call `memory_write` without being asked.
- **Ask it to remember** — *"记住：我在用硅基流动的 API"* → `memory_write`.
- **Recall** — *"我之前对回答风格有什么偏好？"* → the per-turn semantic recall
  surfaces relevant memories automatically; `memory_search` digs deeper
  (supports `kind`, `tags`, `workspace`, `limit`, `min_score`).
- **Manage** — `memory_forget <id>` deletes; `memory_stats` summarizes the store.

### Automatic behaviors

| Trigger | Behavior |
|---|---|
| Every user message | Asynchronous embedding + search; the freshest per-session hits are injected into the next prompt assembly (`## Long-term memory (recalled for your current question)`) |
| Every N user messages (default 5) | The harness LLM distills **only the messages since the last summary** (per-session seq cursor — no re-digesting, nothing skipped) into memory entries, written with the `auto` tag; the cadence can be set with the `DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY` environment variable (`0` disables, overrides the config document) |
| Prompt assembly, no fresh recall | Strongest memories (importance × recency × access) injected as fallback |

### Where the data lives

- Store: `$DSH_HOME/memories/memories.jsonl` (one JSON line per entry, vectors
  included; edit/backup freely).
- Settings: `~/.dsh/settings.yaml` under `semantic-memory:` (hot-reloaded).

### Troubleshooting

- **No memory_* tools in a session** — the session predates the plugin; start a
  new one.
- **First local embed is slow / fails** — the model downloads on first use; set
  `remoteHost: https://hf-mirror.com` in restricted networks.
- **`api` provider errors** — confirm `apiKey` is set and `apiBase` points at an
  OpenAI-compatible endpoint (a `/v1` base gets `/embeddings` appended).
- **Auto-summary never fires** — it needs the `llm` and `agentDefaultModel`
  services (present in the standard web profile) and `autoSummarizeEvery > 0`.

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
| `autoSummarizeEvery` | `5` | Auto-summarize every N user messages (0 disables; needs llm + agentDefaultModel). The `DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY` env var overrides this (0..100). |
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
