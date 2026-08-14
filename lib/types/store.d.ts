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
import type { MemoryKind } from './config.ts';
/** One persistent memory entry. */
export interface MemoryEntry {
    /** Content hash id (sha1 of kind + content, first 16 hex chars). */
    readonly id: string;
    readonly kind: MemoryKind;
    /** One-sentence semantic text. */
    readonly content: string;
    readonly tags: readonly string[];
    /** Workspace the memory was written from (caller session cwd), if any. */
    readonly workspace?: string;
    /** Optional provenance: session id and event seq that produced the memory. */
    readonly source?: {
        readonly sessionId: string;
        readonly seq: number;
    };
    /** Importance 1..5 supplied at write time; drives the base strength. */
    readonly importance: number;
    /** Normalized embedding vector. */
    readonly embedding: readonly number[];
    readonly createdAt: number;
    updatedAt: number;
    accessCount: number;
    lastAccessAt: number;
}
/** Filter options for listing and searching. */
export interface MemoryFilter {
    readonly kinds?: readonly MemoryKind[];
    readonly tags?: readonly string[];
    readonly workspace?: string;
    readonly includeOtherWorkspaces?: boolean;
}
export interface SearchOptions extends MemoryFilter {
    readonly limit?: number;
    readonly minScore?: number;
}
export interface SearchHit {
    readonly entry: MemoryEntry;
    readonly score: number;
}
/** Decay-aware strength: base importance scaled by half-life since last access. */
export declare function strengthOf(entry: MemoryEntry, now: number, halfLifeMs: number): number;
export declare function contentHash(kind: MemoryKind, content: string): string;
/** In-memory store with atomic JSONL persistence. */
export declare class MemoryStore {
    private readonly path;
    private readonly entries;
    private loaded;
    private persistChain;
    private tempCounter;
    /** Decay half-life; mutable so settings hot-reloads can move it. */
    halfLifeMs: number;
    constructor(path: string, halfLifeMs: number);
    get size(): number;
    /** Load the store once; later calls are no-ops. */
    ensureLoaded(): Promise<void>;
    get(id: string): MemoryEntry | undefined;
    all(): MemoryEntry[];
    /** Insert or update by content identity; persists atomically. */
    put(input: {
        readonly kind: MemoryKind;
        readonly content: string;
        readonly tags?: readonly string[];
        readonly workspace?: string;
        readonly source?: MemoryEntry['source'];
        readonly importance?: number;
        readonly embedding: readonly number[];
    }): Promise<{
        entry: MemoryEntry;
        created: boolean;
    }>;
    /** Record one access (strengthening) for an entry. */
    touch(id: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    /**
     * Cosine search over normalized embeddings, filtered by kinds/tags/workspace.
     * Hits are ranked by similarity × decayed strength and capped by `limit`.
     */
    search(query: readonly number[], options?: SearchOptions): Promise<SearchHit[]>;
    /** Prompt-injection candidates: strongest decayed strength, recency tiebreak. */
    promptCandidates(limit: number, filter?: MemoryFilter): Promise<MemoryEntry[]>;
    /**
     * Synchronous rank used by the system-prompt section provider (which cannot
     * await). Only meaningful after `ensureLoaded()` has settled once.
     */
    promptCandidatesSync(limit: number, filter?: MemoryFilter): MemoryEntry[];
    stats(): Promise<{
        readonly total: number;
        readonly byKind: Readonly<Record<string, number>>;
        readonly byWorkspace: Readonly<Record<string, number>>;
        readonly latest: MemoryEntry | undefined;
    }>;
    private persist;
}
