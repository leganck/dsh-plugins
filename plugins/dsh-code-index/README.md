# @local/dsh-code-index

DSH 插件：**本地代码库混合检索**。纯 JavaScript，无 Python。

给 agent 四个工具：

| 工具 | 作用 | 并发 |
|---|---|---|
| `code_index` | 建库 / 增量刷新（SQLite：FTS5 全文 + 可选向量） | 串行（写） |
| `code_search` | 混合检索：BM25 + 向量 → RRF → 「文件:行 + 片段」 | ✅ 可并行 |
| `code_index_status` | 覆盖情况与新鲜度（文件/块/向量、待更新数量） | ✅ 可并行 |
| `code_index_deps` | 可选依赖的按需安装/修剪（`embed` / `parser` 两组），默认只报状态 | 串行 |

## 为什么用它（本机实测口径）

40 个真实检索事件、14 个仓库、同一批 grep 基线：

| 通道 | hit@10 |
|---|---|
| grep 循环（4 KB 预算） | 10% |
| 纯 FTS5（BM25） | 32.5% |
| 纯向量 | 37.5% |
| **混合（RRF k=20）** | **55%** |

成本（实测）：

| 环节 | 数字 |
|---|---|
| 建 FTS5 索引 | 亚秒级/仓库（1986 文件 0.84 s） |
| 补向量 | GPU(fp16/DirectML) **约 47 块/s**，CPU 占用 0.25 核；erp-pos 13,889 块 ≈ 4.7 分钟 |
| 增量刷新 | 未变时 2 ms 级（mtime+size 快扫）；只重算变化块 |
| 查询 | FTS5 1 ms + 查询嵌入 ~10 ms + kNN ~1 ms |
| 向量缓存 | 与独立实验版**共用** `~/.dsh/index/vectors.db`（key = `模型标签:sha256(块文本)`） |

## 典型用法

```
code_index(path="D:/Code/your-repo")                       # 建库：只做全文索引，秒级完成
code_search(query="退款超单校验在哪里做的")            # 关键词检索，默认返回 10 条
code_index_status()                                  # 看覆盖、新鲜度、向量完成度

# 想要语义检索（可选，重负载）：显式给预算，分批跑
code_index(path="D:/Code/your-repo", max_embed=500)         # 本轮最多补算 500 块向量
code_index(path="D:/Code/your-repo", max_embed=500)         # 再跑，接着补（可续算）
code_search(query="订单状态机的实现在哪")               # 向量补齐后自动变成 hybrid
```

> ⚠️ **向量补算是重负载**：实测 GPU 约 47 块/s，而它抢占的正是驱动显示的那块显卡——
> 8227 块曾把整机卡住数分钟（2026-10-16 实测）。所以**默认不自动补算**（`maxEmbedPerRun: 0`），
> 要向量必须显式传 `max_embed`，建议每次 500~2000 块。没有向量时检索依然可用，
> 只是退化为纯关键词——`code_search` 会明确告诉你原因与补算方法，不会误报成"配置关了向量"。

`code_search` 输出形如：

```
命中 5 条（通道 hybrid；词项 refundOverLimit / 退款超限）
[1] src/main/java/.../AbnormalPayMapper.java:81-120  (fts 1 / vec 4)
    ...片段...
```

`fts`/`vec` 两列分别是该条在两路里的排名，便于排查"为什么它排第一"。

## 设计要点（每条都有实测依据）

1. **不做 Merkle 树**。实测全量遍历只要 120 ms（2088 文件），Merkle 的价值（十万级文件 + 跨网）在这里不存在。改用两级指纹：`mtime+size` 快扫 → 变了才读文件算 sha256。
2. **块内容哈希是跨版本复用的钥匙**。同一段代码在你的 5 个 crm 版本里内容相同 → 同一哈希 → 向量缓存直接命中。
3. **切块策略可配置（默认按文件类型查表）**。对应 Cursor 的 `GetAvailableChunkingStrategies`：
   内置策略表 + 配置覆盖 + 依赖缺失自动降级。语法包覆盖 java / javascript / typescript(+tsx) / **groovy**。
   实测"块首行落在成员内部"（=从方法中间开始）：
   `window` 29.4% → `heuristic`（纯 JS，零依赖）7.5% → **`ast`（tree-sitter）0.1%**
   （`saas`，8,777 个 Java 文件）；Grails 的 Groovy（144 文件）`heuristic` 31.6% → **`ast` 7.5%**。
   详见 INSTALL.md §2'。
4. **依赖可选、优雅降级**。缺 `onnxruntime-node` / 缺模型文件 → 自动退化为纯 FTS5，并在结果里说明原因，不会让插件加载失败。
5. **GPU 批量的坑已处理**。DirectML 在 batch 8~16 最快，32 会掉到 10.8 块/s、更大直接崩 → 失败自动减半拆批，单条仍失败才回退 CPU。
6. **截断策略对齐**。transformers.js 截断时把 512 位全填内容 token，Rust `tokenizers` 会给结尾 `[SEP]` 留位 —— 差 1 个 token 会让向量与 Python 版不一致（余弦 0.9986 → 0.999999）。已在推理层对齐。
7. **索引不落在代码仓库里**。`indexDirBase` 下按「仓库名-路径哈希」分目录，不会污染 `git status`。
8. **roots 白名单**。不在白名单内的路径直接拒绝，**且在创建索引库之前校验**。

## 配置

```yaml
- id: code-index
  name: "@local/dsh-code-index"          # 官方 tarball 安装后模块名=包名
  config:
    indexDirBase: "C:/Users/you/.dsh/code-index"   # 每仓库一个库；不配则用 <repo>/.dsh-index
    roots: ["D:/Code"]                                  # 安全白名单；空 = 允许任意路径
    windowLines: 40                                     # window 策略的窗口行数
    chunking:
      strategy: "auto"                                  # auto | ast | heuristic | window
      byExt: {}                                         # 按扩展名覆盖策略表，如 {".vue": {"strategy": "heuristic"}}
    maxFileBytes: 2097152                               # 单文件上限（默认 2 MB）
    excludeDirs: []                                     # 排除目录**名**（任意深度），与内置默认合并
    excludePaths: []                                    # 排除**仓库相对路径**前缀；遗留/生成物目录用这个
    defaultTopK: 10
    maxEmbedPerRun: 0                                   # 默认 0 = 建库不补算向量；>0 才自动补算（重负载，见上）
    embedding:
      backend: "auto"                                   # auto | cpu | gpu | off
      modelDir: "C:/Users/you/.dsh/models/bge-small-zh-v1.5"
      threads: 6
      cachePath: null                                   # 默认 ~/.dsh/index/vectors.db（与实验版共用）
      depsDir: null                                     # 默认 %LOCALAPPDATA%/dsh-code-index/embed-deps
```

### `excludeDirs` vs `excludePaths`：两种排除，别混用

真实踩过的坑（0/4 → 2/4 那次）：一个 Java 仓库里同时存在

| 目录 | 文件数 | 性质 |
|---|---|---|
| `legacy-grails-service/` | 1034 | **遗留 Grails**（GSP/taglib，里面全是中文界面文案） |
| `billing-service/` | 117 | 现役 Java 模块 |

两者**只差 `svc-`**。遗留目录被一起索引后，占掉了 85% 的块，而**中文界面文案与任意中文提问都有中等相似度** →
纯自然语言的中文提问，正确答案被整体挤出前列（实测 4 题命中 **0/4**）。
排除它之后：**2/4**，且 4 题的正确答案全部回到前 40 名候选内（第 1 / 7 / 6 / 2 名）——
**剩下的是排序问题，不是召回问题**，那属于 reranker 的活。

```yaml
    # ① 按"目录名"排除：任意深度都排掉（会误伤别处同名目录），与内置默认**合并**
    excludeDirs: ["legacy-web"]

    # ② 按"仓库相对路径"排除：只排这一个（推荐用于遗留/生成物目录）
    excludePaths: ["legacy-grails-service", "docs/2-technical"]
```

- **改完不用全量重建**：被排除的文件在下次 `code_index` 时走 `diffFiles` 的 `removed` 分支，
  连同它的块、FTS 行、向量一起删掉（实测：`removed=1`、`mode=incremental`）。
- **`code_index_status` 共用同一份排除规则**（否则会把已排除文件永远报成"过期"），
  并在输出里显示 `已排除：…` 供确认。
- 排除**单个文件**也可以（`excludePaths: ["src/Legacy.java"]`）。

## 文件结构

```
index.js              插件入口：apply(ctx, config) + 四个工具定义 + 加载标记
lib/store.js          SQLite schema（files / chunks / chunks_fts / vectors / meta）
lib/strategies.js     切块策略表（扩展名 → ast|heuristic|window）+ 配置覆盖解析
lib/chunker.js        策略分发：ast → heuristic → window 降级链 + 固定窗口实现
lib/chunk-ast.js      tree-sitter AST 切块（含 bufferSize 与 setLanguage 两个坑的处理）
lib/chunk-heuristic.js 纯 JS 语法感知切块（括号深度 + 成员边界，零依赖）
lib/hash.js           块内容哈希（单独成模块以避免循环依赖）
lib/deps.js           依赖按需安装：embed / parser 两组、受管目录、修剪、解析器链
lib/scan.js           仓库遍历、扩展名/目录过滤、两级指纹增量判定
lib/query.js          查询 → 词项抽取（标识符 / 数字串 / 中文 n 元组）→ FTS5 MATCH
lib/search.js         FTS5 + 向量 kNN → RRF 融合（k=20）
lib/indexer.js        建库/增量编排（含向量补算、断点续跑、策略指纹强制重建）
lib/embedder.js       可选嵌入层（onnxruntime-node + DirectML + 共享向量缓存）
test.mjs              核心自测：建库/检索/增量/删除/降级/依赖层/切块策略（88 项）
test-plugin.mjs       插件接口自测：注册面/错误路径/四工具真实调用（56 项）
verify-install.mjs    装后验证：从已安装包跑通模块加载、工具注册、依赖解析（16 项）
tools/fetch-model.mjs 模型下载器（**默认走 ModelScope**；逐文件校验 HTTP/字节数/下限，绝不把 0 字节当成功）
tools/migrate-embedding-tag.mjs  升级 0.4.6 后一次性迁移历史向量缓存的 key 前缀
tools/ab-embedding-models.mjs  嵌入模型对照（同一批块+同一批问题只换模型；--reuse 零成本重排）
tools/rerank-eval.mjs          重排评测（固定候选池上量交叉编码器的净收益与延迟）
tools/cases/oss-mall-30.json   103 题中文自然语言题库（每题含期望文件与依据，均已核验）
```

## 测试

```console
node test.mjs --repo D:\Code\your-repo                                        # 核心：88/88
node test-plugin.mjs --no-embed --repo D:\Code\your-repo                      # 契约与接口：56/56
node verify-install.mjs                                                  # 装后验证（对已安装的包跑）

# 避免重负载：加 --model-dir D:\nonexistent-model 即"模型关闭"路径
# 切块策略的真实仓库 A/B（真值来自语法树）：
node <workspace>/dsh-comparison/strategy-ab.mjs D:\Code\demo\svc\saas
```

## 按官方 skill 的合规性（cordis-plugin-development）

DSH 自带技能 `cordis-plugin-development`（位于 asar 内 `dsh-agent-preset/skills/`）规定了插件契约。
本包逐条对照如下，可执行断言都在 `test-plugin.mjs` 的 `[0] bundle 契约` 段里：

| 要求 | 本包做法 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | ✅ `./cordis.patch.yml` |
| 包内补丁插入插件行，`name` 用**包名** | ✅ `name: '@local/dsh-code-index'` |
| `export function apply(ctx, config)` | ✅ 单一导出形式，不混用 |
| 服务依赖必须声明 | ✅ `export const inject = ['tools']` |
| 导出 `name` | ✅ `code-index` |
| 注册用 `ctx.effect` 并返回清理 | ✅ 三个工具注册在一个带标签的 effect 里，卸载即回收 |
| 显示元数据 + 图标 | ✅ `locale/{zh,en}.json` 的 `meta.title/description` + `icon.svg` |
| `exports` / `files` 白名单 | ✅ 含 `./package.json`、`./locale/*.json` |
| 不要 import `@deepseek-ai/*` 值 | ✅ 源码零 DSH 内部导入（有断言守着） |
| 配置放 `Config` 以便用户在补丁层改 | ⚠️ **故意不导出 Schemastery `Config`**，理由见下 |

### 两个刻意的设计取舍

**① 不导出 Schemastery `Config`。** 同 `dsh-ops` 的选择：宿主这一半必须做到不 import 任何
`@deepseek-ai/*` 值——那些名字由 profile 加载器提供，每多一个就多一条让插件加载失败的路。
本插件就曾因缺少 `inject` 而**整行静默不生效**（见下）。改为显式校验并大声失败：
键名写错/取值非法时抛出 `ConfigError`，指明是哪个键、允许什么。

**② 加载记录仪。** `~/.dsh/code-index/_boot.log` 记录模块导入、`apply()` 进入/结束/抛错
（含堆栈）。这不是装饰：插件的失败模式是"什么都不发生"，而应用的报错去向不可靠
（宿主 stdout 无人接收、日志目录为空）。这套记录仪上线后**第一次重启就抓到了根因**：
`cannot get property "tools" without inject`。

## 已知边界

1. **中文中间词命中依赖向量通道**。FTS5 的 unicode61 分词会把连续中文切成一个整词（`退款超限校验` 是一个 token），所以中文词项用前缀查询只能命中开头；中间词要靠向量补。
2. **切块边界质量取决于策略**。默认按文件类型查表：`.java/.js/.ts/.tsx` → `ast`（需按需装 `parser` 组），
   `.vue/.xml/.sql/.md` 等 → `window`，其它 → `heuristic`。换策略会**自动全量重建**索引（见 INSTALL.md §2'）。
3. **依赖体积**：`embed` 组 661 MB → 修剪后 264 MB；`parser` 组 41 MB。两者都**按需安装**，装插件本身只 50 KB。
4. **需要 Node ≥ 22.19 或 ≥ 24**（`node:sqlite` 免 flag 可用）。
5. **@1 精度**：实测 RRF 在 rank 1 上不如纯通道（向量 18% > FTS5 15% > RRF 5%），所以默认返回 top-10；若你要"最可能的那一个"，用 `mode="vector"`。
6. 改动插件代码后**需要重启 app**：cordis 不会重新 import 已加载的模块，配置热加载只对已存在的行生效。
