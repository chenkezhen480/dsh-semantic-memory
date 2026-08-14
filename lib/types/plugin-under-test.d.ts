/**
 * Test adapter: exposes the plugin as a Cordis plugin object and a minimal
 * tool-definition shape so integration tests can invoke tool bodies directly.
 *
 * @module dsh-plugin-semantic-memory/tests/plugin-under-test
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { apply } from './index.ts';
export declare const SemanticMemory: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
/** The subset of a registered tool the tests exercise. */
export interface ToolDefinitionLike {
    readonly name: string;
    execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>;
}
