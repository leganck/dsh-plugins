# 安装与验证

本包是一个标准 DSH **bundle**：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml`
插入插件行。参考实现：`dsh-ops`（已发布的第三方 bundle）。

## 0. 前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| Node | **≥ 22.19 或 ≥ 24**（`node:sqlite` 免 flag 可用） | `node -v` |
| DSH | 桌面版 0.2.0-rc.2（宿主运行时实测 Electron 44 / Node 24.18.1） | — |
| 平台 | Windows x64（GPU 走 DirectML）；其它平台可跑 CPU/int8 | — |

## 1. 安装（官方 bundle 路径）

按技能 `cordis-plugin-development`：

> `plugin_manager` with `action: install_bundle` and the absolute package directory as `target`.
> 它会完成包安装与 bundle 选择；**不要**用 shell 命令复现这两步。

```
plugin_manager(action: "install_bundle", target: "<本包绝对路径>")
```

判定是否生效：**看返回的 `application` 与 `warnings` 字段**，不是日志、终端输出或进程列表。
`restart-required` 表示改动尚未生效。确认新行用 `cordis_inspect_query`（无需审批）。

### 前置条件：`plugin_manager` 工具必须启用

本机 profile 的 `tool-plugin-manager` 行被 shipped patch 置为 `disabled: true`，所以该工具
默认调不出来 —— 这既是此前只能手写补丁行的原因，也是 `install_bundle` 用不了的原因。
按 id 覆盖那一行即可（这正是该补丁文件的常规用法，模型/UI/主题都是这么改的）：

```yaml
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: false
```

改完**重启应用**。另外本 profile 由应用独占管理，**CLI 那条路走不通**：

```
dsh plugin --profile desktop ...  →  error: profile "desktop" is managed exclusively by the Electron application
```

> 仓库根目录的 `install.ps1` 默认就是这套官方流程：它检查上面的前置条件并打印应当交给
> agent 执行的 `install_bundle` 调用（脚本本身无法调用工具）。

## 1'. 安装（退路：手工 file:// 行）

**仅在 `plugin_manager` 不可用时使用。** 手写行绕过了 `install_bundle` 的清单/patch 校验
与结构化回执 —— 本插件历史上正因此出现过"插件静默不生效、排查花了几轮重启"。

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: code-index
      name: "file:///<本包绝对路径>/index.js"
      config:
        roots: ["D:/Code"]
        remote:
          url: "https://dsh-embed.example.com"
        vectors: "remote"          # off = 纯关键词（不连服务端）
        rerank: "off"
        advanced:
          indexDirBase: "C:/Users/you/.dsh/code-index"
```

插件的配置项会**显式校验并大声失败**（见下文「配置」）：写错键名会让插件行不生效，
而不是被静默忽略。改完补丁层后**需要重启应用**——cordis 不会重新 import 已加载的模块。

## 2. 语法解析依赖：**按需安装**（不随插件安装）

0.10.0 起本地嵌入已移除，只剩 **parser 组**（tree-sitter 语法，用于 AST 切块）：

| 组 | 内容 | 体积（实测） |
|---|---|---|
| `parser` | `tree-sitter@0.21.1` + java 0.21.0 / javascript 0.21.4 / typescript 0.21.2 / **groovy 0.1.2** | **60.3 MB** |
| `parser-go` / `parser-python` / `parser-rust` | 单语言语法 | 2.7 / 5.8 / 10.8 MB |
| `parser-extra` | 上面三个 | ≈19 MB |

```text
code_index_deps action=status                        # 默认：只看状态与缺什么
code_index_deps action=install group=parser          # 装语法解析（60 MB）
code_index_deps action=install group=parser-go       # 按语言单独装
code_index_deps action=install group=all             # parser + parser-extra
code_index_deps action=prune                         # 修剪非本平台二进制
code_index_deps action=repair group=all              # 删掉重装
code_index_deps action=remove                        # 删除
```

默认装到 `%LOCALAPPDATA%\dsh-code-index\embed-deps`（历史目录名；可用 `advanced.depsDir` 改；
POSIX 上是 `~/.cache/dsh-code-index/embed-deps`）。**不装也能用**：切块降级为 heuristic/window，
检索不受影响；装了 `code_index` 才会按 AST 切块。

## 2'. 切块策略表（对应 Cursor 的 `GetAvailableChunkingStrategies`）

Cursor 那套是"**服务端按文件类型下发**切块策略"；我们本地没有服务端，等价物是
**内置策略表（按扩展名）+ 配置覆盖 + 依赖缺失时自动降级**（表在 `lib/strategies.js`）。

| 策略 | 实现 | 依赖 | 说明 |
|---|---|---|---|
| `ast` | tree-sitter 语法树，块边界落在成员声明上 | `parser` 组 | 需要按需安装；缺依赖或某文件解析失败会**降级并报告原因** |
| `heuristic` | 纯 JS：括号深度 + 成员边界 + 引号/注释感知 | **无**（永远可用） | 兜底与表里未列语言 |
| `window` | 固定行窗口 | 无 | **不是"旧代码没删"**，而是明确指定给 Vue/XML/SQL/Markdown 这类"括号深度无意义"的文件 |

内置表（节选）：`.java/.js/.mjs/.cjs/.jsx/.ts/.tsx/.groovy/.gradle` → `ast`；
`.vue/.xml/.html/.sql/.md/.json/.yml/.yaml/.properties` → `window`；其它 → `heuristic`。

**实测（真值来自语法树，不是"括号深度"这种代理）**：

| 仓库 | 策略 | 块数 | 平均行 | **块首行落在成员内部** |
|---|---|---|---|---|
| `saas`（8,777 个 Java 文件） | `window` | 22,619 | 33.3 | **29.4%** |
| | `heuristic` | 18,765 | 40.1 | **7.5%** |
| | **`ast`** | 13,156 | 45.1 | **0.1%**（30 个超长成员被强制拆分） |
| `legacy-java-service`（94 个 Java 文件） | `window` | 207 | 32.3 | **15.0%** |
| | `heuristic` | 179 | 37.4 | **6.1%** |
| | **`ast`** | 122 | 43.4 | **0.0%** |
| `legacy-java-service`（**144 个 Groovy 文件**，Grails） | `heuristic` | 506 | 49.5 | **31.6%**（160/506） |
| | `ast`（maxLines 120） | 369 | 63.0 | **12.2%**，其中非强制块 **0/313** |
| | **`ast`（maxLines 200）** | 348 | 66.8 | **7.5%**，其中非强制块 **0/315** |

"块首行落在成员内部"= 块从方法/字段**中间**开始，也就是"半截方法"——
它的向量表达的是半截语义，检索匹配会被稀释。`ast` 把 29.4% 压到 0.1%。

**Groovy 那一行揭示了一条重要性质**：AST 切出的**非强制块是与成员边界 100% 对齐的**
（0/313、0/315），残差完全来自"成员本身比 `maxLines` 长"。所以遇到长成员语言，
正确做法是**调大该语言的 `maxLines`**（表里 `.groovy`/`.gradle` 就设成了 200），
而不是接受半截块。`heuristic` 的 31.6% 则全来自它本身的判断误差（没有一个强制拆分）。

> 早前用"块内大括号是否平衡"当质量指标，**那个指标是错的**：AST 切出的块是"类里的一个方法"，
> 天然不带类的那个 `{`，所以整块计数必然不为 0——它把正确切法判成异常（`ast` 66.8% 反而"差于"
> `heuristic` 52.8%）。已换成对称可比的"首行/末行是否落在成员内"。

**换策略必须重建索引**：插件在建库时写入"切块策略指纹"（`chunk_fingerprint`），
指纹变化会**自动全量重建**并在结果里显式报告。否则增量建库只重切变动文件，
库里会同时存在两种粒度的块——而且没有任何信号提示这件事发生了。

## 3. 验证：看插件自己写的两个文件

插件在**模块导入**和 **apply() 进入/结束/抛错**时各写一行记录；加载标记在 `apply()` 开头就写。
这套机制是被真实故障逼出来的：缺少 `export const inject` 时插件行**整行静默不生效**，
不注册工具、不写日志，只能靠翻 asar 和进程时间线定位。

```powershell
# ① 应有 4 行；最后一行是 apply-completed。出现 apply-THREW 就是失败且带堆栈
Get-Content "$env:USERPROFILE\.dsh\code-index\_boot.log"

# ② 加载标记：pid 应等于当前插件宿主进程
Get-Content "$env:USERPROFILE\.dsh\code-index\_loaded.json"
```

然后验证能力本身（`installing 成功 ≠ 能力可用`）：

```
code_index_status()                                    # 覆盖情况 + 嵌入器状态
code_index(path="D:/Code/demo/svc/legacy-java-service")
code_search(query="订单状态机", path="D:/Code/demo/svc/legacy-java-service")
```

## 4. 配置

行内 `config` 的全部可用键（**未知键会让插件行不生效**）。0.10.0 起 remote-only，用户面只有 6 个键：

| 键 | 默认 | 说明 |
|---|---|---|
| `roots` | `[]` | 路径白名单；空数组 = 允许任意路径。**校验发生在创建索引库之前** |
| `remote.url` | `null` | 向量服务地址；`vectors: remote` 时必填 |
| `remote.apiKey` | `null` | 服务端设了 API_KEY 才需要 |
| `vectors` | `auto` | `auto`（有 `remote.url` 就走远端，没有则纯关键词）\| `remote`（强制，缺地址报错）\| `off`（纯关键词，本地 FTS5） |
| `rerank` | `off` | `off` \| `fast`（top-10 候选）\| `quality`（top-20），远端重排 |
| `exclude` | `[]` | 目录名（任意深度），或含 `/` 的仓库相对路径前缀。与内置默认合并；不可绝对路径、不可含 `..` |

`advanced.*`（部署方调优，不写全用默认）：

| 键 | 默认 | 说明 |
|---|---|---|
| `advanced.indexDirBase` | `null` | `<base>/<仓库名>-<路径哈希>/index.db`，每仓库一库且不落在代码仓库里 |
| `advanced.maxFileBytes` | 2 MiB | 单文件上限 |
| `advanced.windowLines` | 40 | 切块窗口行数 |
| `advanced.depsDir` | 受管目录 | parser 依赖放这里（不再有嵌入依赖组） |
| `advanced.chunking.strategy` | `auto` | `auto` \| `ast` \| `heuristic` \| `window` |
| `advanced.chunking.byExt` | `{}` | 按扩展名覆盖策略表 |
| `advanced.sync.watch` | `false` | 保存后自动增量 |
| `advanced.sync.debounceMs` | `30000` | 防抖下限 1 s |
| `advanced.remoteTimeoutMs` | `8000` | 远端超时（嵌入/索引/重排共用） |
| `advanced.remoteRateLimit` | `null` | 服务端嵌入限速（块/秒） |

> **0.10.0 移除**：`embedding.*`（本地模型）、`vectorStore`、`preset`、`rerankBackend`、
> `rerankRemote.*`、`excludeDirs`/`excludePaths`、顶层 `indexDirBase/chunking/sync`、
> `remote.tag/model/fallbackLocal/repoId/namespace/lineage/uploadBatch`。
> 旧配置会直接报错并给出迁移提示。

## 5. 自测

```powershell
node test.mjs --repo D:\Code\your-repo          # 核心：32 项
node test-plugin.mjs --repo D:\Code\your-repo   # 契约与接口：45 项
```

## 6. 回滚

删掉补丁层里那段 `- insert:`（文件中有注释标明起止）→ 重启。索引与日志在
`~/.dsh/code-index/`，可一并删除。

## 默认模型：bge-base-zh-v1.5（随包提供）

从 0.6.0 起默认嵌入模型是 **bge-base-zh-v1.5**（103 题实测 hit@3 **43% → 54%**，查询 22 → 34 ms）。

- **随包提供 int8 版（97.7 MB）**，装在 `<插件目录>/model`，**装上即用**，不必另下
- **随包提供 fp16（194 MB），不是 int8** —— 这颗 int8 导出实测**会让向量塌缩**：
  4 段互不相关文本两两余弦平均 **0.806**（健康应 ≤0.5），同模型 fp16 是 **0.464**，bge-small fp16 是 0.450。
  塌缩的后果是通用块（DTO 类头、AGENTS.md）成了所有中文提问的最近邻，语义召回全面失效 ✗
- fp16 在 DirectML（约 13–23 ms/查询）与 CPU（约 34 ms/查询）上都能跑；GPU 偶发瞬时 TDR 时插件会自动重建到 CPU
- 构建期怎么打包：`npm pack` 的 `prepack` 会把模型拷进包、`postpack` 再删掉 → **仓库里不留二进制**（`.gitignore` 忽略 `model/`）

### ⚠️ 升级提示（很重要）

**换模型 = 向量空间变了** → 已有索引里的向量全部作废，升级后**第一次 `code_index` 会全量重嵌**：

| 规模 | 重嵌耗时（CPU int8 约 456 ms/块）|
|---|---|
| 一个模块 676 块 | ≈ **5 分钟** |
| 大仓库 4,501 块 | ≈ **34 分钟** |
| 全部历史 6.7 万块 | ≈ **8.5 小时**（别一次全做）|

更换嵌入模型由**服务端**负责；客户端不再保存/计算本地向量，因此没有"本地重嵌"成本。

## 可选：开启远端交叉编码器重排（默认关）

实测（103 题中文自然语言题库、bge-small 候选池 top-20）：**hit@3 42.7% → 59.2%**（quality）/ 57.3%（fast）。
**它不需要重建索引**（在现有向量之上重排）。

0.10.0 起重排**只有远端实现**（本机重排模型已移除），服务端见 `server/code-index-service/`：

```yml
vectors: remote
remote:
  url: "https://dsh-embed.example.com"
rerank: quality   # off（默认）| fast（top-10）| quality（top-20）
```

| 档位 | 候选 | hit@3（历史实测） |
|---|---|---|
| off | — | 42.7% |
| fast | 10 | 57.3% |
| quality | 20 | 59.2% |

要点：
- 重排失败（远端不可用/服务端未装重排模型）**不降级到本机**，在结果里如实报告原因，不让搜索失败
- `code_search` 输出会写明重排档位、候选数与远端地址；未生效时写明原因
- `code_index_status` 报告「重排：quality（… 远端 …）」

---

## 可选：把重排（或向量）放到另一台机器（0.7.0 起，默认关）

先在另一台机器上起服务端（本项目自带）：

```sh
# 目录结构、CUDA 12 + ORT 1.19.2 的原因、compose 示例都在：
server/code-index-service/README.md
```

起好服务端后直接配置远端（0.10.0 起只有这一种远端写法）：

```yml
vectors: remote
remote:
  url: "https://dsh-embed.example.com"
  apiKey: null
rerank: quality
```

验证切没切过去，看两处：

```sh
code_index_status        # 会打印「向量位置：远端 …」「重排：quality（… 远端 …）」
node tools/bench-remote.mjs --url https://… --skip-rerank   # 只看嵌入那半
```

远端不可达时的表现（都**不会**让检索失败）：

| 情况 | 表现 |
|---|---|
| 服务端整个连不上 | 搜索仍返回结果，向量通道降级为纯关键词；重排回退本机（`fallbackLocal: true`） |
| 服务端在但 `rerank_ready=false` | 直接报"远端未装重排模型"，不发无谓请求 |
| 向量 `tag` 与本机不一致 | **不回退**，报原因（回退会把两种模型的向量混进一个索引） |


