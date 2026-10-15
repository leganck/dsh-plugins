# @local/dsh-code-index

DSH 插件：**本地代码库混合检索**。纯 JavaScript，无 Python。

给 agent 三个工具：

| 工具 | 作用 | 并发 |
|---|---|---|
| `code_index` | 建库 / 增量刷新（SQLite：FTS5 全文 + 可选向量） | 串行（写） |
| `code_search` | 混合检索：BM25 + 向量 → RRF → 「文件:行 + 片段」 | ✅ 可并行 |
| `code_index_status` | 覆盖情况与新鲜度（文件/块/向量、待更新数量） | ✅ 可并行 |

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
code_index(path="D:/Code/demo/erp/demo-erp-pos-5.2.0")     # 首次建库（向量部分按仓库大小）
code_search(query="退款超单校验在哪里做的")                          # 混合检索，默认返回 10 条
code_search(query="refundOverLimit", mode="fts")                    # 只走关键词
code_index_status()                                                 # 看覆盖与新鲜度
```

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
3. **窗口切块而非 AST**。40 行窗口在标识符检索上 12/12 命中，且不需要原生解析依赖；`body`/`hash` 语义不变时可平滑换成 AST 切块器。
4. **依赖可选、优雅降级**。缺 `onnxruntime-node` / 缺模型文件 → 自动退化为纯 FTS5，并在结果里说明原因，不会让插件加载失败。
5. **GPU 批量的坑已处理**。DirectML 在 batch 8~16 最快，32 会掉到 10.8 块/s、更大直接崩 → 失败自动减半拆批，单条仍失败才回退 CPU。
6. **截断策略对齐**。transformers.js 截断时把 512 位全填内容 token，Rust `tokenizers` 会给结尾 `[SEP]` 留位 —— 差 1 个 token 会让向量与 Python 版不一致（余弦 0.9986 → 0.999999）。已在推理层对齐。
7. **索引不落在代码仓库里**。`indexDirBase` 下按「仓库名-路径哈希」分目录，不会污染 `git status`。
8. **roots 白名单**。不在白名单内的路径直接拒绝，**且在创建索引库之前校验**。

## 配置

```yaml
- insert:
    - id: code-index
      name: "file:///C:/Users/you/dsh-bundles/dsh-code-index/index.js"
      config:
        indexDirBase: "C:/Users/you/.dsh/code-index"   # 每仓库一个库；不配则用 <repo>/.dsh-index
        roots: ["D:/Code"]                                  # 安全白名单；空 = 允许任意路径
        windowLines: 40                                     # 切块窗口行数
        maxFileBytes: 2097152                               # 单文件上限（默认 2 MB）
        defaultTopK: 10
        maxEmbedPerRun: 20000                               # 单次补算向量的上限（可多次跑，支持续算）
        embedding:
          backend: "auto"                                   # auto | cpu | gpu | off
          modelDir: "C:/Users/you/.dsh/models/bge-small-zh-v1.5"
          threads: 6
          cachePath: null                                   # 默认 ~/.dsh/index/vectors.db（与实验版共用）
```

## 文件结构

```
index.js            插件入口：apply(ctx, config) + 三个工具定义 + 加载标记
lib/store.js        SQLite schema（files / chunks / chunks_fts / vectors / meta）
lib/chunker.js      40 行窗口切块 + 块内容哈希
lib/scan.js         仓库遍历、扩展名/目录过滤、两级指纹增量判定
lib/query.js        查询 → 词项抽取（标识符 / 数字串 / 中文 n 元组）→ FTS5 MATCH
lib/search.js       FTS5 + 向量 kNN → RRF 融合（k=20）
lib/indexer.js      建库/增量编排（含向量补算与断点续跑）
lib/embedder.js     可选嵌入层（onnxruntime-node + DirectML + 共享向量缓存）
test.mjs            核心自测：建库/检索/增量/删除/降级（32 项）
test-plugin.mjs     插件接口自测：注册面/错误路径/三工具真实调用（24 项）
```

## 测试

```console
node test.mjs --repo D:\Code\your-repo              # 核心：32/32
node test-plugin.mjs --repo D:\Code\your-repo       # 接口：24/24
```

## 已知边界

1. **中文中间词命中依赖向量通道**。FTS5 的 unicode61 分词会把连续中文切成一个整词（`退款超限校验` 是一个 token），所以中文词项用前缀查询只能命中开头；中间词要靠向量补。
2. **40 行窗口不是 AST 边界**，跨函数的块可能混在一起；换成语法感知切块需要重建索引。
3. **依赖体积 661 MB**（`onnxruntime-node` 含全平台二进制）。
4. **需要 Node ≥ 23.4**（`node:sqlite` 免 flag 可用）。
5. **@1 精度**：实测 RRF 在 rank 1 上不如纯通道（向量 18% > FTS5 15% > RRF 5%），所以默认返回 top-10；若你要"最可能的那一个"，用 `mode="vector"`。
6. 插入新插件行后**需要重启 app** 才生效（补丁层的热加载对已存在的行生效，新行不生效——实测）。
