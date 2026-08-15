# dsh-plugin-semantic-memory

[English](README.md) | **中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供向量长期记忆的插件（`dsh-plugin`，即 Cordis 插件）。

它让模型拥有跨会话的持久记忆，并按**语义**检索——不同于内置 `session_query` 的字面全文匹配（FTS5），本插件按"含义"召回。

**零配置开箱即用**：安装 → 重启 → 开新会话即可。本地 embedding 模型首次使用时自动下载（约 100 MB）也可以选择自己配置云端API；四个工具、按问题主动召回、每 5 轮自动总结全部默认开启。只有想调整行为时才需要配置（见[配置](#配置)）。

## 功能特性

- **跨会话语义记忆** —— 事实 / 决策 / 偏好 / 笔记，持久化为 JSONL，位于 `$DSH_HOME/memories/memories.jsonl`
- **向量检索** —— 归一化向量的余弦相似度；embedding 来源可插拔：
  - `local`（默认）：`@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`（离线，约 100 MB，缓存于 `~/.cache/huggingface`）
  - `api`：任意 OpenAI 兼容的 `/embeddings` 接口（如硅基流动、智谱、阿里百炼）
- **记忆衰减与强化** —— 每条记忆的有效强度按半衰期随时间减半；被检索到会刷新。写入时的 importance（1~5）决定基础强度
- **模型工具**：
  - `memory_write` —— 持久化一条 事实/决策/偏好/笔记（内容哈希去重，重复写入原地更新）
  - `memory_search` —— 语义 top-k 召回，支持 kind / tags / workspace 过滤
  - `memory_forget` —— 按 id 删除
  - `memory_stats` —— 记忆库统计
- **自动注入** —— 插件监听会话事件流：每条新用户消息异步嵌入并检索，**在下一轮提示词组装前**注入与该问题最相关的记忆（带问题感知）。没有新鲜召回时，按强度排序的最强记忆作为固定大小的兜底注入
- **主动写入引导** —— 注入的提示要求模型在用户表达持久偏好、确立事实或明确决策时**主动调用** `memory_write`，无需用户说"记住"
- **自动总结** —— 每 N 条用户消息（默认 5），调用 harness LLM 把**自上次总结以来的新消息**（按会话内 seq 游标增量提炼，不重复不遗漏）蒸馏成记忆条目写入（带 `auto` 标签）；每会话单飞执行，失败静默；仅在 `llm` 与 `agentDefaultModel` 服务存在时激活
- **工作区标签** —— 条目记录写入时的会话 cwd；检索默认限定当前工作区，可跨工作区召回

## 安装到 DSH profile

**官方一行命令**（包自带 `cordis.patch.yml`，通过 `dsh.bundle.patch` 声明，`dsh plugin add` 自动挂载——无需手改 profile）：

```sh
dsh plugin --profile web add dsh-plugin-semantic-memory
# 或本地目录 / tarball：
dsh plugin --profile web add file:C:/path/to/dsh-embedding
```

然后**重启 `dsh web`** 并开新会话。所有参数都有 schema 默认值；**包内配置覆盖外层配置**——部署配置源是插件包内的 `cordis.patch.yml`，`~/.dsh/settings.yaml` 的 `semantic-memory:` 段与用户 profile patch 只会补充包内未声明的键，不会覆盖包内取值。以 `file:` 链接安装时 loader 每次启动实时读取该文件：改完重启即生效，无需重新安装。

手动安装的等价做法（老版本）：把依赖加进 profile 的 `package.json`，并插入挂载行——**新条目必须用 `insert`**（裸 `- id:` 只覆盖已存在的 bundle id，会被静默忽略）：

```yaml
- insert:
    - id: semantic-memory
      name: 'dsh-plugin-semantic-memory'
```

不写 `mode` / `provider`：自动选择（见下）。

## 使用方法

### Provider 选择

`mode` 是显式的部署开关，未设置时回退到自动选择：

| 配置情况 | 使用的 Provider |
|---|---|
| `mode: 'cloud'` | **API**（OpenAI 兼容 `/embeddings` 接口；必须配 `apiKey`） |
| `mode: 'local'` | **本地**（ONNX，`@huggingface/transformers`，离线；即使有 `apiKey`） |
| 未写 `mode`，填了 `apiKey`（非空） | **API** |
| 未写 `mode`，没有 `apiKey` | **本地** |
| 显式 `provider: 'local'` | 本地（即使有 `apiKey`） |
| 显式 `provider: 'api'` | API（必须配 `apiKey`） |

切换部署模式 = 改包内 `cordis.patch.yml` 的 `mode`（`local` ↔ `cloud`）并重启 `dsh web`。**包内配置覆盖外层配置**：settings.yaml 与用户 profile patch 只补充包内未声明的键，不会覆盖包内取值。首次本地嵌入会下载模型（约 100 MB，缓存于 `~/.cache/huggingface`；网络受限用 `remoteHost` 指镜像）。

### 验证插件已生效

开一个**新会话**（旧会话工具集固定），问模型：*"你有 memory_* 工具吗？"* —— 应列出 `memory_write`、`memory_search`、`memory_forget`、`memory_stats`。记忆存在后，系统提示中会出现 `## Long-term memory` 段落。

### 模型能做什么

- **自动持久化** —— 表达持久的偏好 / 事实 / 决策即可，注入的引导会让模型主动 `memory_write`，不用专门说"记住"
- **让它记住** —— *"记住：我在用硅基流动的 API"* → `memory_write`
- **回忆** —— *"我之前对回答风格有什么偏好？"* —— 每轮主动召回会自动浮出相关记忆；`memory_search` 可深度检索（支持 kind / tags / workspace / limit / min_score）
- **管理** —— `memory_forget <id>` 删除；`memory_stats` 查看统计

### 自动行为

| 触发点 | 行为 |
|---|---|
| 每条用户消息 | 异步嵌入 + 检索；最新按会话的命中注入下一轮提示词（`## Long-term memory (recalled for your current question)`） |
| 每 N 条用户消息（默认 5） | harness LLM 把**自上次总结以来的新消息**（会话级 seq 游标，不重复不遗漏）蒸馏为记忆条目，打 `auto` 标签写入；节奏可用环境变量 `DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY` 调整（`0` 禁用，优先级高于配置文件） |
| 提示词组装且无新鲜召回 | 注入最强记忆（importance × 新鲜度 × 访问次数）作为兜底 |

### 数据位置

- 记忆库：`$DSH_HOME/memories/memories.jsonl`（每条一行 JSON，含向量；可自由编辑/备份）
- 配置：包内 `cordis.patch.yml`（部署配置源，包内覆盖外层）；`~/.dsh/settings.yaml` 的 `semantic-memory:` 段只补充包内未声明的键（热更新）

### 常见问题

- **会话里没有 memory_* 工具** —— 该会话创建早于插件安装；请开新会话
- **首次本地嵌入慢 / 失败** —— 首次使用要下载模型；网络受限时配置 `remoteHost: https://hf-mirror.com`
- **`api` 报错** —— 确认 `mode` / `apiKey` 已配置、`apiBase` 指向 OpenAI 兼容端点（`/v1` 结尾的地址会自动追加 `/embeddings`）
- **自动总结从不触发** —— 需要 `llm` 与 `agentDefaultModel` 服务（标准 web profile 自带），且 `autoSummarizeEvery > 0`

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `mode` | （未设置） | 部署开关：`local` 强制本地模型；`cloud` 强制云端 API（必须配 `apiKey`）。未设置时自动选择 |
| `provider` | `auto` | `auto`：按 apiKey 自动选择（非空 → `api`，否则 `local`）；显式 `local`/`api` 覆盖。显式 `mode` 优先于两者 |
| `localModel` | `Xenova/bge-small-zh-v1.5` | 本地 transformer 模型 id |
| `remoteHost` | `https://huggingface.co` | 模型下载源；网络受限设 `https://hf-mirror.com` |
| `apiBase` | `https://api.siliconflow.cn/v1` | API 地址（自动追加 `/embeddings` 路由） |
| `apiKey` | `''` | API 密钥；非空且未显式 `local` 时使用 API provider |
| `apiModel` | `BAAI/bge-m3` | API embedding 模型名 |
| `memoryPath` | `$DSH_HOME/memories/memories.jsonl` | 记忆库文件路径 |
| `promptTopK` | `3` | 每轮提示词注入的记忆条数（0 关闭注入） |
| `maxSearchResults` | `10` | `memory_search` 默认返回上限 |
| `minScore` | `0.35` | 召回应答的最低相关度（0~1） |
| `halfLifeMs` | 30 天 | 记忆强度半衰期 |
| `autoSummarizeEvery` | `5` | 每 N 条用户消息自动总结（0 禁用；需要 llm + agentDefaultModel）。环境变量 `DSH_SEMANTIC_MEMORY_SUMMARIZE_EVERY` 可覆盖（0~100） |
| `summarizeWindow` | `12` | 一次自动总结包含的最近消息数 |
| `summarizeMaxTokens` | `800` | 总结调用的 token 预算 |
| `summarizeTemperature` | `0.2` | 总结调用的采样温度 |

## 记忆模型

```ts
interface MemoryEntry {
  id: string            // sha1(kind + content) 前 16 位十六进制 —— upsert 键
  kind: 'fact' | 'decision' | 'preference' | 'note'
  content: string       // 一句自包含的话（无代词）
  tags: string[]
  workspace?: string    // 写入时调用方会话的 cwd
  source?: { sessionId: string; seq: number }
  importance: number    // 1..5
  embedding: number[]   // 归一化向量
  createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessAt: number
}
```

有效强度 = `importance / 5 × 0.5^(age / halfLife)`；检索排序 = `cosine(query, entry) × strength`。

## 已知限制

- **召回是尽力而为且异步的** —— 用户消息监听在后台嵌入；冷启动（模型仍在下载）或 API 较慢时，首次召回可能晚一步到达，由强度兜底注入补位。召回缓存按会话隔离，60 秒过期
- **提示词注入是同步的** —— 注入段落只渲染内存中的数据；记忆库在首次工具调用时懒加载，全新进程的第一次组装可能没有注入
- **没有独立的 embedding 持久化缓存** —— 向量直接存在每条目内，无需单独索引文件，但也永远不会重新嵌入（条目保留各自向量）
- **暴力检索** —— 每次查询对所有条目做 O(n) 余弦计算；个人规模（数千条）足够，不适合百万级
