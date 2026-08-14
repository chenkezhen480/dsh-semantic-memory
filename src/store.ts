/**
 * Persistent semantic memory store backed by an append-safe JSONL file.
 *
 * The store keeps every entry in memory after loading and persists the whole
 * set atomically (temp file + rename) on mutation. Entries are identified by
 * a content hash so repeated writes of the same fact upsert instead of
 * duplicating. Vector similarity lives in {@link ./similarity.ts}; the store
 * itself only owns entry lifecycle, filtering, and scoring metadata.
 *
 * @module dsh-plugin-semantic-memory/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemoryKind } from './config.ts'

/** One persistent memory entry. */
export interface MemoryEntry {
  /** Content hash id (sha1 of kind + content, first 16 hex chars). */
  readonly id: string
  readonly kind: MemoryKind
  /** One-sentence semantic text. */
  readonly content: string
  readonly tags: readonly string[]
  /** Workspace the memory was written from (caller session cwd), if any. */
  readonly workspace?: string
  /** Optional provenance: session id and event seq that produced the memory. */
  readonly source?: { readonly sessionId: string; readonly seq: number }
  /** Importance 1..5 supplied at write time; drives the base strength. */
  readonly importance: number
  /** Normalized embedding vector. */
  readonly embedding: readonly number[]
  readonly createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessAt: number
}

/** Filter options for listing and searching. */
export interface MemoryFilter {
  readonly kinds?: readonly MemoryKind[]
  readonly tags?: readonly string[]
  readonly workspace?: string
  readonly includeOtherWorkspaces?: boolean
}

export interface SearchOptions extends MemoryFilter {
  readonly limit?: number
  readonly minScore?: number
}

export interface SearchHit {
  readonly entry: MemoryEntry
  readonly score: number
}

/** Decay-aware strength: base importance scaled by half-life since last access. */
export function strengthOf(entry: MemoryEntry, now: number, halfLifeMs: number): number {
  const base = entry.importance / 5
  const age = Math.max(0, now - entry.lastAccessAt)
  return base * Math.pow(0.5, age / halfLifeMs)
}

export function contentHash(kind: MemoryKind, content: string): string {
  return createHash('sha1').update(`${kind}\u0000${content}`).digest('hex').slice(0, 16)
}

/** In-memory store with atomic JSONL persistence. */
export class MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()
  private tempCounter = 0
  /** Decay half-life; mutable so settings hot-reloads can move it. */
  halfLifeMs: number

  constructor(
    private readonly path: string,
    halfLifeMs: number,
  ) {
    this.halfLifeMs = halfLifeMs
  }

  get size(): number {
    return this.entries.size
  }

  /** Load the store once; later calls are no-ops. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isAbsent(error)) return
      throw error
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const entry = parseEntryLine(trimmed)
      if (entry === undefined) continue
      this.entries.set(entry.id, entry)
    }
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  all(): MemoryEntry[] {
    return [...this.entries.values()]
  }

  /** Insert or update by content identity; persists atomically. */
  async put(input: {
    readonly kind: MemoryKind
    readonly content: string
    readonly tags?: readonly string[]
    readonly workspace?: string
    readonly source?: MemoryEntry['source']
    readonly importance?: number
    readonly embedding: readonly number[]
  }): Promise<{ entry: MemoryEntry; created: boolean }> {
    await this.ensureLoaded()
    const id = contentHash(input.kind, input.content)
    const now = Date.now()
    const previous = this.entries.get(id)
    const entry: MemoryEntry = previous === undefined
      ? {
          id,
          kind: input.kind,
          content: input.content,
          tags: input.tags ?? [],
          workspace: input.workspace,
          source: input.source,
          importance: clampImportance(input.importance),
          embedding: input.embedding,
          createdAt: now,
          updatedAt: now,
          accessCount: 0,
          lastAccessAt: now,
        }
      : {
          ...previous,
          kind: input.kind,
          content: input.content,
          tags: input.tags ?? previous.tags,
          workspace: input.workspace ?? previous.workspace,
          source: input.source ?? previous.source,
          importance: clampImportance(input.importance ?? previous.importance),
          embedding: input.embedding,
          updatedAt: now,
        }
    this.entries.set(id, entry)
    await this.persist()
    return { entry, created: previous === undefined }
  }

  /** Record one access (strengthening) for an entry. */
  async touch(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    const now = Date.now()
    this.entries.set(id, {
      ...entry,
      accessCount: entry.accessCount + 1,
      lastAccessAt: now,
    })
    await this.persist()
    return true
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id)
    if (existed) await this.persist()
    return existed
  }

  /**
   * Cosine search over normalized embeddings, filtered by kinds/tags/workspace.
   * Hits are ranked by similarity × decayed strength and capped by `limit`.
   */
  async search(query: readonly number[], options: SearchOptions = {}): Promise<SearchHit[]> {
    await this.ensureLoaded()
    const now = Date.now()
    const minScore = options.minScore ?? 0
    const hits: SearchHit[] = []
    for (const entry of this.entries.values()) {
      if (!passesFilter(entry, options)) continue
      const similarity = cosine(query, entry.embedding)
      if (Number.isNaN(similarity) || similarity <= 0 || similarity < minScore) continue
      const score = similarity * strengthOf(entry, now, this.halfLifeMs)
      hits.push({ entry, score })
    }
    hits.sort((a, b) => b.score - a.score)
    const limit = options.limit ?? hits.length
    return hits.slice(0, limit)
  }

  /** Prompt-injection candidates: strongest decayed strength, recency tiebreak. */
  async promptCandidates(limit: number, filter: MemoryFilter = {}): Promise<MemoryEntry[]> {
    await this.ensureLoaded()
    return this.promptCandidatesSync(limit, filter)
  }

  /**
   * Synchronous rank used by the system-prompt section provider (which cannot
   * await). Only meaningful after `ensureLoaded()` has settled once.
   */
  promptCandidatesSync(limit: number, filter: MemoryFilter = {}): MemoryEntry[] {
    const now = Date.now()
    const candidates = [...this.entries.values()]
      .filter(entry => passesFilter(entry, filter))
      .sort((a, b) => {
        const sa = strengthOf(a, now, this.halfLifeMs)
        const sb = strengthOf(b, now, this.halfLifeMs)
        if (sa !== sb) return sb - sa
        return b.updatedAt - a.updatedAt
      })
    return candidates.slice(0, limit)
  }

  async stats(): Promise<{
    readonly total: number
    readonly byKind: Readonly<Record<string, number>>
    readonly byWorkspace: Readonly<Record<string, number>>
    readonly latest: MemoryEntry | undefined
  }> {
    await this.ensureLoaded()
    const byKind: Record<string, number> = {}
    const byWorkspace: Record<string, number> = {}
    let latest: MemoryEntry | undefined
    for (const entry of this.entries.values()) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      const ws = entry.workspace ?? '(none)'
      byWorkspace[ws] = (byWorkspace[ws] ?? 0) + 1
      if (latest === undefined || entry.createdAt > latest.createdAt) latest = entry
    }
    return { total: this.entries.size, byKind, byWorkspace, latest }
  }

  private async persist(): Promise<void> {
    // Serialize writes: concurrent mutations must not interleave temp-file
    // rename, and each batch must land in call order.
    const run = async (): Promise<void> => {
      const lines = [...this.entries.values()]
        .map(entry => JSON.stringify(entry))
        .join('\n')
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp-${process.pid}-${Date.now()}-${this.tempCounter++}`
      await writeFile(temp, `${lines}${lines.length > 0 ? '\n' : ''}`, 'utf8')
      try {
        await rename(temp, this.path)
      } catch (error) {
        await unlinkQuiet(temp)
        throw error
      }
    }
    this.persistChain = this.persistChain.then(run, run)
    return await this.persistChain
  }
}

function passesFilter(entry: MemoryEntry, filter: MemoryFilter): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(entry.kind)) return false
  if (filter.tags !== undefined && !filter.tags.every(tag => entry.tags.includes(tag))) return false
  if (filter.workspace !== undefined && entry.workspace !== filter.workspace && filter.includeOtherWorkspaces !== true) {
    return false
  }
  return true
}

/** Cosine similarity over normalized vectors (dot product). */
function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return Number.NaN
  let dot = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return dot
}

function clampImportance(value: number | undefined): number {
  if (value === undefined) return 3
  if (!Number.isFinite(value)) return 3
  return Math.min(5, Math.max(1, Math.round(value)))
}

function parseEntryLine(line: string): MemoryEntry | undefined {
  try {
    const value = JSON.parse(line) as Partial<MemoryEntry>
    if (typeof value.id !== 'string' || typeof value.kind !== 'string' || typeof value.content !== 'string') {
      return undefined
    }
    if (!Array.isArray(value.embedding)) return undefined
    const kind = value.kind as MemoryKind
    if (!['fact', 'decision', 'preference', 'note'].includes(kind)) return undefined
    return {
      id: value.id,
      kind,
      content: value.content,
      tags: Array.isArray(value.tags) ? value.tags : [],
      workspace: typeof value.workspace === 'string' ? value.workspace : undefined,
      source: isSource(value.source) ? value.source : undefined,
      importance: typeof value.importance === 'number' ? clampImportance(value.importance) : 3,
      embedding: value.embedding.map(Number),
      createdAt: numberOr(value.createdAt, 0),
      updatedAt: numberOr(value.updatedAt, 0),
      accessCount: numberOr(value.accessCount, 0),
      lastAccessAt: numberOr(value.lastAccessAt, numberOr(value.createdAt, 0)),
    }
  } catch {
    return undefined
  }
}

function isSource(value: unknown): value is MemoryEntry['source'] {
  return typeof value === 'object' && value !== null
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && typeof (value as { seq?: unknown }).seq === 'number'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await import('node:fs/promises').then(({ unlink }) => unlink(path))
  } catch {
    // Best-effort cleanup of the temp file.
  }
}
