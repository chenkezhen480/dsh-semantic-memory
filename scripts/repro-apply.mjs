/**
 * Repro: mount the plugin against real tools/systemPrompt plus a settings
 * service stub, exactly like the web profile composes it, to see whether
 * apply() throws (which would make the loader drop the plugin).
 *
 * Usage: node scripts/repro-apply.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Plugin from '../lib/index.js'

const ctx = new Context()
ctx.plugin(SystemPrompt, {})
ctx.plugin(ToolRuntime, {})

// Settings stub: behaves like dsh-settings (register → scope with get/watch).
let registered = false
ctx.provide('settings', {
  register(ns, schema, options) {
    registered = true
    console.log('[stub settings] register', ns, 'base keys:', Object.keys(options?.base ?? {}))
    let value = undefined
    return {
      get: () => value,
      watch: () => () => {},
    }
  },
})

try {
  ctx.plugin({ name: Plugin.name, inject: Plugin.inject, apply: Plugin.apply }, {
    provider: 'auto',
    remoteHost: 'https://hf-mirror.com',
    promptTopK: 3,
    minScore: 0.35,
    autoSummarizeEvery: 5,
  })
  console.log('APPLY OK — settings registered:', registered)
  const tools = (ctx.tools).get('memory_write')
  console.log('memory_write tool present:', tools !== undefined)
} catch (error) {
  console.error('APPLY THREW:', error)
  process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
}
