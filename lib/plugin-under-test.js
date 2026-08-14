/**
 * Test adapter: exposes the plugin as a Cordis plugin object and a minimal
 * tool-definition shape so integration tests can invoke tool bodies directly.
 *
 * @module dsh-plugin-semantic-memory/tests/plugin-under-test
 */
import { apply, inject, name } from "./index.js";
export const SemanticMemory = { name, inject, apply };
