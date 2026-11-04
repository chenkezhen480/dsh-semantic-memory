/**
 * Test adapter: exposes the plugin as a Cordis plugin object and a minimal
 * tool-definition shape so integration tests can invoke tool bodies directly.
 *
 * @module dsh-plugin-semantic-memory/tests/plugin-under-test
 */
import { apply, inject, name } from "./index.js";
export const SemanticMemory = { name, inject, apply };
/**
 * Tool executor stub. The current tools service refuses to assemble a prompt
 * without a selected executor, while these tests only exercise the memory
 * prompt section and tool bodies, never tool dispatch.
 */
export const StubToolExecutor = {
    describe: (tools) => ({
        schemas: tools.map(tool => ({ ...tool })),
        knownNames: tools.map(tool => tool.name),
    }),
    execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
};
