/**
 * Repro 2: mount the plugin against the REAL dsh-settings-file provider, the
 * same one the web profile uses, to surface the exact apply() failure.
 *
 * Usage: node scripts/repro-settings.mjs
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Plugin from '../lib/index.js'

const SettingsFile = (await import(
  pathToFileURL('C:/Users/17685/.dsh/profiles/node_modules/@deepseek-ai/dsh-settings-file/lib/index.js').href
)).default

const dir = await mkdtemp(join(tmpdir(), 'smem-settings-'))
const docPath = join(dir, 'settings.yaml')
await writeFile(docPath, '# empty\n', 'utf8')

const ctx = new Context()
ctx.plugin(SystemPrompt, {})
ctx.plugin(ToolRuntime, {})
ctx.plugin(SettingsFile, { path: docPath })

try {
  ctx.plugin({ name: Plugin.name, inject: Plugin.inject, apply: Plugin.apply }, {
    provider: 'auto',
    remoteHost: 'https://hf-mirror.com',
    promptTopK: 3,
    minScore: 0.35,
    autoSummarizeEvery: 5,
  })
  console.log('APPLY OK')
  const tools = (ctx.tools).get('memory_write')
  console.log('memory_write tool present:', tools !== undefined)
} catch (error) {
  console.error('APPLY THREW:', error?.message)
  console.error(error?.stack?.split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}
