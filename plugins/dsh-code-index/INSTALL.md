# 安装与验证

本包是一个标准 DSH **bundle**：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml`
插入插件行。参考实现：`dsh-ops`（已发布的第三方 bundle）。

## 0. 前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| Node | **≥ 22.19 或 ≥ 24**（`node:sqlite` 免 flag 可用） | `node -v` |
| DSH | 桌面版 0.2.0-rc.2（宿主运行时实测 Electron 44 / Node 24.18.1） | — |
| 平台 | Windows x64（GPU 走 DirectML）；其它平台可跑 CPU/int8 | — |

## 1. 安装（首选：官方 bundle 路径）

按技能 `cordis-plugin-development`：

> `plugin_manager` with `action: install_bundle` and the absolute package directory as `target`.
> 它会完成包安装与 bundle 选择；**不要**用 shell 命令复现这两步。

```
plugin_manager(action: "install_bundle", target: "<本包绝对路径>")
```

判定是否生效：**看返回的 `application` 与 `warnings` 字段**，不是日志、终端输出或进程列表。
`restart-required` 表示改动尚未生效。

> ⚠️ 本机 profile 里 `tool-plugin-manager` 行是 `disabled: true`，所以该工具默认不可用，
> 需要先在 profile 补丁层里把它打开（这是启用 shipped plugin 的标准做法：
> 写一个 workspace bundle，其 patch 覆盖该行为 `disabled: false`）。

## 1'. 安装（替代：手工 file:// 行，本机当前采用）

本机当前用的是这条路径（因为上一条的 `plugin_manager` 未启用）：在
`~/.dsh/profiles/desktop/cordis.patch.yml` 追加

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

## 2. 依赖与模型

```powershell
cd <本包目录>
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
# onnxruntime-node 的原生二进制（含 DirectML.dll）靠 postinstall 下载，必须放行：
npm install-scripts approve onnxruntime-node
npm rebuild onnxruntime-node --foreground-scripts --registry=https://registry.npmmirror.com
```

模型（可选；缺失则退化为纯关键词检索）：`bge-small-zh-v1.5` 的 ONNX 版放到
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
| `maxEmbedPerRun` | 20000 | 单次补算向量上限（可多次跑，支持续算） |
| `embedding.backend` | `auto` | `auto` \| `cpu` \| `gpu` \| `off` |
| `embedding.modelDir` | `~/.dsh/models/bge-small-zh-v1.5` | 模型目录 |
| `embedding.threads` | 6 | CPU 线程数 |
| `embedding.batch` | `null` | 批量大小；`null` = 自动（DML 甜点 8–16） |
| `embedding.cachePath` | `~/.dsh/index/vectors.db` | 内容寻址向量缓存，与 Python 实验版共用 |

## 5. 自测

```powershell
node test.mjs --repo D:\Code\your-repo          # 核心：32 项
node test-plugin.mjs --repo D:\Code\your-repo   # 契约与接口：45 项
```

## 6. 回滚

删掉补丁层里那段 `- insert:`（文件中有注释标明起止）→ 重启。索引与日志在
`~/.dsh/code-index/`，可一并删除。
