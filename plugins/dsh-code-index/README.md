# 代码索引（dsh-code-index）

给 DSH 加仓库级代码检索：本地 SQLite FTS5/BM25 关键词 + 可选远端语义向量（RRF 融合），AST 切块、目录地图、自动索引与变更追踪。索引落在 `~/.dsh/code-index/`，**不写进代码仓库**。

## 安装

| profile | 做法 |
|---|---|
| 普通 profile | 加插件源 `https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json`，装 `dsh-code-index` |
| `desktop`（应用独占） | `plugin_manager(action: "install_bundle", target: "github:leganck/dsh-plugins#<commit>&path:plugins/dsh-code-index")` |

装完**重启 DSH**（Host 插件，ESM 模块缓存不会热更新）。

## 工具

| 工具 | 作用 |
|---|---|
| `code_index` | 建库/增量刷新；`status_only: true` 只看状态 |
| `code_search` | 混合检索，返回「文件:行 + 片段」 |
| `code_map` | 目录地图：每个目录多少文件、什么语言、代表符号 |
| `code_index_status` | 覆盖度、新鲜度、自动同步/自动建库状态 |
| `code_index_deps` | 可选 AST 依赖（tree-sitter，约 61 MB）的安装/修剪 |

```text
code_index({ path: "D:/Code/xxx" })                       # 首次建库
code_search({ path: "D:/Code/xxx", query: "支付回调 幂等" })  # 中英混合最好
code_map({ path: "D:/Code/xxx", depth: 2 })
```

## 自动索引（0.16+）

三条触发，互补：

| 触发 | 时机 | 行为 |
|---|---|---|
| 会话启动 | `agent/created` 取会话 cwd | 是 git 仓库就延迟 `delayMs` 入队 |
| 触及式 | 工具参数里出现仓库内路径（read/edit/grep/glob/bash/code_*） | 立即入队 |
| 懒触发 | `code_search` / `code_map` 打到未建库的仓库 | 后台建库，本次返回「已开始建库」 |

约束：`maxPerSession`（默认 3）限制一次会话自动建几个仓；`maxFiles`（默认 20000）挡住大仓；
worktree 会**归并到主仓**，不会为每个 worktree 各建一份；同时监听数受 `maxWatched`（默认 20）限制，按 LRU 淘汰。

关掉：`advanced.autoIndex.enabled: false`（退回必须手动 `code_index`）。

## 工作区边界

允许索引的根 = DSH `workspaceRoot` + 会话 cwd。**工作区外的仓库显式传 `path` 即授权**（须是 git 仓库根），建过索引后记进注册表，之后任何会话直接可用。没有多根工作区文件，也不读 `.dshworkspace.json`。

## 配置（最小）

```yaml
- id: code-index
  name: "dsh-code-index"
  config:
    remote:
      url: "http://192.168.50.112:18000"   # 向量服务：/embed + /v1/namespaces + /rerank
      apiKey: null
    vectors: "auto"      # auto（有 url 即远端）| remote | off（纯关键词）
    rerank: "off"        # off | fast（top-10）| quality（top-20）
    exclude: []          # 目录名或仓库相对路径前缀
    advanced:
      indexDirBase: "C:/Users/you/.dsh/code-index"
      maxFileBytes: 2097152
      chunking: { strategy: "auto" }        # auto | ast | heuristic | window
      sync: { watch: true, debounceMs: 5000, maxDelayMs: 30000, reconcileMs: 300000 }
      autoIndex: { enabled: true, delayMs: 8000, maxFiles: 20000, maxPerSession: 3, maxWatched: 20 }
```

完整键与默认值见 `index.js` 的 `Config` 与默认配置块。

## 检索行为

- **中文查询**：bge-base-zh 模型，中文可直接查；中英混合召回最好。
- **混合排序**：FTS5 BM25 + 向量 kNN，RRF(k=20) 融合；远端不可用时自动退化为纯关键词。
- **rerank**：默认 `off`；服务端有重排模型时开 `fast`/`quality`，延迟会增加。
- **`vectors: off`**：完全不连服务端，只用本地 FTS5，不需要任何模型。

## 测试

```bash
node test-plugin.mjs          # 工具契约与端到端
node test-auto-index.mjs      # 自动建库队列
node test-repo-touch.mjs      # 路径抽取 / git 根 / worktree 归并
node test-workspace-roots.mjs # 允许根推导
node test-ignore.mjs && node test-auto-sync.mjs && node test-repo-id.mjs && node test-simhash.mjs
```

## 深入

- [COMPARISON-CURSOR.md](./COMPARISON-CURSOR.md)：与 Cursor 索引的逐层对比、实测数字、为什么不做 Merkle/simhash。
- [INSTALL.md](./INSTALL.md)：安装前提、卸载与排错。
