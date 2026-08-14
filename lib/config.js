/** Deployment configuration for the semantic memory plugin. */
import z from '@deepseek-ai/schemastery';
/** Memory kinds the model may distinguish when writing entries. */
export const MEMORY_KINDS = ['fact', 'decision', 'preference', 'note'];
/** Schemastery schema for Loader defaults and configuration docs. */
export const Config = z.object({
    provider: z.union([z.const('local'), z.const('api')]).default('local'),
    localModel: z.string().default('Xenova/bge-small-zh-v1.5'),
    remoteHost: z.string().default('https://huggingface.co'),
    apiBase: z.string().default('https://api.siliconflow.cn/v1'),
    apiKey: z.string().default(''),
    apiModel: z.string().default('BAAI/bge-m3'),
    memoryPath: z.string().default(''),
    promptTopK: z.number().step(1).min(0).max(20).default(3),
    maxSearchResults: z.number().step(1).min(1).max(50).default(10),
    minScore: z.number().min(0).max(1).default(0.35),
    halfLifeMs: z.number().min(1).default(30 * 24 * 60 * 60 * 1000),
    autoSummarizeEvery: z.number().step(1).min(0).max(100).default(5),
    summarizeWindow: z.number().step(1).min(1).max(100).default(12),
    summarizeMaxTokens: z.number().step(1).min(64).max(2000).default(400),
    summarizeTemperature: z.number().min(0).max(2).default(0.2),
});
const DEFAULT_MEMORY_FILE = 'memories/memories.jsonl';
/** Resolve the config against process environment defaults. */
export function resolveConfig(config) {
    const provider = config.provider ?? 'local';
    if (provider !== 'local' && provider !== 'api') {
        throw new TypeError(`semantic-memory: provider must be "local" or "api", got ${String(provider)}`);
    }
    const apiKey = config.apiKey ?? '';
    const memoryPath = (config.memoryPath ?? '').length > 0
        ? config.memoryPath
        : joinDshHome(DEFAULT_MEMORY_FILE);
    if (provider === 'api' && apiKey.length === 0) {
        throw new TypeError('semantic-memory: api provider requires apiKey');
    }
    return {
        provider,
        localModel: config.localModel ?? 'Xenova/bge-small-zh-v1.5',
        remoteHost: config.remoteHost ?? 'https://huggingface.co',
        apiBase: config.apiBase ?? 'https://api.siliconflow.cn/v1',
        apiKey,
        apiModel: config.apiModel ?? 'BAAI/bge-m3',
        memoryPath,
        promptTopK: config.promptTopK ?? 3,
        maxSearchResults: config.maxSearchResults ?? 10,
        minScore: config.minScore ?? 0.35,
        halfLifeMs: config.halfLifeMs ?? 30 * 24 * 60 * 60 * 1000,
        autoSummarizeEvery: config.autoSummarizeEvery ?? 5,
        summarizeWindow: config.summarizeWindow ?? 12,
        summarizeMaxTokens: config.summarizeMaxTokens ?? 400,
        summarizeTemperature: config.summarizeTemperature ?? 0.2,
    };
}
function joinDshHome(relative) {
    const home = process.env.DSH_HOME ?? joinHome('.dsh');
    return `${home.replace(/[\\/]+$/u, '')}/${relative}`;
}
function joinHome(name) {
    const root = process.env.USERPROFILE ?? process.env.HOME;
    if (root === undefined)
        throw new Error('semantic-memory: cannot locate the user home directory');
    return `${root.replace(/[\\/]+$/u, '')}/${name}`;
}
