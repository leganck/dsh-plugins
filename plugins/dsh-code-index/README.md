# @local/dsh-code-index

DSH 插件：**本地代码库混合检索**。纯 JavaScript，无 Python。

给 agent 五个工具：

| 工具 | 作用 | 并发 |
|---|---|---|
| `code_index` | 建库 / 增量刷新（SQLite：FTS5 全文 + 可选向量） | 串行（写） |
| `code_search` | 混合检索：BM25 + 向量 → RRF → 「文件:行 + 片段」 | ✅ 可并行 |
| `code_index_status` | 覆盖情况与新鲜度（文件/块/向量、待更新数量） | ✅ 可并行 |
| `code_map` | 目录地图：每个目录的文件数/语言/块数/代表符号，冷启动定位用 | ✅ 可并行 |
| `code_index_deps` | 可选依赖的按需安装/修剪（只剩 tree-sitter 语法组，按语言装），默认只报状态 | 串行 |

## 为什么用它（本机实测口径）

40 个真实检索事件、14 个仓库、同一批 grep 基线：

| 通道 | hit@10 |
|---|---|
| grep 循环（4 KB 预算） | 10% |
| 纯 FTS5（BM25） | 32.5% |
| 纯向量 | 37.5% |
| **混合（RRF k=20）** | **55%** |

成本（实测；**0.10.0 起本地模型已移除**，涉及嵌入的行都是 0.9 及更早的本机口径，现在由服务端承担）：

| 环节 | 数字 |
|---|---|
| 建 FTS5 索引（本地） | 亚秒级/仓库（1986 文件 0.84 s） |
| 增量刷新（本地） | 未变时 2 ms 级（mtime+size 快扫）；只重算变化块 |
| 纯关键词查询（本地） | FTS5 1 ms 级，零模型、零网络 |
| 远端查询嵌入 | 7.4–15.8 ms（局域网 / NAS P4 实测） |
| 远端建库（补向量） | 本机 B300 33.05 块/s；NAS P4 26.8 块/s（限速可调） |
| 向量复用 | 按**内容哈希**在血统（git origin）内去重；同仓库第二个克隆 **0 块新嵌入** |
| 历史口径（0.9 及更早，本机模型） | GPU fp16/DirectML 约 47 块/s、CPU 0.25 核、erp-pos 13,889 块 ≈ 4.7 分钟 |

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

> ⚠️ **向量补算是重负载**：现在由服务端算（NAS P4 实测约 26.8 块/s，限速 `advanced.remoteRateLimit`
> 就是"别打满 GPU"的开关；0.9 及更早是本机 47 块/s，8227 块曾把整机卡住数分钟）。
> 所以**默认不自动补算**（没有 `maxEmbedPerRun`；只由调用方显式给 `max_embed`），
> 建议每次 500~2000 块、分批续算。没有向量时检索依然可用，
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
3. **切块能力也是指纹的一部分**（0.8.1 起）。装了 tree-sitter 之后同一文件会切出**不同边界**；
   只哈希配置（`strategy:'auto'`）会让库里/服务端同一命名空间混进"旧 heuristic 块 + 新 ast 块"，
   且没有任何信号。现在的指纹 = 配置 + **本仓库实际用到且确实加载成功的语法**：

   - 只算"本仓库有对应扩展名"的语法 → 给 Go 仓库装 tree-sitter **不会**平白换命名空间；
   - 换命名空间不等于全量重嵌：向量按**内容哈希**在血统内去重，实测 energy 切块能力变化后
     命名空间换了，1501 块里只有 **5 块**需要重嵌（其余正文没变，直接命中老向量）；
   - `code_index_deps install group=parser` 装完会清解析器缓存，**当次会话立即生效**；
     本机之外手动 npm 安装的则需要重启进程。
4. **远端不可用时优雅降级**。连不上服务端 → 查询自动退化为纯 FTS5、建库仍完成本地索引，原因写进结果，不会让插件加载失败。
5. **远端失败有冷却**。连接失败后 60 s 内不再重试（避免每次查询都等满超时），冷却后自动恢复。
6. **本地零重依赖**。本地不需要 onnxruntime / transformers / 模型文件；唯一可选依赖是 parser 组（AST 切块，实测展开 60.7 MB）。
7. **索引不落在代码仓库里**。`advanced.indexDirBase` 下按「仓库名-路径哈希」分目录；不配则退回 `<repo>/.dsh-index/`（记得加进 `.gitignore`）。
8. **roots 白名单**。不在白名单内的路径直接拒绝，**且在创建索引库之前校验**。

## 配置

### 在 DSH 里配置（0.11.5+）

装好插件并重启 DSH 后，打开 **插件 → 内置插件配置 → 代码索引**，可以直接改：

- **主设置**：远端地址 `remote.url`、API Key `remote.apiKey`（只写，不回显）
- **高级设置**：向量模式 `vectors`、重排模式 `rerank`、本地索引目录 `advanced.indexDirBase`

远端地址 + API Key 是接远端服务的全部必填项：`vectors` 默认 `auto`，有地址就自动走远端。
`roots` 白名单、限速、超时、`exclude`、`chunking`、`sync` 等仍只通过下面的 YAML 配置；
设置页保存时不会清空这些未展示字段。

索引目录不是远端检索的必填项：留空时每个仓库用自己的 `.dsh-index/index.db`；改它只影响
本地 SQLite 的位置，远端向量/重排仍走 `remote.url`。设置页保存后如果 `roots` 或索引目录变了，
重新运行一次 `code_index` 重建本地索引。

```yaml
- id: code-index
  name: "@local/dsh-code-index"          # 插件源 / install_bundle 安装后，模块名 = 包名
  config:
    # —— 用户只需要这几个 ——
    roots: ["D:/Code"]                    # 安全白名单；空 = 允许任意路径
    remote:
      url: "https://dsh-embed.example.com"   # 向量服务（/embed + /v1 索引 + /rerank）
      apiKey: null                        # 服务端设了 API_KEY 才需要
      namespace: null                     # 显式写作用域命名空间（优先级最高；一般不用写）
      scope:                              # 未给 namespace 时按规范推导快照（0.11.0，可省略）
        kind: "branch"                    # main | branch | pr | worktree
        ref: "feat/x"                     # 分支名 / PR 号 / 工作树标识（main 可省）
        ttlDays: 14                       # 可选；不写由服务端按 kind 的默认 TTL 决定
      readScopes: []                      # 额外**读取**的命名空间（如主干），只读、不写入
    vectors: "auto"                       # auto（默认：有 remote.url 即走远端）| remote | off（纯关键词）
    rerank: "off"                         # off | fast（top-10）| quality（top-20），远端重排
    exclude: []                           # 目录名，或含 "/" 的仓库相对路径前缀

    # —— 以下都是 advanced（不写全用默认）——
    advanced:
      indexDirBase: "C:/Users/you/.dsh/code-index"   # 每仓库一个库；不配则用 <repo>/.dsh-index
      maxFileBytes: 2097152               # 单文件上限（默认 2 MB）
      windowLines: 40                     # window 策略的窗口行数
      depsDir: null                       # parser 依赖的受管目录
      chunking:
        strategy: "auto"                  # auto | ast | heuristic | window
        byExt: {}                         # 按扩展名覆盖策略表，如 {".vue": {"strategy": "heuristic"}}
      sync:
        watch: false                      # fs.watch 自动增量（默认关）
        debounceMs: 30000
      remoteTimeoutMs: 8000
      remoteRateLimit: null               # 服务端嵌入限速（块/秒）
```

> **0.10.0 remote-only**：本地嵌入/本地重排已移除，向量与重排都走 `remote.url`；
> 不连服务端时用 `vectors: off` 做纯关键词检索（本地 FTS5，不需要任何模型）。
> 旧配置（`embedding`、`vectorStore`、`preset`、`rerankBackend`、`excludeDirs/excludePaths`、
> 顶层 `indexDirBase/chunking/sync` 等）会**直接报错并给出迁移提示**，不会静默降级。
>
> **0.11.0（档 3）**：新增可选的 `remote.namespace` / `remote.scope` / `remote.readScopes`，
> 让 main / 分支 / PR / worktree 各写各的快照（见下节）。**不配这些键时行为与 0.10.x 完全一致**，
> 命名空间仍是 `<repoId>@<切块指纹>`，旧服务端/旧配置零迁移。

### 作用域（0.11.0）：main / 分支 / PR / worktree 各写各的快照

0.10.x 全仓库只有一个命名空间，切到另一个分支再建库就会**覆盖**上一个分支的远端索引
（内容层按哈希复用不会重嵌，但"这个快照包含哪些块"会被换掉）。0.11.0 用快照命名空间解决：

```
canonical_namespace(repoId, chunkFp, kind, ref) = "<repoId>@<chunkFp>#<kind>:<refToken>"

kind=main      -> refToken = "default"                      （ref 忽略；主干只有一份）
kind=branch    -> refToken = safe(ref) + "-" + sha1(ref)[:6] （safe：非法字符压成 "-"，空则 "x"）
kind=pr        -> refToken = str(int(ref))                  （ref 必须是纯数字）
kind=worktree  -> refToken = sha1(ref)[:8]                  （命名空间里写作 #wt:）
```

示例：`r1234@fp1#branch:feat-x-d6e256`、`r1234@fp1#pr:1234`、`r1234@fp1#main:default`。

**命名空间优先级**：`remote.namespace`（显式覆盖）> `remote.scope` 推导 > 旧默认 `<repoId>@<切块指纹>`。
`remote.namespace` 与 `remote.scope` 同时给时以 `namespace` 为准（`scope` 只用于展示）。

**多作用域读取**：分支上查询时，通常还想看主干已有的实现 —— 把主干的命名空间放进 `readScopes`，
`code_search` 会一次检索 `[写作用域, ...readScopes]`（去重保序），服务端结果再按内容哈希合并：

```yaml
remote:
  url: "https://dsh-embed.example.com"
  scope: { kind: branch, ref: "feat/refund-limit", ttlDays: 14 }
  readScopes:
    - "r1234@fp1#main:default"        # 主干快照（只读）
```

输出会显式标注作用域，命中项也可能带来源：

```
命中 8 条（通道 hybrid-remote；词项 refundOverLimit）
  作用域：写作用域 branch:feat/refund-limit（r1234@fp1#branch:feat-refund-limit-9c1f2a，TTL 14 天）；只读 1 个：r1234@fp1#main:default
[1] src/main/java/.../RefundLimit.java:81-120  (fts 1 / vec 2)
```

**向后兼容（旧服务端）**：多作用域请求发 `{namespaces:[{namespace},...]}`；旧服务端不认这个字段时
返回 400/404，客户端**自动回退成单作用域（写作用域）重试一次**，并在结果里写明"已退回单作用域"。
只有 1 个作用域时仍发旧协议 `{namespace}`，旧服务端零回归。

**TTL / 生命周期**：`ttlDays` 只是把意图发给服务端；实际到期时间与 `pinned` 以
`code_index_status` 里"远端作用域"一行为准（服务端按 kind 有默认 TTL：branch 30 天 / PR 14 天 /
worktree 1 天，main 永久；`legacy` 只可能是旧数据）。`remote.namespace` / `remote.scope` / `remote.readScopes`
都会记进加载标记 `_loaded.json`，重启后能确认"到底按哪个作用域在写"。

**0.11.4 起 `remote.scope` 默认就是 `auto`**：未配置也会按 git 分支推导（main/master → `#main:default`，
其余分支 → `#branch:<name>`；非 git 目录落到 `#main:default`），**不再写入 legacy 命名空间**
（`repoId@chunkFp`）。旧的 legacy 数据可在后台/`DELETE /v1/scopes/{ns}` 清掉，重新 `code_index` 即生成快照。

### 从 0.9 及更早迁移：旧键 → 新键

| 旧写法（≤0.9） | 现在怎么写（0.10.x） |
|---|---|
| `embedding.backend` / `embedding.modelDir` | 本地模型已移除；语义走 `vectors: remote` + `remote.url`，纯关键词用 `vectors: off` |
| `preset: basic`（旧开关） | `vectors: off` |
| `vectorStore: remote` | `vectors: remote`（配了 `remote.url` 时 `auto` 默认就是它） |
| `rerankBackend: remote` | 重排固定走远端，不用配置；只需 `rerank: fast \| quality` |
| `rerankRemote.url/apiKey` | 复用 `remote.url` / `remote.apiKey` |
| `rerankModelDir` | 本地重排已移除 |
| 顶层 `indexDirBase` | `advanced.indexDirBase` |
| 顶层 `maxFileBytes` / `windowLines` / `chunking` / `sync` | 全部移到 `advanced.*` |
| `excludeDirs` / `excludePaths` | 合并成 `exclude`（目录名，或含 `/` 的仓库相对路径） |
| `defaultTopK` | `code_search` 的 `top_k` 参数 |
| `maxEmbedPerRun` | `code_index` 的 `max_embed` 参数 |
| `indexDir` | `advanced.indexDirBase` |

### 从 0.10.x 升级（0.11.0）

**不用改配置**：不写 `remote.namespace` / `remote.scope` / `remote.readScopes` 时，命名空间与 0.10.x
完全相同（`<repoId>@<切块指纹>`），旧服务端照常同步/检索。
需要"多分支各存一份快照"时加 `remote.scope`；分支上还想检索主干已有实现时加 `readScopes`。
服务端可以灰度升级：新客户端对旧服务端会自动回退单作用域，旧客户端对新服务端行为不变。

### `exclude`：一种写法，两种语义

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
    # 目录名（任意深度，会误伤别处同名目录）—— 与内置默认合并
    exclude: ["legacy-web"]

    # 含 "/" 的仓库相对路径前缀（只排这一处，推荐用于遗留/生成物目录）
    exclude: ["legacy-grails-service", "docs/2-technical"]
```

- **改完不用全量重建**：被排除的文件在下次 `code_index` 时走 `diffFiles` 的 `removed` 分支，
  连同它的块、FTS 行、向量一起删掉（实测：`removed=1`、`mode=incremental`）。
- **`code_index_status` 共用同一份排除规则**（否则会把已排除文件永远报成"过期"），
  并在输出里显示 `已排除：…` 供确认。
- 排除**单个文件**也可以（`exclude: ["src/Legacy.java"]`）。

## 算力与远端（0.10.0 remote-only）

本地嵌入与本地重排已移除。向量和重排都交给 `remote.url` 指向的服务：

| 模式 | 配置 | 行为 |
|---|---|---|
| 远端语义检索（默认） | `vectors: remote` + `remote.url` | 本地 BM25 + 远端 kNN，客户端 RRF 融合；服务端挂了只丢语义召回 |
| 纯关键词 | `vectors: off` | 本地 FTS5/BM25，不连服务端、不加载任何模型 |
| 远端重排 | `rerank: fast \| quality` | 在候选集上做远端交叉编码器重排；不可用时不降级到本机，如实报告 |

服务端见仓库根目录 [`server/code-index-service/`](../../server/code-index-service/)（`/embed`、`/rerank`、`/v1` 索引层）。
三条硬规则（都有测试钉住，见 `test-remote.mjs`）：

1. **远端不可用绝不让检索失败** —— 向量通道降级为纯关键词、重排退回 RRF 顺序，原因写进结果。
2. **向量标签 `tag` 必须对得上**（服务端自述；对不上 ⇒ **不回退**，避免两种向量混进一个索引）。
3. **远端超时默认 8 s**（`advanced.remoteTimeoutMs`），只用来兜住"那台机器睡了"。

## 新目录的语言扩展提示（0.8.5）

`code_index` 第一次处理某个仓库时，会顺手算一件事：**这个仓库里有多少文件本可以按语法切块、
但当前缺语法包**。有就提示（每次建库都会提示；`chunking.parserHint: off` 可关）：

```
💡 有 454/470 个文件本可以按语法切块：.go × 454 个文件 → 缺 tree-sitter-go@0.21.2（约 2.6 MB）
   装 go：code_index_deps action=install group=parser-go（约 2.6 MB，不执行依赖脚本，装完当次生效）
   注意：装了会改变切块指纹 → 命名空间换新，但只有**正文真的变了**的块需要重嵌（内容哈希去重）
```

设计取向：**只提示，不自动装**。原生依赖几十 MB、且会改变切块指纹（→ 命名空间换新），
这属于"改变索引身份"的操作，必须由人决定。安装按语言分组，不会因为要 Go 就把 Python/Rust 一起拖下来：

| 组 | 包 | 体积 |
|---|---|---|
| `parser` | tree-sitter + java/javascript/typescript/groovy | 60.7 MB |
| `parser-go` | tree-sitter-go@0.21.2 | 2.7 MB |
| `parser-python` | tree-sitter-python@0.21.0 | 5.8 MB |
| `parser-rust` | tree-sitter-rust@0.21.0 | 10.8 MB |
| `parser-extra` | 上面三个 | ≈19 MB |

## 两种工作模式（0.10.0 remote-only）

| 模式 | 配置 | 行为 |
|---|---|---|
| 自动（默认） | `vectors: auto` | 配了 `remote.url` 就走远端；没配则纯关键词 |
| 强制远端 | `vectors: remote` | 缺 `remote.url` 直接报错 |
| 纯关键词 | `vectors: off` | 本地 FTS5/BM25，不连服务端、不加载任何模型 |

远端不可用时**自动切换**：查询/建库/状态遇到连接失败会退化为纯关键词（建库仍完成本地索引），
并进入 **60 秒冷却**——冷却期内不再等超时，冷却后自动重试，不需要重启插件。
`rerank` 是独立开关（`off|fast|quality`），只有远端实现；远端不可用时如实报告、不降级到本机。

```yaml
# 不连服务端、只用关键词检索
vectors: off
```

关键词模式下的展示面：

| 项 | 状态 |
|---|---|
| onnxruntime / transformers / 模型文件 | **完全不加载**（本地模型能力已移除） |
| 检索 | FTS5 / BM25（中文用 bigram 切词，零依赖） |
| `code_map` / `code_index_status` / 切块 | 照常可用（tree-sitter 是可选的**唯一**额外依赖） |
| 输出文案 | 只留一行 `模式：纯关键词（本地 FTS5；vectors=off）` |

## 远端索引：`vectors: remote`（`auto` + `remote.url` 时默认走这里）

`vectors: remote` 时**本机只保留 BM25**，向量与 kNN 都在服务端；`vectors: off` 则完全不连远端：

```
本机：切块 + BM25(top-40) ─┐
                           ├─ RRF(k=20) → 结果     ← 融合在客户端；服务端挂了只是语义召回消失
远端：embed → kNN(top-40) ─┘
```

服务端在仓库根目录 [`server/code-index-service/`](../../server/code-index-service/)，
自测 43 项（`selftest.py`）、客户端桩测试 85 项（`test-remote.mjs`，本地 HTTP 桩，不需要网络与模型）。

```yaml
vectors: remote
remote:
  url: "https://dsh-embed.example.com"
advanced:
  remoteRateLimit: 10   # 服务端嵌入限速（块/秒）
```

**实测（同语料、同一份 bge-base fp16）**

| 项 | 结果 |
|---|---|
| 端到端混合检索（1,503 块，局域网） | **≈19 ms**（远端 embed 7.4 + kNN 0.1 + 往返 ≈10 + 本地融合 0.9） |
| 端到端混合检索（**160,507 块**，elasticsearch） | **p50 30 ms / p90 37.5 ms**（服务端 embed 7.7 + kNN 14.6，余下是往返；本地融合 2.5 ms，0 条 join 不到） |
| 同一仓库第二份本地索引（重新切块 61.5 s） | 同步后 **缺向量 0 块、上传 0 字节** → 16 万块规模上复用率 100% |
| 未变更仓库再同步 | **1 个 RTT、0 字节正文**（仓库指纹一致） |
| 同一仓库第二个克隆 | **0 块新嵌入**（内容哈希命中） |
| 首次建库（1,503 块，限速 20/s） | 73 s（限速就是"别打满 GPU"的开关） |

**变更上报（对照 Cursor，不上 Merkle）**

| 触发 | 行为 |
|---|---|
| `code_index`（默认） | 算仓库指纹 → 与服务端比对；一致就只发 `{repoState, chunkCount, revision}`（**1 个 RTT、0 字节正文**） |
| 指纹不一致 | 只发**变更文件**的块清单 → 服务端回 `missing` → 只上传这些正文 |
| `sync.watch: true`（默认关） | `fs.watch` 监听上次建过库的仓库，保存后按 `debounceMs`（≥1000 ms，默认 30 s）聚合，后台跑一次增量同步；跑的过程中不重入 |
| `revision` 冲突 | 服务端 409 → 客户端改发全量清单自愈（多客户端/服务端重置） |

为什么不用 Merkle：它省的是"整棵树传到云端"，而我们本来就只发变更。实测建树 117 ms/4 万文件、
增量 0.001 ms/文件，但本地全量核对在未变更时只要 2 ms —— 协议复杂度换不到收益。

**三条边界，必须如实理解**：

1. **"跨仓库复用"= 同仓库的多分支/多克隆**。实测无关项目之间块重合 **0.00%**（4 个仓库两两比对），
   同项目跨分支 ~98%。服务端因此按**血统**（git origin URL）分存储；fork 想共用只能走服务端
   `POST /v1/lineages/{id}/adopt`（客户端不再暴露 lineage 配置）。
2. **建库搬过去会更慢**：本机 33.05 块/s vs NAS P4 26.8 块/s。远端赢在查询延迟与重排（快 7.5×），
   以及"本机零重依赖、多人共享一份索引"。
3. **纯远程没有离线语义检索**：服务端不可达时只剩 BM25（自动冷却 60 s 后重试）。
   要永久纯关键词就把 `vectors` 设为 `off`。

## 文件结构

```
index.js              插件入口：apply(ctx, config) + 五个工具定义 + 加载标记
lib/store.js          SQLite schema（files / chunks / chunks_fts / vectors / meta）+ FTS/地图/清单查询
lib/repo.js           仓库身份：repoId / git origin 归一化 / 远端命名空间
lib/scope.js          作用域命名规范：canonicalNamespace / refToken / safeRef / 配置校验（档 3）
lib/parser-hints.js   "这个仓库本可按语法切块但缺语法包"的检测与提示渲染
lib/reranker.js       重排档位定义（off / fast / quality 的候选数）
lib/strategies.js     切块策略表（扩展名 → ast|heuristic|window）+ 配置覆盖解析
lib/chunker.js        策略分发：ast → heuristic → window 降级链 + 固定窗口实现
lib/chunk-ast.js      tree-sitter AST 切块（含 bufferSize 与 setLanguage 两个坑的处理）
lib/chunk-heuristic.js 纯 JS 语法感知切块（括号深度 + 成员边界，零依赖）
lib/hash.js           块内容哈希（单独成模块以避免循环依赖）
lib/deps.js           parser 依赖按需安装：受管目录、修剪、解析器链
lib/scan.js           仓库遍历、扩展名/目录过滤、两级指纹增量判定
lib/query.js          查询 → 词项抽取（标识符 / 数字串 / 中文 n 元组）→ FTS5 MATCH
lib/search.js         FTS5 + 远端 kNN → RRF 融合（k=20）
lib/indexer.js        建库/增量编排（远端清单同步、切块指纹强制重建）
lib/remote.js         远端服务客户端（索引同步 / 重排 / 状态）
lib/client.js         DSH 设置页（client 半，dsh.client 加载）
test.mjs              核心自测：建库/检索/增量/删除/切块策略/扫描排除
test-plugin.mjs       插件接口自测：注册面/错误路径/五工具真实调用
verify-install.mjs    装后验证：从已安装包跑通模块加载、工具注册、parser 依赖状态
tools/build-oss-index.mjs  给任意仓库建纯全文索引（评测/演示用）
tools/verify-cases.mjs     校验题库里的期望文件真实存在
tools/remote-index-sync.mjs 手动触发远端索引同步
build-release.mjs     打包发布（tgz 落在 release/，产物不进 git）
test-remote.mjs       远端地址/重排/配置校验/作用域夹具与多作用域回退（本地 HTTP 桩）
```

## 测试

```console
# 在插件目录里（或不带 --repo，用自动夹具仓库）
node test-remote.mjs                            # 85 项：地址/重排/配置校验/作用域夹具/多作用域回退（本地 HTTP 桩）
node test.mjs                                   # 125 项（Windows）/ 119 项（Linux）：建库/检索/增量/切块/排除/作用域
node test-plugin.mjs                            # 81 项：契约与接口、五个工具真实调用、Config schema
node verify-install.mjs                         # 装后验证（对已安装的包跑）

# 在仓库根：三个插件一起跑
pnpm test
```

不传 `--repo` 时，两个需要仓库的测试会用 `scripts/ci-fixture.mjs` 建一个确定性夹具仓库
（.js/.ts/.tsx/.go/.java/.md 各一份），所以本机与 CI 都能直接跑；显式 `--repo` 仍然优先，
不会被静默换成夹具（有断言守着）。要测真实语料就显式传，例如
`node test.mjs --repo D:/Code/your-repo`。

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
| 注册用 `ctx.effect` 并返回清理 | ✅ 五个工具注册在一个带标签的 effect 里，卸载即回收 |
| 显示元数据 + 图标 | ✅ `locale/{zh,en}.json` 的 `meta.title/description` + `icon.svg` |
| `exports` / `files` 白名单 | ✅ 含 `./package.json`、`./locale/*.json` |
| 不要 import `@deepseek-ai/*` 值 | ✅ 除声明式依赖 `@deepseek-ai/schemastery` 外零导入（有断言守着） |
| 配置放 `Config` | ✅ 0.11.5 起导出；设置页只开放 5 个 volatile 字段，显式校验保留 |

### 设计取舍

**① 导出 Config，但保留显式校验。** 0.11.5 起为了让 DSH 设置页读取/写入，导出 Schemastery
`Config`；只有远端地址/API Key、`vectors`、`rerank`、`advanced.indexDirBase` 标成
`.volatile()`，其余字段仍只走 YAML。Loader 的 schema 负责类型与默认值，原有的
`userConfigToInternal` / `normalizeConfig` 继续负责语义校验并抛 `ConfigError`——键名写错、
`vectors: remote` 却没 URL 等错误仍在 apply 时大声失败。

**② 加载记录仪。** `~/.dsh/code-index/_boot.log` 记录模块导入、`apply()` 进入/结束/抛错
（含堆栈）。这不是装饰：插件的失败模式是"什么都不发生"，而应用的报错去向不可靠
（宿主 stdout 无人接收、日志目录为空）。这套记录仪上线后**第一次重启就抓到了根因**：
`cannot get property "tools" without inject`。

## 已知边界

1. **中文中间词命中依赖向量通道**。FTS5 的 unicode61 分词会把连续中文切成一个整词（`退款超限校验` 是一个 token），所以中文词项用前缀查询只能命中开头；中间词要靠向量补。
2. **切块边界质量取决于策略**。默认按文件类型查表：`.java/.js/.ts/.tsx` → `ast`（需按需装 `parser` 组），
   `.vue/.xml/.sql/.md` 等 → `window`，其它 → `heuristic`。换策略会**自动全量重建**索引（见 INSTALL.md §2'）。
3. **依赖体积**：`parser` 组约 61 MB，**按需安装**；装插件本身只约 150 KB（无本地模型）。
4. **需要 Node ≥ 22.19 或 ≥ 24**（`node:sqlite` 免 flag 可用）。
5. **@1 精度**：实测 RRF 在 rank 1 上不如纯通道（向量 18% > FTS5 15% > RRF 5%），所以默认返回 top-10；若你要"最可能的那一个"，用 `mode="vector"`。
6. 改动插件代码后**需要重启 app**：cordis 不会重新 import 已加载的模块，配置热加载只对已存在的行生效。
