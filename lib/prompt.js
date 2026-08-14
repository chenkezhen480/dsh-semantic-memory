/**
 * Automatic long-term memory injection into the system prompt.
 *
 * A dynamic `systemPrompt.section` re-evaluates its text on every assembly and
 * renders, in priority order:
 *
 * 1. **Semantic recall** — the freshest per-session recall seeded by the
 *    current user message (see {@link ../recall.ts}), so the turn starts with
 *    memories relevant to the actual question.
 * 2. **Strength ranking** — fallback when no recall exists yet: the strongest
 *    memories by importance × recency × access (cheap, fixed-size).
 *
 * Deep semantic recall stays a tool call away via `memory_search`.
 *
 * @module dsh-plugin-semantic-memory/prompt
 */
export function registerMemoryPrompt(ctx, store, recall, config) {
    ctx.systemPrompt.section({
        name: 'memory:semantic',
        order: 120,
        text: (context) => {
            // 1) Semantic recall for the assembling agent's session, when fresh.
            const sessionId = context.agent?.session?.id;
            if (sessionId !== undefined && recall !== undefined) {
                const state = recall.recallFor(sessionId);
                if (state !== undefined && state.hits.length > 0) {
                    return renderRecall(state.query, state.hits);
                }
            }
            // 2) Fallback: strongest resident memories.
            if (store.size === 0)
                return '';
            const candidates = store.promptCandidatesSync(config.topK());
            if (candidates.length === 0)
                return '';
            const lines = candidates.map(formatInjected);
            return [
                '## Long-term memory',
                'Preloaded memories relevant to this workspace. Call memory_search for deep semantic recall.',
                ...lines,
                'Writing: when the user states a durable preference, an established fact, or an explicit decision, proactively call memory_write — do not wait to be asked.',
            ].join('\n');
        },
    });
}
function renderRecall(query, hits) {
    const lines = hits.map(({ entry, score }) => {
        const meta = [entry.kind];
        if (entry.tags.length > 0)
            meta.push(entry.tags.join(','));
        return `- [${meta.join(' | ')}] ${entry.content}`;
    });
    return [
        '## Long-term memory (recalled for your current question)',
        `Question: ${query}`,
        ...lines,
        'Call memory_search for deeper recall. Writing: when the user states a durable preference, an established fact, or an explicit decision, proactively call memory_write — do not wait to be asked.',
    ].join('\n');
}
function formatInjected(entry) {
    const meta = [entry.kind];
    if (entry.tags.length > 0)
        meta.push(entry.tags.join(','));
    return `- [${meta.join(' | ')}] ${entry.content}`;
}
