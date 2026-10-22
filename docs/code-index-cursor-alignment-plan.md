# code-index 与 Cursor 对齐计划

- 状态：实施中（P0–P3 已落地并测试，P4 发布中）
- 日期：2026-10-22
- 目标插件：`plugins/dsh-code-index`（目标 0.12.0）
- 目标服务端：`server/code-index-service`
- 范围：扫描边界（docs / 禁用模块 / ignore）、自动 freshness、团队共享与 simhash 整库复用
- 原则：对齐 Cursor 的**行为结果**，不照抄 Merkle 协议、整份 index copy 和 content proof

---

## 一、结论先行

1. **Cursor 没有“模块是否启用”的概念。** 它按 workspace 文件 + ignore 规则建索引，不读 `settings.gradle` / `pom.xml` / 构建 profile。business 5.0 中没有启用的 Groovy 模块，只要文件在工作区、未被 ignore，就会被索引和检索。
2. **Cursor 对文档的处理是“文本文件当普通文件”。** `.md` 等文本会进入索引；`.pdf`、`.doc`、`.xls`、`.xlsx` 等在默认 ignore 列表中，不进入代码库索引；`@Docs` 是另一条外部文档通道。
3. **我们当前行为与 Cursor 接近但缺少 ignore 层。** 现在只认内置排除 + 配置 `exclude`，不读 `.gitignore` / `.cursorignore`；`.md` 已默认索引，Office 格式未包含。
4. **自动 freshness 是当前最大体验差距。** `sync.watch` 默认关，只在显式 `code_index` 后挂载；DSH 重启后不恢复；同步进行中的事件会丢。
5. **团队共享已经有一半。** 服务端按 `lineage = hash(归一化 git remote)` 共享 `blobs/vectors`，同一 remote 的不同分支、clone、开发者已经自动复用，无需 simhash。
6. **simhash 只用于“找候选索引”，不能当存储键。** 我们不复制整份 index，只复制目标确实拥有、且候选已有向量的**精确内容哈希**；不复制候选 chunks/path。
7. **不建议直接上 Cursor 式整库 copy。** 单团队自托管场景下，目标 manifest + namespace 隔离已能避免串库；Merkle content proof 是整库 copy 的配套，不是我们的第一优先级。

---

## 二、Cursor 行为基线

### 2.1 索引输入

Cursor 的索引输入可以概括为：

```text
workspace 文件
  - .gitignore
  - .cursorignore
  - Cursor 默认 ignore 列表
  → 可嵌入文本文件
  → 切块 / embedding
```

官方 [Ignore file 文档](https://cursor.com/docs/reference/ignore-file.md) 说明：

- 默认读取 `.gitignore`；
- `.cursorignore` 使用 gitignore 语法，可以额外排除；
- 有默认 ignore 列表（`node_modules/`、构建目录、锁文件、PDF/Office/图片/二进制等）；
- 支持 `!` 反选；
- 支持分层 ignore。

Cursor 的 `.cursorignore` 还会阻止 Agent 访问相关文件，但官方明确说 **terminal / MCP 工具不受该限制**。社区/部分版本另有 `.cursorindexingignore` 用于“只影响索引”，语义随版本可能变化。

### 2.2 文档

| 类型 | Cursor 行为 |
|---|---|
| `.md` / `.txt` / 源码注释 | 作为文本进入代码库索引，可被语义搜索和 `@` 引用命中 |
| `.pdf` / `.doc` / `.xls` / `.xlsx` / `.ppt` | 默认 ignore，不进入代码库索引 |
| 图片 / 压缩包 / 二进制 | 默认 ignore |
| 外部文档网站 | 走 `@Docs`，不是代码库索引 |
| 旧 docs | 和旧代码一样会污染语义检索，需要 ignore/排除 |

### 2.3 禁用模块

Cursor **不解析构建图**。一个模块即使没被当前构建启用，只要文件在 workspace 且未被 ignore：

- 会被切块、embedding；
- 会被语义搜索命中；
- 会被 Instant Grep 的 regex 命中；
- Agent 可能引用“已经不再启用”的旧实现。

唯一可靠的过滤方式是：

- `.cursorignore` / 索引专用 ignore；
- 把模块移出 workspace；
- 或只在 workspace 打开当前启用模块。

---

## 三、目标与成功标准

### 3.1 扫描边界

- `.gitignore`、`.cursorignore`、`.cursorindexingignore` 中的文件不再进入索引；
- `.md` 默认索引，Office/PDF 不索引；
- 禁用 Groovy 模块默认仍索引，但可以通过 ignore / `exclude` 完全排除；
- 修改 ignore 文件后，下一次刷新能删除旧 chunks；
- `code_index_status` 显示 ignored 数量和来源；
- 不引入“解析构建系统”的隐式行为。

### 3.2 自动 freshness

- 已建过索引的仓库，保存文件后无需手动 `code_index`，在 debounce + 单次增量时间内完成本地 FTS + 远端同步；
- 同步进行中发生的新变更不丢，合并到下一轮；
- DSH 重启后自动恢复监听；
- 多 DSH 进程不会重复并发同步同一仓库；
- watcher 不支持时由周期对账兜底；
- `code_index_status` 显示自动同步状态、最近同步、错误。

### 3.3 团队共享 / 整库复用

- 同一 remote：继续走 lineage 共享，第二用户/第二 clone 0 新嵌入、0 正文重复上传；
- 跨 lineage（fork、remote 改名、vendor 副本）：simhash 找候选，精确重叠达到阈值后，只复制目标确实拥有的块的 blobs/vectors；
- 不复制候选 chunks/path，目标搜索结果中不出现只有候选才有的文件；
- 模型 tag 不一致、配置关闭、相似度不足时绝不 adopt。

---

## 四、P0：扫描边界对齐（1 天）

### 4.1 ignore 层

新增 `plugins/dsh-code-index/lib/ignore.js`，优先使用成熟的纯 JS 包 `ignore`（无原生模块、无构建脚本），避免自己实现不完整的 gitignore 语义。

- 新增依赖：`ignore`（纯 JS；安装期无 `pendingBuilds`）；
- 更新 `README.md` 的“零运行时依赖”描述，明确新增的纯 JS 依赖；
- 更新测试的 import 白名单。

读取顺序：

1. 内置默认排除；
2. 根 `.gitignore`；
3. 根 `.cursorignore`；
4. 根 `.cursorindexingignore`（存在则读取）；
5. 用户 `exclude`。

规则：

- 默认支持嵌套 `.gitignore`（标准 Git 行为）；
- 嵌套 `.cursorignore` 通过 `hierarchicalCursorIgnore` 配置开启，默认只读根文件；
- `!` 反选按 gitignore 语义处理；
- 目录命中后不再遍历，性能与 Cursor 一致；
- 提供 `match(relPath, isDir)` 和 `whyIgnored(relPath)`，后者用于状态输出；
- ignore 文件本身及索引目录始终排除。

### 4.2 改造 `walkRepo`

文件：`plugins/dsh-code-index/lib/scan.js`

新增参数：

```js
walkRepo(root, {
  include,
  excludeDirs,
  excludePaths,
  ignoreMatcher,
  maxFileBytes,
})
```

行为：

- 目录先查默认排除 + ignore；命中则不遍历；
- 文件查扩展名、ignore、大小；
- 返回原有 `{rel, abs, mtime, size}`；
- 统计被各来源排除的文件数；
- 保持排序稳定，保证跨平台确定性。

### 4.3 扩展名与文档策略

当前 `DEFAULT_INCLUDE` 已有 `.md`，保持默认：

- `.md`：默认索引，固定窗口 60 行；
- `.txt` / `.rst`：默认不索引，用户可通过 `scan.include` 显式加入；
- `.docx` / `.pdf` / `.xlsx`：不进入 include，和 Cursor 默认 ignore 一致；
- 增加二进制嗅探：即使扩展名在 include 里，内容含 NUL 字节则跳过并记录原因。

新增配置：

```yaml
advanced:
  scan:
    respectIgnoreFiles: true
    ignoreFiles: [".gitignore", ".cursorignore", ".cursorindexingignore"]
    hierarchicalGitignore: true
    hierarchicalCursorIgnore: false
    include: null       # null = 使用内置 DEFAULT_INCLUDE
    binarySniff: true
```

`include: null` 完全保持现有行为；显式给数组时只索引这些扩展名。

### 4.4 禁用模块处理

**不读取构建配置**。business 5.0 的禁用 Groovy 模块：

- 默认仍然索引 `.groovy`；
- 排除方式：

```yaml
exclude:
  - "business-5.0/legacy-groovy"
  - "business-5.0/disabled-modules"
```

或在仓库放 `.cursorignore`：

```sh
business-5.0/legacy-groovy/
```

修改后下一次 `code_index`：

- `diffFiles` 识别 `removed`；
- 本地 chunks/FTS/远端 chunks 清理；
- 不需要全量重建；
- 向量保留在 lineage 内容缓存中，但不再被该快照检索。

README 明确写：

> 代码索引不解析构建系统；“模块未启用”不等于“不索引”。需要排除时用 ignore 或 `exclude`。

### 4.5 状态与输出

`code_index` / `code_index_status` 增加：

```text
扫描 2390 文件；忽略 117（gitignore 94 / cursorignore 3 / exclude 20）
已排除：business-5.0/legacy-groovy、docs/2-technical
```

结构化字段：

```json
{
  "scan": {
    "ignored": 117,
    "bySource": {
      "gitignore": 94,
      "cursorignore": 3,
      "cursorindexingignore": 0,
      "exclude": 20
    },
    "binarySkipped": 2
  }
}
```

### 4.6 P0 测试

新增 `test-ignore.mjs`：

- `.gitignore` 基础、`**`、`!`、目录、嵌套；
- `.cursorignore` 追加排除；
- `.cursorindexingignore`；
- docs：`.md` 索引、`.docx`/`.pdf` 不索引；
- 禁用 Groovy 模块默认索引；加 `exclude`/ignore 后被排除；
- 二进制嗅探；
- ignore 文件改动 → 下次 `code_index` 产生 removed；
- Windows 路径分隔符；
- `respectIgnoreFiles: false` 恢复旧行为。

更新 `test.mjs` 扫描用例和 README 测试计数。

---

## 五、P1：自动 freshness（1.5 天）

### 5.1 持久仓库注册表

新增 `plugins/dsh-code-index/lib/repo-registry.js`：

位置：

```text
<DSH_HOME>/code-index/repos.json
```

结构：

```json
{
  "version": 1,
  "repos": {
    "D:/Code/business-5.0": {
      "dbPath": "...",
      "lastIndexedAt": 0,
      "lastSyncAt": 0,
      "watch": true
    }
  }
}
```

- 原子写（临时文件 + rename）；
- 最多 200 个仓库；
- `code_index` 成功后 upsert；
- 插件启动时加载，清理不存在或不在 `roots` 白名单内的路径。

### 5.2 启动恢复监听

`apply()` 末尾：

- 若 `config.sync.watch = true`：
  - 遍历 registry；
  - 对存在、已建索引、通过 `assertAllowed` 的仓库调用 `ensureWatch`；
- 不自动首次建库：首次索引仍显式 `code_index`，避免意外重负载。

### 5.3 修复 watcher 丢事件

当前问题：同步运行期间新事件被 `running` 检查丢掉。

改为：

```js
{
  watcher, timer, running, dirty,
  lastEventAt, failures, nextDelayMs
}
```

规则：

- 每次事件设 `dirty = true`；
- 重置 quiet-period timer，但受 `maxDelayMs` 限制；
- timer 到期：
  - `running` → 保持 dirty，当前轮结束后再调度；
  - 空闲 → 启动同步；
- 成功后 `dirty = false`；
- 失败指数退避：5s → 15s → 60s，保留 dirty；
- 结束后若 dirty 重新为 true，立即安排下一轮。

### 5.4 周期对账兜底

全局定时器（默认 5 分钟）：

- 对每个已监听仓库执行 `scanStatus`；
- 有 changed/removed 且未在运行 → 标记 dirty；
- 覆盖 `fs.watch` 漏事件、睡眠唤醒、网络盘/虚拟机文件系统事件丢失。

### 5.5 跨进程锁

索引目录旁 `.auto-sync.lock`：

```json
{ "pid": 1234, "startedAt": 0, "heartbeatAt": 0 }
```

- `open(..., 'wx')` 获取；
- 已存在且未过期 → 自动同步跳过；
- 每 30 秒 heartbeat；
- 默认 TTL 15 分钟；
- 手动 `code_index` 也走同一把锁；
- 同进程 `watchers` Map 已去重。

### 5.6 配置

```yaml
advanced:
  sync:
    watch: true
    debounceMs: 5000
    maxDelayMs: 30000
    reconcileMs: 300000
    lockTtlMs: 900000
```

校验：

- `debounceMs >= 1000`
- `maxDelayMs >= debounceMs`
- `reconcileMs >= 60000`
- `lockTtlMs >= 60000`

默认 `watch: true` 只作用于已经建过索引的仓库；未建索引目录不会自动全量建库。

### 5.7 状态

`code_index_status` 增加：

```json
{
  "autoSync": {
    "enabled": true,
    "watching": 3,
    "running": 1,
    "dirty": 0,
    "lastSyncAt": "...",
    "lastEventAt": "...",
    "lastError": null
  }
}
```

### 5.8 P1 测试

新增 `test-auto-sync.mjs`：

- registry 原子读写、清理；
- 调度器：quiet period、maxDelay、运行中 dirty 重跑；
- 失败退避与恢复；
- 锁：已存在跳过、过期接管、heartbeat；
- 临时目录 `fs.watch` 集成（不支持时 skip）；
- DSH 启动恢复监听（mock）；
- `sync.watch=false` 行为不变。

---

## 六、P2：团队共享现状收口（0.5 天）

### 6.1 已有机制

服务端：

```text
lineage_id = hash(归一化 git remote URL)
blobs/vectors 按 (lineage_id, tag, 内容 hash) 存
```

同一 remote 的不同开发者、不同 clone、不同分支/作用域已经自动共享正文和向量；第二个 clone 实测缺向量 0 块。

### 6.2 本轮只补可观测性与配置

- `code_index_status` 增加：
  - `lineage`
  - `server`
  - `shared`（是否命中已有 lineage）
  - `vectorsReused`（本轮同步服务端已有向量的块数）
- README 明确“同一 remote 自动共享，不依赖 simhash”；
- 服务端 selftest 补“同 lineage 不同 namespace 0 重嵌”断言；
- 新增配置：

```yaml
remote:
  reuse: suggest   # off | suggest | auto
```

### 6.3 单团队假设

当前是单团队自托管服务：

- 所有 API key 视为同一团队；
- 候选查询只在这个服务内；
- 多团队 ACL 不在本计划内；未来需要时给 `api_keys` / `lineages` 加 `team` 字段并在候选查询中过滤。

---

## 七、P3：simhash 候选 + 精确哈希 adopt（2.5 天）

### 7.1 Cursor 的 simhash 复用机制

根据 [Cursor 博客](https://cursor.com/blog/secure-codebase-indexing)：

1. 客户端构建 Merkle 树；
2. 从树派生一个 simhash，概括文件内容哈希集合；
3. 上传 simhash；
4. 服务端把它当向量，在同团队/同用户的 simhash 库里找近邻；
5. 距离过阈值 → 用该 index 作为新代码库初始索引；
6. 后台复制，复制期间先查旧 index；
7. 上传完整 Merkle 树作为 content proofs，搜索结果只返回客户端能证明拥有的文件；
8. 根哈希一致后删除 proofs。

核心是**整份索引复用**，不是 chunk 级缓存。

### 7.2 我们的实现策略

不做整份 copy，做：

```text
文件 manifest
  → 两种 simhash（path-aware / content-only）
  → 服务端 Hamming 候选
  → 目标 chunks ∩ 候选 vectors 精确重叠
  → 只复制重叠 hash 的 blobs/vectors
  → 目标继续自己的 manifest / chunks / 搜索
```

原因：

- 同一 lineage 已经自动共享，不需要 simhash；
- 跨 lineage 只复制内容哈希相同的块，路径/行号不会污染目标；
- 不需要 `COPY_IN_PROGRESS` 状态机；
- 不需要 Merkle content proof：目标只索引自己的 chunks，候选独有文件不会出现在目标 namespace。

### 7.3 simhash 算法

新增 `plugins/dsh-code-index/lib/simhash.js`：

- 64 位，输出 16 位 hex；
- 文件按 `rel` 排序，保证确定性；
- 每个文件特征：
  - path-aware：`sha256(rel + "\0" + contentSha)`
  - content-only：`sha256(contentSha)`
- 权重：`min(16, log2(1 + size))`；
- 每 bit 累加正/负权重，`score >= 0` 为 1；
- 记录算法版本、文件数、生成时间。

算法版本变化时旧 simhash 不参与候选。

### 7.4 客户端同步

`syncRemote` payload 增加：

```json
{
  "simhash": {
    "v": 1,
    "path": "…",
    "content": "…",
    "files": 2088
  }
}
```

旧服务端忽略未知字段。

### 7.5 服务端 schema

`repos` 增加幂等 migration 列：

```sql
simhash_path text;
simhash_content text;
simhash_algo text;
simhash_files integer;
simhash_at integer;
```

每次 sync 更新；按 `updated_at` 取每个 lineage 最新记录。

### 7.6 候选查询

服务端方法：

```python
similar_lineages(simhash_path, simhash_content, exclude_lineage, tag, limit=5)
```

- 扫描近期有 simhash 的 repo 行；
- 计算两个变体的 Hamming 距离，取较高相似度；
- 过滤：
  - 同团队（当前单团队部署）；
  - 同 embedding tag；
  - 不是目标 lineage；
  - 目标 lineage 还没有向量；
  - 相似度 ≥ 阈值；
- 返回 lineage / namespace / repoName / distance / updatedAt。

诊断接口：

```http
GET /v1/lineages/similar?path=...&content=...&tag=...&limit=5
```

只返回元信息，不返回正文。

### 7.7 精确重叠门槛

不直接信 simhash，对候选计算：

```text
目标 namespace 的 chunks
∩ 候选 lineage 当前 tag 的 vectors
/ 目标 chunks 总数
```

只有 ≥ `ADOPT_MIN_OVERLAP` 才复制。

### 7.8 复制规则

只复制：

- `blobs(lineage_id, hash, body)`；
- `vectors(lineage_id, tag, hash, dim, v)`。

且 `hash` 必须同时满足：

- 在目标 namespace chunks 中；
- 在候选 lineage 的 blobs + vectors 中；
- 使用当前 embedding tag。

绝不复制：

- 候选 chunks；
- 候选 path/行号；
- 候选旧 tag 向量；
- 候选 repos 行。

结果：目标 `missing` 自动减少，只嵌入真正新增的块。

### 7.9 接入 sync

在 `IndexStore.sync()`：

1. 写入目标 chunks；
2. 首次 full sync 且 `reuse != off`：
   - 查询候选；
   - 计算 overlap；
   - `adopt_hashes(target_lineage, candidate_lineage, hashes, tag)`；
3. 再计算 `_missing`；
4. 返回：

```json
{
  "adopted": {
    "fromLineage": "...",
    "fromRepo": "...",
    "similarity": 0.93,
    "overlap": 0.87,
    "blobs": 1200,
    "vectors": 1200
  }
}
```

客户端输出：

```text
从相似索引复用 1200 块，只需嵌入 37 块（来源 lineage …，相似度 0.93，重叠 0.87）
```

### 7.10 配置与默认值

```yaml
remote:
  reuse: suggest   # off | suggest | auto
```

- `off`：不查候选；
- `suggest`：返回候选，不复制（默认）；
- `auto`：达到阈值自动复制。

阈值常量（Phase 0 测量后定稿，初始值）：

- `SIMHASH_MIN_SIMILARITY = 0.85`
- `ADOPT_MIN_OVERLAP = 0.80`
- `MAX_ADOPT_CANDIDATES = 5`
- `MAX_ADOPT_HASHES = 50000`
- `MAX_ADOPT_BYTES = 512 MB`

### 7.11 安全边界

- 候选只在同一服务/团队内可见；
- 只复制目标 manifest 已有的 hash；
- 目标搜索只查自己的 namespace；
- 不复制候选 chunks，候选独有文件不会出现在目标结果；
- 多团队 ACL 不在本轮；未来加 `team` 字段和候选过滤；
- 如果以后做整份 index copy，再补 Cursor 式 content proof。

### 7.12 P3 测试

客户端：

- simhash 确定性；
- 相同文件集距离 0；
- 少量修改距离小；
- 无关仓库距离大；
- 路径变化但内容相同：content 变体近、path 变体远；
- 空仓库、重复内容、超大文件权重。

服务端 `selftest.py`：

- migration 旧库可读；
- simhash 存取；
- 候选阈值/过滤；
- overlap 计算；
- 只复制精确 hash + 当前 tag；
- 不复制 chunks；
- 候选独有文件搜索不可见；
- tag 不一致不 adopt；
- `reuse=off` 不查询；
- 上限截断。

集成：

- 仓库 A 建索引；
- 仓库 B 复制 95% 内容，不同 lineage；
- B 首次 sync 返回 adopt，missing 只含 5% 变更；
- 搜索结果不串库；
- 关闭 reuse 后 B 全量嵌入。

---

## 八、公开 API / Schema / 配置变更

| 层 | 变更 | 兼容性 |
|---|---|---|
| `advanced.scan` | `respectIgnoreFiles`、`ignoreFiles`、`hierarchicalGitignore`、`hierarchicalCursorIgnore`、`include`、`binarySniff` | 新增；默认只增加 ignore 支持 |
| `advanced.sync` | `watch/debounceMs/maxDelayMs/reconcileMs/lockTtlMs` | 新增；默认监听已索引仓库 |
| `remote.reuse` | `off/suggest/auto` | 新增；默认 `suggest` |
| `sync` payload | 可选 `simhash` | 旧服务端忽略 |
| `code_index_status` | `scan`、`autoSync`、`adopted` | 追加字段 |
| 服务端 `repos` | 5 个 simhash 列 | 幂等 migration，只增 |
| 服务端接口 | `GET /v1/lineages/similar` | 新增 |
| 现有 `adopt` | 增加 tag/hash 过滤与报告 | 兼容旧调用 |
| 版本 | 插件 `0.12.0` / 服务端新镜像 | 可回滚 |

---

## 九、测试与门禁

### 9.1 新增/更新测试

- `test-ignore.mjs`：ignore、docs、禁用模块、二进制；
- `test-auto-sync.mjs`：registry、scheduler、lock、reconcile；
- `test-simhash.mjs`：算法、距离、确定性；
- `test.mjs`：扫描排除、ignore 变更、removed；
- `test-plugin.mjs`：配置 schema、工具输出、autoSync 字段；
- `test-remote.mjs`：sync payload、adopt 报告；
- 服务端 `selftest.py`：simhash schema、候选、adopt、隔离、tag；
- 集成：两个临时仓库 + fake embedding 服务。

### 9.2 门禁

- `pnpm test`（插件）；
- 服务端 `python selftest.py`；
- `yaml + manifests` / 插件市场索引检查；
- 现有 CI 不变；
- 新增依赖后确认安装无 `pendingBuilds`。

---

## 十、验收标准

### 10.1 扫描边界

- `.gitignore` 中的文件不再索引；
- `.cursorignore` 中的文件不再索引；
- `.md` 会索引，`.docx`/`.pdf` 不索引；
- business 5.0 禁用 Groovy 模块默认仍索引；加 ignore/exclude 后完全消失；
- 修改 ignore 文件后，下一次刷新能删除旧 chunks；
- `code_index_status` 能显示 ignored 数量和来源；
- `respectIgnoreFiles=false` 时恢复旧行为。

### 10.2 自动 freshness

- 已索引仓库保存文件 ≤ 10 秒内刷新；
- 同步中连续修改不丢事件；
- DSH 重启后自动恢复监听；
- 多 DSH 进程同一仓库只有一把锁；
- 删除/重命名清理正确；
- watcher 不支持时由周期对账兜底。

### 10.3 团队共享 / adopt

- 同 lineage 第二 clone：0 新嵌入、0 正文重复上传；
- 跨 lineage 95% 重叠：≥ 80% 块复用，只嵌入 delta；
- 候选独有文件不出现在目标结果；
- 模型 tag 不一致 / `reuse=off` / 低相似度：0 复制；
- adopt 失败不影响目标本地索引。

### 10.4 性能

- 200 个仓库启动挂 watcher < 100ms；
- 空闲周期对账毫秒级/仓库；
- 1000 个候选 lineage 的 simhash 查询 < 50ms；
- 10000 hash adopt < 200ms。

---

## 十一、实施顺序与回滚

1. **P0**：ignore + docs + 禁用模块 + 测试；这是后续 watcher 正确性的基础。
2. **P1**：自动 freshness；先 `watch=true` + `reuse=off` 灰度。
3. **P2**：团队共享状态 + `reuse=suggest`。
4. **P3**：simhash schema/候选/adopt；先 `suggest` 验证，再按团队策略切 `auto`。
5. **P4**：E2E、README、COMPARISON-CURSOR 更新、发布。

回滚：

- `respectIgnoreFiles: false` 恢复旧扫描行为；
- `sync.watch: false` 停 watcher；
- `remote.reuse: off` 停候选/复制；
- 服务端 schema 只增不删，旧客户端继续工作。

---

## 十二、明确不做

- 不解析 `settings.gradle` / Maven / 构建 profile，不自动判断“模块是否启用”；
- 不索引 PDF/Office 二进制文档；
- 不做 Cursor 式 Merkle 同步协议、整份 index copy、content proof；
- 不自动对未建过索引的目录做首次全量索引；
- 不做多团队 ACL；
- 不在本计划内切换 bge-m3 或重做中文 embedding；中文 query 仍按 0.11.9 的 agent 翻译/中英混合建议处理。

---

## 十三、相关文件

- `plugins/dsh-code-index/index.js`：配置、工具、watcher、状态
- `plugins/dsh-code-index/lib/scan.js`：文件扫描与增量
- `plugins/dsh-code-index/lib/strategies.js`：扩展名/切块策略
- `plugins/dsh-code-index/lib/indexer.js`：建库、远端 sync
- `plugins/dsh-code-index/lib/remote.js`：远端 API
- `plugins/dsh-code-index/lib/ignore.js`（新增）
- `plugins/dsh-code-index/lib/repo-registry.js`（新增）
- `plugins/dsh-code-index/lib/auto-sync.js`（新增）
- `plugins/dsh-code-index/lib/simhash.js`（新增）
- `server/code-index-service/index_store.py`：schema/sync/adopt
- `server/code-index-service/server.py`：接口
- `server/code-index-service/selftest.py`：服务端测试
- `plugins/dsh-code-index/COMPARISON-CURSOR.md`：需要同步更新（当前 0.4–0.8 口径，已过时）
