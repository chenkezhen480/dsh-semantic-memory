/**
 * Model-facing tools for the semantic memory store.
 *
 * Registered through `ctx.tools.register(defineTool(...))`; each tool takes
 * the caller session's cwd as its workspace tag and scopes search to that
 * workspace unless the model opts into cross-workspace recall.
 *
 * @module dsh-plugin-semantic-memory/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
};
const writeParameters = {
    kind: {
        type: 'string',
        enum: ['fact', 'decision', 'preference', 'note'],
        required: true,
        description: 'Memory kind: fact (established truth), decision (a choice made), preference (user preference), note (anything else).',
    },
    content: {
        type: 'string',
        required: true,
        description: 'One-sentence semantic memory text, self-contained and timeless (no pronouns).',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags for filtering.' },
    importance: {
        type: 'integer',
        description: 'Importance 1..5; drives how strongly the memory decays and ranks. Defaults to 3.',
    },
};
const searchParameters = {
    query: { type: 'string', required: true, description: 'Natural-language description of what to recall.' },
    kind: {
        type: 'string',
        enum: ['fact', 'decision', 'preference', 'note'],
        description: 'Restrict hits to one memory kind.',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Require all listed tags on a hit.' },
    workspace: {
        type: 'string',
        description: 'Workspace to search. Omit to search the caller workspace; pass "*" for all workspaces.',
    },
    limit: { type: 'integer', description: 'Maximum hits (1..20). Defaults to the plugin max.' },
    min_score: { type: 'number', description: 'Minimum relevance 0..1. Defaults to the plugin threshold.' },
};
const forgetParameters = {
    id: { type: 'string', required: true, description: 'Memory id from memory_search or memory_write.' },
};
export function registerMemoryTools(ctx, services, config) {
    ctx.tools.register(defineTool({
        name: 'memory_write',
        description: 'Write one fact, decision, preference, or note into long-term semantic memory. Repeats with the same kind and content update the existing entry.',
        parameters: writeParameters,
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
            const kind = args.kind;
            const content = String(args.content).trim();
            if (content.length === 0)
                throw new Error('memory_write: content must be non-empty');
            if (content.length > 2000)
                throw new Error('memory_write: content exceeds 2000 characters');
            const embedding = await services.embeddings.embed([content], exec.signal);
            const vector = embedding[0];
            if (vector === undefined || vector.length === 0) {
                throw new Error('memory_write: embedding failed');
            }
            const caller = callerOf(exec);
            const { entry, created } = await services.store.put({
                kind,
                content,
                tags: normalizeTags(args.tags),
                workspace: caller.workspace,
                source: caller.source,
                importance: typeof args.importance === 'number' ? args.importance : 3,
                embedding: vector,
            });
            return `memory ${created ? 'written' : 'updated'}: ${entry.id} [${entry.kind}] ${entry.content}`;
        },
        presentCall: args => ({ card: 'generic', title: 'Write memory', rawInput: `${args.kind}: ${args.content}` }),
    }));
    ctx.tools.register(defineTool({
        name: 'memory_search',
        description: 'Semantically search long-term memory across sessions. Use it to recall prior facts, decisions, and preferences relevant to the current task.',
        parameters: searchParameters,
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
            const query = String(args.query).trim();
            if (query.length === 0)
                throw new Error('memory_search: query must be non-empty');
            const caller = callerOf(exec);
            const workspace = args.workspace === undefined || args.workspace === '*'
                ? undefined
                : String(args.workspace);
            const queryVector = await services.embeddings.embed([query], exec.signal);
            const vector = queryVector[0];
            if (vector === undefined || vector.length === 0) {
                throw new Error('memory_search: embedding failed');
            }
            const hits = await services.store.search(vector, {
                kinds: args.kind === undefined ? undefined : [args.kind],
                tags: normalizeTags(args.tags),
                workspace: workspace ?? caller.workspace,
                includeOtherWorkspaces: workspace !== undefined || args.workspace === '*',
                limit: typeof args.limit === 'number' ? clampLimit(args.limit) : config.maxSearchResults,
                minScore: typeof args.min_score === 'number' ? args.min_score : config.minScore,
            });
            if (hits.length === 0)
                return 'No matching memories found.';
            const lines = hits.map(({ entry, score }) => formatHit(entry, score));
            return `Found ${hits.length} memories:\n${lines.join('\n')}`;
        },
        presentCall: args => ({ card: 'generic', title: 'Search memory', rawInput: args.query }),
    }));
    ctx.tools.register(defineTool({
        name: 'memory_forget',
        description: 'Delete one memory entry by id (from memory_search or memory_write).',
        parameters: forgetParameters,
        output: TEXT_OUTPUT,
        execute: async (args, exec) => {
            const id = String(args.id).trim();
            const existed = await services.store.remove(id);
            return existed ? `Memory deleted: ${id}` : `No memory with id ${id}.`;
        },
        presentCall: args => ({ card: 'generic', title: 'Forget memory', rawInput: args.id }),
    }));
    ctx.tools.register(defineTool({
        name: 'memory_stats',
        description: 'Summarize the long-term memory store: totals, kind distribution, and workspace distribution.',
        parameters: {},
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => true,
        execute: async (_args, exec) => {
            const stats = await services.store.stats();
            const kindLine = Object.entries(stats.byKind)
                .map(([kind, count]) => `${kind}: ${count}`)
                .join(', ');
            const wsLine = Object.entries(stats.byWorkspace)
                .map(([workspace, count]) => `${workspace}: ${count}`)
                .join(', ');
            return [
                `Total memories: ${stats.total}`,
                `By kind: ${kindLine || '(none)'}`,
                `By workspace: ${wsLine || '(none)'}`,
            ].join('\n');
        },
        presentCall: () => ({ card: 'generic', title: 'Memory stats' }),
    }));
}
function formatHit(entry, score) {
    const tags = entry.tags.length > 0 ? ` tags:[${entry.tags.join(', ')}]` : '';
    const workspace = entry.workspace === undefined ? '' : ` ws:${entry.workspace}`;
    return `- ${entry.id} [${entry.kind}] (score ${score.toFixed(3)})${tags}${workspace}\n  ${entry.content}`;
}
function callerOf(exec) {
    const agent = exec.agent;
    if (agent === undefined)
        return { workspace: undefined, source: undefined };
    const session = agent.session;
    if (session === undefined)
        return { workspace: undefined, source: undefined };
    const events = session.events;
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    return {
        workspace: session.header.cwd,
        source: { sessionId: session.id, seq: last?.seq ?? 0 },
    };
}
function normalizeTags(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map(tag => String(tag).trim())
        .filter(tag => tag.length > 0)
        .slice(0, 20);
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 10;
    return Math.min(20, Math.max(1, Math.round(value)));
}
