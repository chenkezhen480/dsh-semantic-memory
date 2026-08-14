/**
 * End-to-end verification: real local embedding + store write/search.
 *
 * Usage: node scripts/verify-embedding.mjs [--provider api]
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbeddingService } from '../lib/embedding.js'
import { MemoryStore } from '../lib/store.js'

const provider = process.argv.includes('--provider-api') ? 'api' : 'local'

const config = {
  provider,
  localModel: process.env.MEMORY_LOCAL_MODEL ?? 'Xenova/bge-small-zh-v1.5',
  remoteHost: process.env.MEMORY_REMOTE_HOST ?? 'https://hf-mirror.com',
  apiBase: process.env.MEMORY_API_BASE ?? 'https://api.siliconflow.cn/v1',
  apiKey: process.env.MEMORY_API_KEY ?? '',
  apiModel: process.env.MEMORY_API_MODEL ?? 'BAAI/bge-m3',
  memoryPath: join(await mkdtemp(join(tmpdir(), 'smem-verify-')), 'memories.jsonl'),
  promptTopK: 3,
  maxSearchResults: 10,
  minScore: 0.3,
  halfLifeMs: 86400000,
}

const embeddings = new EmbeddingService(config)
const store = new MemoryStore(config.memoryPath, config.halfLifeMs)

try {
  const started = Date.now()
  const samples = [
    { kind: 'preference', content: '用户喜欢用中文交流，回答要简洁' },
    { kind: 'fact', content: 'DeepSeek Harness 的一切都是插件，由 Cordis 驱动' },
    { kind: 'decision', content: '记忆插件采用本地 BGE 模型做 embedding' },
    { kind: 'note', content: '明天的会议在下午三点，会议室 A302' },
  ]
  const vectors = await embeddings.embed(samples.map(s => s.content))
  for (let i = 0; i < samples.length; i += 1) {
    const vector = vectors[i]
    if (vector === undefined || vector.length === 0) {
      throw new Error(`no embedding for sample ${i}`)
    }
    await store.put({ ...samples[i], embedding: vector, importance: 4 })
  }
  console.log(`embedded ${samples.length} memories in ${Date.now() - started}ms (dim=${vectors[0]?.length})`)

  const queries = ['开会时间', '用户习惯', '插件架构']
  for (const query of queries) {
    const [qv] = await embeddings.embed([query])
    const hits = await store.search(qv ?? [], { limit: 2 })
    console.log(`\nquery: ${query}`)
    for (const { entry, score } of hits) {
      console.log(`  [${entry.kind}] ${entry.content}  (score=${score.toFixed(3)})`)
    }
  }

  const stats = await store.stats()
  console.log(`\nstore: ${stats.total} entries at ${config.memoryPath}`)
} finally {
  await embeddings.dispose()
  await rm(join(config.memoryPath, '..'), { recursive: true, force: true })
}
