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
        indexDirBase: "C:/Users/you/.dsh/code-index"
        roots: ["D:/Code"]
        embedding:
          backend: "auto"
          modelDir: "C:/Users/you/.dsh/models/bge-small-zh-v1.5"
```

插件的配置项会**显式校验并大声失败**（见下文「配置」）：写错键名会让插件行不生效，
而不是被静默忽略。改完补丁层后**需要重启应用**——cordis 不会重新 import 已加载的模块。

## 2. 嵌入依赖：**按需安装**（不再随插件安装）

从 0.3.0 起，`onnxruntime-node` 与 `@huggingface/transformers` **不写在 package.json 里**。
装插件只装纯 JS 部分（tarball 约 49 KB）：**不下载任何重依赖、不触发构建脚本审批、秒级完成**。
需要向量检索时再装：

```text
code_index_deps action=status     # 默认：只看状态与缺什么
code_index_deps action=install    # 下载安装（--ignore-scripts：不执行任何依赖脚本）
code_index_deps action=prune      # 修剪非本平台二进制
code_index_deps action=repair     # 删掉重装（修剪过想恢复别平台时用这个）
code_index_deps action=remove     # 删除
```

默认装到 `%LOCALAPPDATA%\dsh-code-index\embed-deps`（可用 `embedding.depsDir` 改；
POSIX 上是 `~/.cache/dsh-code-index/embed-deps`）。实测（2026-10-16，win32-x64）：

| 步骤 | 实测结果 |
|---|---|
| `action=install` | **46 秒**、661.5 MB、**零依赖脚本**、无需任何审批 |
| `action=prune` | 661.5 MB → **263.8 MB**（回收 397.7 MB），修剪后嵌入仍可用 |

**为什么不写进 package.json**（0.2.1 实测踩过的三件事）：

1. 装插件就要下载并落盘 463 MB；
2. pnpm 与 npm **都会拦依赖脚本**，要人类逐包批准（`approvedBuilds` / `allowScripts`）；
3. 最坏情况撞上服务侧 `idleTimeoutMs`（默认 600 秒）空闲超时：`onnxruntime-node` 的
   `postinstall` 会 bootstrap `global-agent` 走代理下载，脚本结束后 pnpm 迟迟不退出 →
   pnpm 自己打了 `Done in 2s` 却被判 `timeout`，**整次安装回滚**。

改成按需之后，这三件事都不再发生。**关键事实**：onnxruntime-node 的 npm 包
**自带各平台二进制**（`bin/napi-v6/{darwin,linux,win32}/{arm64,x64}`），所以 `--ignore-scripts`
装完照样可用——实测 `require('onnxruntime-node')` 成功、`env.versions={common:1.30.0,node:1.30.0}`、
`listSupportedBackends()` 返回 `[cpu(bundled), dml(bundled), webgpu(bundled)]`，**DirectML 在**。

> 早期版本的这份文档写着"onnxruntime-node 的原生二进制靠 postinstall 下载，必须放行"——
> **那条是错的**，已删除。那个 postinstall 只是"若缺则从 NuGet 补下载"，不是二进制来源。

**模型**（可选；缺失则退化为纯关键词检索）：`bge-small-zh-v1.5` 的 ONNX 版放到
`~/.dsh/models/bge-small-zh-v1.5/`，需要 `model_fp16.onnx`(GPU) / `model_int8.onnx`(CPU) /
`tokenizer.json` / `tokenizer_config.json`。官方 `BAAI/...` 仓库**没有 onnx**，用
`Xenova/bge-small-zh-v1.5`（ModelScope 国内镜像最快）。

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

行内 `config` 的全部可用键（**未知键会让插件行不生效**）：

| 键 | 默认 | 说明 |
|---|---|---|
| `indexDirBase` | `null` | `<base>/<仓库名>-<路径哈希>/index.db`，每仓库一库且不落在代码仓库里 |
| `indexDir` | `null` | 单仓库模式（多仓库共用一个库，慎用） |
| `roots` | `[]` | 路径白名单；空数组 = 允许任意路径。**校验发生在创建索引库之前** |
| `maxFileBytes` | 2 MiB | 单文件上限 |
| `windowLines` | 40 | 切块窗口行数 |
| `defaultTopK` | 10 | `code_search` 默认返回条数 |
| `maxEmbedPerRun` | **0** | 单次最多补算多少块向量。**0 = 建库时不补算**（只做 FTS5，秒级）；>0 会在每次 `code_index` 时自动跑重负载。要向量建议用工具参数 `max_embed` 按需分批传，而不是把这个配置调大 |
| `embedding.backend` | `auto` | `auto` \| `cpu` \| `gpu` \| `off` |
| `embedding.modelDir` | `~/.dsh/models/bge-small-zh-v1.5` | 模型目录 |
| `embedding.threads` | 6 | CPU 线程数 |
| `embedding.batch` | `null` | 批量大小；`null` = 自动（DML 甜点 8–16） |
| `embedding.cachePath` | `~/.dsh/index/vectors.db` | 内容寻址向量缓存，与 Python 实验版共用 |
| `embedding.depsDir` | `%LOCALAPPDATA%\dsh-code-index\embed-deps`（POSIX：`~/.cache/…`） | 按需安装的嵌入依赖放这里。解析顺序：**受管目录优先，其次包内 `node_modules`**（兼容旧安装形态） |

## 5. 自测

```powershell
node test.mjs --repo D:\Code\your-repo          # 核心：32 项
node test-plugin.mjs --repo D:\Code\your-repo   # 契约与接口：45 项
```

## 6. 回滚

删掉补丁层里那段 `- insert:`（文件中有注释标明起止）→ 重启。索引与日志在
`~/.dsh/code-index/`，可一并删除。
