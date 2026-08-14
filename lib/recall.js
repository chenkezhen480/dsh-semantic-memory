/**
 * Proactive semantic recall: watches the session event stream and, on every
 * new user message, asynchronously embeds the message text and searches the
 * memory store. The freshest per-session result is cached and consumed by the
 * system-prompt section provider, so each turn is seeded with memories
 * relevant to the *current question* — no tool call required.
 *
 * Concurrency: a monotonically increasing generation invalidates stale
 * in-flight recalls, so a fast user message never overwrites a newer one.
 * Failures (model not downloaded yet, API down) are silent: the prompt falls
 * back to strength-ranked injection.
 *
 * @module dsh-plugin-semantic-memory/recall
 */
const MAX_QUERY_CHARS = 800;
export class RecallCache {
    store;
    embeddings;
    config;
    state;
    generation = 0;
    constructor(store, embeddings, config) {
        this.store = store;
        this.embeddings = embeddings;
        this.config = config;
    }
    /** Listen for user messages on all sessions. Returns nothing (ctx owns the listener). */
    attach(ctx) {
        ctx.on('session/event', (_session, event) => {
            if (event.type !== 'user/message')
                return;
            const text = extractUserText(event.data);
            if (text.length === 0)
                return;
            this.startRecall(_session.id, text);
        });
    }
    /** The current recall for one session, or undefined when absent or stale. */
    recallFor(sessionId) {
        const state = this.state;
        if (state === undefined || state.sessionId !== sessionId)
            return undefined;
        if (Date.now() - state.at > this.config.staleMs)
            return undefined;
        return state;
    }
    startRecall(sessionId, query) {
        const generation = ++this.generation;
        void (async () => {
            try {
                const [vector] = await this.embeddings.embed([query]);
                if (vector === undefined || vector.length === 0 || generation !== this.generation)
                    return;
                const hits = await this.store.search(vector, {
                    limit: this.config.topK(),
                    minScore: this.config.minScore(),
                });
                if (generation !== this.generation)
                    return;
                this.state = { sessionId, query, hits, at: Date.now() };
                // Recalled memories strengthen: refresh access for the next ranking.
                for (const { entry } of hits) {
                    void this.store.touch(entry.id);
                }
            }
            catch {
                // Silent: embedding unavailable or store busy; keep prior state.
            }
        })();
    }
}
/** Extract the user-visible text of a user/message payload. */
export function extractUserText(data) {
    const message = data;
    if (message === undefined || !Array.isArray(message.content))
        return '';
    let text = '';
    for (const block of message.content) {
        if (typeof block === 'object' && block !== null
            && block.type === 'text'
            && typeof block.text === 'string') {
            text += block.text;
        }
    }
    return text.trim().slice(0, MAX_QUERY_CHARS);
}
