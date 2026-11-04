/**
 * Test adapter: exposes the plugin as a Cordis plugin object and a minimal
 * tool-definition shape so integration tests can invoke tool bodies directly.
 *
 * @module dsh-plugin-semantic-memory/tests/plugin-under-test
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from './index.ts'

export const SemanticMemory = { name, inject, apply }

/** The subset of a registered tool the tests exercise. */
export interface ToolDefinitionLike {
  readonly name: string
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
}

/**
 * Tool executor stub. The current tools service refuses to assemble a prompt
 * without a selected executor, while these tests only exercise the memory
 * prompt section and tool bodies, never tool dispatch.
 */
export const StubToolExecutor = {
  describe: (tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[]) => ({
    schemas: tools.map(tool => ({ ...tool })),
    knownNames: tools.map(tool => tool.name),
  }),
  execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
}
