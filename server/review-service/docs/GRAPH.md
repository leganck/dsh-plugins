# 代码图谱（`app/graph.py`）

语法级代码图谱：**tree-sitter 抽定义/调用 + 文本解析 import + SQLite 存查**，没有图数据库、没有 LSP。

## 1. 定位

评审需要的不是"精确的调用图"，而是"改动符号的邻居"：谁调用我、我调用谁、哪些测试覆盖我、哪些文件依赖我。

因此：

- 只做**语法级**分析（不做类型推导、不做跨仓）；
- 每条边带 **confidence**，低置信边**不允许**作为 critical/major 结论的依据（`evidence_edges()` 只返回 ≥0.8）；
- 建在 **base 分支**工作树上（按文件 hash 增量），MR 的新代码从 head worktree 读。

## 2. 数据模型（SQLite，主库 `review.db`）

```sql
graph_meta(project_id, branch, commit_sha, graph_version, built_at,
           files, symbols, edges, schema_version)          -- 每个 (项目,分支) 一行
graph_symbols(id, project_id, branch, path, kind, name, receiver,
              start, end, file_hash)                        -- kind: module|function|method|class|...
graph_edges(id, project_id, branch, src, dst, kind, confidence,
            path, line, file_hash)                          -- kind: call|import
索引：name / path / (dst,kind) / (src,kind) / file_hash
```

- 每个文件一个 `module` 符号，import 边是 module → module；
- `graph_version = sha256(排序后的 "path\0file_hash")`，相同则 `build()` 直接返回（实测 14 ms）。

## 3. 置信度规则（核心）

| 场景 | confidence | 用途 |
|---|---|---|
| 同文件同名定义（含 receiver/同类匹配） | **1.0** | 可进 evidence |
| import 明确指向的文件内定义 | **0.9** | 可进 evidence |
| 全仓库唯一同名定义 | 0.6 | 仅扩展上下文 |
| 多个候选 | 0.3 | 仅扩展上下文 |
| 解析不到（标准库/三方/别名） | 丢弃 | 只计数 |

`evidence_edges()` 只返回 ≥0.8 —— 这是 **D14 门控**的实现：防止"图谱猜错"放大成误报。

## 4. 语言与抽取方式

| 语言 | 定义 | 调用 | import |
|---|---|---|---|
| python | `function_definition` / `class_definition` | `call` 的 function 字段（通配） | `import` / `from ... import` 文本解析 |
| javascript | function / class / method_definition | `call_expression` | `from "..."` / `import "..."` |
| typescript | 上述 + interface / type_alias / enum | 同 JS | 同 JS |
| tsx | 同 typescript（独立语法，避免 JSX 歧义） | 同 JS | 同 JS |
| go | function / method（receiver）/ type_spec | `call_expression` | `import_spec` 引号内路径 |
| java | method / class / interface / enum | `method_invocation` | `import ...;` |
| rust | function / struct / enum / trait / impl | `call_expression` | `use ...;` |
| groovy | **正则兜底**（语法包无声明节点） | `method_invocation` | `import ...` |

> groovy 的 tree-sitter 语法把 `def run()` 解析成 `command/block`，所以退化为按行正则抽 class/method，并在 `stats.degraded` 里如实记录。

## 5. import → 文件映射

| 语言 | 规则 |
|---|---|
| python | `a.b` → `a/b.py` 或 `a/b/__init__.py`；相对导入按 `..` 层数回溯 |
| js/ts/tsx | `./x`、`../x`（补 `.js/.ts/.tsx/index.*`）；**`@/`、`~` 等别名不解析**（计入 unresolved） |
| go | import 路径末段 → 含该目录的 `.go` 文件 |
| java/groovy | `com.foo.Bar` → `com/foo/Bar.java` / `.groovy` |
| rust | `crate::a::b` → `src/a/b.rs` 或 `src/a/b/mod.rs` |

## 6. 查询 API（给 `context.py` 用）

```python
g = Graph(db_path, project_id="7", branch="main")
g.build(worktree, commit_sha="...")        # → {files,symbols,edges,resolved,ambiguous,unresolved,ms,...}
g.callers(sym_id, min_confidence=0.6)      # → [{caller_path, caller, path, line, confidence}]
g.callees(sym_id, min_confidence=0.6)
g.importers(path, min_confidence=0.9)
g.tests_for(sym_id)                        # 命名/路径启发式 + 调用边
g.neighbors_for_symbols(ids)               # 一次取 callers+callees+tests
g.evidence_edges(ids)                      # 只返回 ≥0.8（门控）
g.importance(ids)                          # 0~1 排序分：被调用次数 + 文件被 import 次数
g.prune(worktree)                          # 清理已删除文件
g.stats()
```

## 7. 实测（`spikes/bench_graph.py`，容器内 python:3.11-slim）

| 仓库 | 文件 | 符号 | 边 | 建图 | 查询 p50/p95 | 内存 | DB |
|---|---|---|---|---|---|---|---|
| energy（Go 为主） | 456 | 6,173 | 10,295（import 540 / call 9,755） | **719 ms** | **0.27 / 0.67 ms** | 42 MB | 4.6 MB |
| graph-sample 夹具 | 16 | 46 | 18 | 55 ms | — | — | — |

- 解析成功 2,970、多候选 3,221、未解析 13,157（≈63%，标准库/三方调用）；
- 未变更时二次 build **14 ms**（graph_version 命中）；
- 计划门槛：建图 ≤1.5 s、查询 p95 <50 ms、内存 ≤150 MB —— 全部达标。

## 8. 已知限制

1. **动态派发/反射/接口调用** 语法层无解 → 不建边（P2 用 jedi/gopls 精确引用补）；
2. **import 别名**（`@/`、`~`、PHP autoload）不解析 → 只计数；
3. **groovy** 只有正则兜底（class/method），精度低于 AST；
4. 不建跨仓边（明确不做）；
5. 同名多定义只记 0.3，不猜测。

## 9. 跑测试与基准

```bash
# 验收（20 项，需要 tree-sitter，Linux 容器内）
docker run --rm -v "$PWD":/work -w /work python:3.11-slim \
  sh -c "pip install -q tree-sitter==0.26.0 tree-sitter-language-pack==1.22.1 && python tests/test_graph.py"

# 真实仓库基准
python spikes/bench_graph.py /path/to/repo

# 看夹具各语言抽到的符号（调试 query）
python spikes/inspect_fixture.py
python spikes/probe_lang_nodes.py groovy path/to/file.groovy
```
