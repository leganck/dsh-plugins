# 安装 @local/dsh-memory-archive

> 主路径是 **DSH 插件源**（仓库根 `market/index.json`）或 `plugin_manager` 的 `install_bundle`；
> `install.ps1` 只是**离线兜底**，且已从 `package.json` 的 `files` 移除——重新打包后不再随
> npm 包（`.tgz`）分发。

本包是一个 **DSH bundle**（`package.json` 里声明了 `dsh.bundle.patch`），只有 1 个插件行
`memory-archive`。功能、产物格式与全部 10 个配置项见 [README.md](./README.md)。

## 前提

| 项 | 要求 |
|---|---|
| DSH | 含 `session/created`、`session/event`、`agent/pre-step`、`agent.inbox` 的版本 |
| Node | `^22.19 \|\| >=24`（`package.json` 的 `engines`） |
| 权限 | 可写 `$DSH_HOME`；走脚本或手工安装时还需可写目标 profile 目录 |

**磁盘历史回填**额外要求 `zlib.zstdDecompressSync`（Node ≥ 22.15 / 23.2）。缺它**不会报错**：
插件降级到 `session.snapshotEvents()`，再不行只见实时事件。加载后看 `_loaded.json` 的
`capabilities.zstd`（`false` 即降级）。

## 安装

### A. 插件源（推荐）

在 DSH 里打开 **Plugins → Discover → 添加源**，填：

```text
https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json
```

然后安装 `@local/dsh-memory-archive`。`market/index.json` 里的版本与 git commit 是**钉死**的，
装到的就是那个 commit 下的 `plugins/dsh-memory-archive/`；不需要你手动跑 pnpm 或命令行。

### B. `plugin_manager` + `install_bundle`

```text
plugin_manager(action: "install_bundle", target: "<release/*.tgz 或包目录的绝对路径>")
```

- **target 优先传 `release/` 里的 `.tgz`**：pnpm 对**目录**用 `link:`（源码目录会成为运行时依赖，
  删/移/`git clean` 就静默失效），对 tarball 是**实体安装**。
- 没有现成 `.tgz` 时，在插件目录里重建：`pwsh -NoProfile -File build-plugin-dist.ps1`
  （会先跑自测和 YAML 结构校验，再 `npm pack` + zip + `SHA256SUMS.txt`，最后复制到 `release/`）。
- 判定是否生效看返回的 `application` / `warnings` / `pendingBuilds`，不要只看插件自己写的标记。
  补充确认：

```text
plugin_manager(action: "list_bundles")   # installed / enabled / version
plugin_manager(action: "list_plugins")   # moduleName 是包名还是 file://；fiberPhase 是否 active
```

**前置条件**：profile 的 `tool-plugin-manager` 行被 shipped patch 置为 `disabled: true`，
需要在 profile 补丁层按 id 覆盖并重启应用，`plugin_manager` 才可用：

```yaml
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: false
```

### C. 离线兜底：`install.ps1`

**该脚本已从 `package.json` 的 `files` 移除，重新打包出的 npm 包（`.tgz`）不含它**；
只有仓库源码目录（`plugins/dsh-memory-archive/install.ps1`）里有（按源码树打的 zip 也会带上）。没有插件源、
也不能用 `plugin_manager` 时用它。

```powershell
pwsh -File install.ps1 -Profile desktop
pwsh -File install.ps1 -Profile desktop -DryRun      # 只看会改什么
pwsh -File install.ps1 -Profile desktop -Uninstall   # 移除托管块
pwsh -File install.ps1 -Profile desktop -Force       # 覆盖已有托管块（例如 bundle 换了位置）
```

它做的事（读脚本可核对）：

1. 把包复制到 `$DSH_HOME\bundles\dsh-memory-archive`（跳过 `_loaded.json` 与 `.git`）；
2. **备份** profile 的 `cordis.patch.yml`；
3. 在 managed begin/end 标记之间插入一个 `memory-archive` 行，`name` 写
   `file:///<bundle 绝对路径>/index.js`，config 写 `archiveDir` / `includeToolResults` /
   `redact` / `announce`；
4. 打印重启与回滚说明。

它**不会**改 profile 的 `package.json`，也**不会**在 profile 目录跑 pnpm。`-Profile` 默认取
`$env:DSH_PROFILE`，否则 `desktop`；`-DshHome` 默认取 `$env:DSH_HOME`，否则 `~/.dsh`。
profile 目录必须已存在（先启动一次应用）。

### D. 手工（最后手段）

1. 把包复制到工作区外的固定目录（例如 `$DSH_HOME\bundles\dsh-memory-archive`）。
2. 在 `<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: memory-archive
      name: "file:///C:/path/to/dsh-memory-archive/index.js"
      config:
        archiveDir: "~/.dsh/archive"   # 引号必需：裸 ~ 在 YAML 里是 null
        includeToolResults: true
        redact: true
        announce: true
```

3. 重启。

`name` 必须解析到 **`index.js` 本身**（`file://` 或相对路径皆可，无需 pnpm）。
`archiveDir` 默认的 `~/.dsh/archive` 可直接用；只有不展开 `~` 的旧版本才需要写绝对路径。

### E. `dsh plugin add`（未在本机验证）

**仅适用于非应用独占管理的 profile** —— `desktop` 这类 profile 会被直接拒绝：
`error: profile "desktop" is managed exclusively by the Electron application`。
本包已是 bundle，所以可以：

```bash
dsh plugin --profile <profile> add <本目录 | .tgz | git+https://github.com/leganck/dsh-plugins.git>
```

再把包名加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@local/dsh-memory-archive"
] } } }
```

> 仓库是多插件仓库，git 依赖指向的是**仓库根**，而插件在 `plugins/dsh-memory-archive/`。
> 用 git 形式时请先 clone，再 `add` 该子目录的本地路径。本机 profile 被应用独占，
> 这条路径**未实测**，优先用 A / B。

## 分发物

- `.tgz` / `.zip` 是构建产物，**不进 git**；`release/` 里只有 `SHA256SUMS.txt` 进版本管理。
- 分发走三条路：**插件源**（推荐，`market/index.json` 钉 commit）、**GitHub Releases**
  （需要独立二进制时挂 tag，tag 形如 `memory-archive-vX.Y.Z`）、**本地构建**
  （`pnpm release` 或插件目录里的 `build-plugin-dist.ps1`）。
- 仓库：<https://github.com/leganck/dsh-plugins>（插件位于 `plugins/dsh-memory-archive/`）。

## 生效与验证

**改配置热生效，改代码必须重启**（实测：编辑 profile 补丁数秒内重新 apply；编辑 `index.js`
不会重新 import）。所以新装、升级代码后都要重启 app。

重启后看激活标记（默认 `<bundleDir>\_loaded.json`，可用 `markerFile` 或
`DSH_MEMORY_ARCHIVE_MARKER` 重定向）：

```json
{ "loadedAt": "<ISO 时间>", "pid": 1234,
  "dshProfile": null, "sessionId": null,
  "archiveDir": "~/.dsh/archive",
  "archiveDirResolved": "C:/Users/<you>/.dsh/archive",
  "build": "<index.js 的 BUILD 常量>",
  "capabilities": { "zstd": true },
  "announce": true,
  "markerFile": "<bundleDir>/_loaded.json" }
```

- `build` 与 `archiveDirResolved` 是**只有新代码才写得出**的字段：若它们缺失，说明进程仍持有
  旧模块，需要完整重启（不是 reload 窗口）。
- 若安装位只读，请设 `markerFile`（或 `DSH_MEMORY_ARCHIVE_MARKER`）到可写路径，否则标记写不出来
  （不影响插件运行）。

首次压缩后检查归档目录出现 `INDEX.md` 与 `segment_000.md`；`## Verbatim turns` 里应有原始
`Tool response` 文本。下一段指针的逐字形状与出现条件见 README 的「注入的指针」一节。

## 卸载

```powershell
pwsh -File install.ps1 -Profile desktop -Uninstall
```

或手工删掉 profile 补丁里的 `memory-archive` 行（用脚本装的是删掉 managed 块），再删除
`<DSH_HOME>\bundles\dsh-memory-archive`，然后重启。`install_bundle` / 插件源装的包由包管理器
登记，卸载请走同一入口；不确定时按上面的手工步骤清理。

归档目录是纯数据，插件不会在卸载时删除它，请自行处理（默认 `~/.dsh/archive`）。

## 自测

```bash
cd plugins/dsh-memory-archive
node test.mjs     # ALL 109 CHECKS PASSED；全部在临时目录里跑，不触碰安装目录
```

仓库根也能一次跑全部插件：`pnpm test`。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 重启后 `_loaded.json` 没有 `build` / `archiveDirResolved` | 进程仍持旧代码 → 完整重启（不是 reload 窗口） |
| 指针没出现在会话里 | 压缩后若会话直接结束，没有下一次 `agent/pre-step`；文件仍已落盘，可手动 grep。也可能是 `announce: false` |
| `archiveDir` 下出现字面量 `~` 目录 | 不展开 `~` 的旧版本；升级并重启，或临时改用绝对路径 |
| 工具统计显示 `(none)` | 段是更早版本写的旧产物（工具信息当时取自 `tool/call`）；旧段不会自动重算，需要时用 `tools/backfill-session.mjs` 从日志重放 |
| `plugin_manager` 不可用 | `tool-plugin-manager` 行在 base bundle 里默认 disabled，按上面的补丁覆盖并重启 |
| pnpm 报 Node 版本不支持 | 按 `engines` 用 Node `22.19+`（22.x）或 `24+` |
