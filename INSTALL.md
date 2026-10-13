# 安装 @local/dsh-memory-archive

本包是一个 **DSH bundle**（`package.json` 里声明了 `dsh.bundle.patch`），只有 1 个插件行
`memory-archive`。功能与配置见 [README.md](./README.md)。

## 前提

| 项 | 要求 |
|---|---|
| DSH | 任意含 `session/created`、`session/event`、`agent/pre-step`、`agent.inbox` 的版本 |
| Node | ≥ 20 可运行；**磁盘历史回填**需要 `zlib.zstdDecompressSync`（Node ≥ 22.15 / 23.2） |
| 权限 | 可写 `$DSH_HOME`；可写目标 profile 目录 |

Node 版本不够**不会报错**：插件降级到 `session.snapshotEvents()`。加载后可用
`_loaded.json` 的 `capabilities.zstd` 判断实际能力（`false` 即降级）。

## 三条路径

### A. 原生 bundle（推荐）

适用于 `dsh plugin` 可用的 profile。本包已是 bundle，所以：

```bash
dsh plugin --profile <profile> add <本目录 | .tgz | git+https://.../dsh-memory-archive.git>
```

再把包名加进该 profile `package.json` 的 `dsh.profile.bundles`：

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@local/dsh-memory-archive"
] } } }
```

bundle 自带的 `cordis.patch.yml` 会插入 `memory-archive` 行，`name` 用包名
`@local/dsh-memory-archive`（loader 按 Node ESM 解析）。

> `dsh plugin --profile <n> --help` 可见其本质是 `pnpm --dir <profile>`。

### B. 一键脚本（desktop 等被应用独占管理的 profile）

```powershell
pwsh -File install.ps1 -Profile desktop
pwsh -File install.ps1 -Profile desktop -DryRun      # 只看会改什么
pwsh -File install.ps1 -Profile desktop -Uninstall   # 回滚
```

脚本会：把包复制到 `$DSH_HOME\bundles\dsh-memory-archive`（跳过 `_loaded.json`）、
**备份** profile 的 `cordis.patch.yml`、幂等插入 `memory-archive` 行
（`name` 写 `file:///<绝对路径>/index.js`）、打印重启与回滚说明。
它**不会**改 profile 的 `package.json`，也**不会**在 profile 目录跑 pnpm。

> **为什么 desktop 需要这条**：该 profile 被 Electron 应用独占管理，
> `dsh plugin --profile desktop` 与 `dsh --dump-config --profile desktop` 都会
> 直接失败（`profile "desktop" is managed exclusively by the Electron application`），
> Web 侧栏也没有插件页；`plugin_manager` 工具的 `tool-plugin-manager` 行在 base bundle
> 里默认 disabled。所以只剩「写用户补丁层」这一条路。

### C. 手工

1. 复制包到工作区外的固定目录（例如 `$DSH_HOME\bundles\dsh-memory-archive`）。
2. 在 `<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: memory-archive
      name: "file:///C:/path/to/dsh-memory-archive/index.js"
      config:
        archiveDir: "C:/Users/<you>/.dsh/archive"
        includeToolResults: true
        redact: true
        announce: true
```

3. 重启。

`name` 必须解析到 `index.js` 本身（`file://` 或相对路径皆可，无需 pnpm）。
`archiveDir` 首次安装建议写**绝对路径且用正斜杠**。

## 生效与验证

**改配置热生效，改代码必须重启**（实测：编辑 profile 补丁数秒内重新 apply；编辑
`index.js` 不会重新 import）。所以新装、升级代码后都要重启 app。

重启后看 `<bundleDir>\_loaded.json`：

```json
{ "loadedAt": "...", "pid": 1234, "build": "2026-10-13.5",
  "archiveDirResolved": "C:/Users/<you>/.dsh/archive",
  "capabilities": { "zstd": true },
  "markerFile": "<bundleDir>/_loaded.json" }
```

- `build` 与 `archiveDirResolved` 是**只有新代码才写得出**的字段：若它们缺失，说明进程仍持有
  旧模块，需要重启。
- 若安装位只读，请设 `markerFile`（或 `DSH_MEMORY_ARCHIVE_MARKER`）到可写路径，否则标记写不出来
  （不影响插件运行）。

首次压缩后检查归档目录出现 `INDEX.md` 与 `segment_000.md`；`## Verbatim turns` 里应有原始
`Tool response` 文本。

## 卸载

```powershell
pwsh -File install.ps1 -Profile desktop -Uninstall
```

或手工删掉 profile 补丁里的那段、并删除 `<DSH_HOME>\bundles\dsh-memory-archive`。
归档目录是纯数据，插件不会在卸载时删除它，请自行处理。

## 自测

```bash
node test.mjs        # 88 项断言，全部在临时目录里跑，不触碰安装目录
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 重启后 `_loaded.json` 没有 `build` 字段 | 进程仍持旧代码 → 完整重启（不是 reload 窗口） |
| 指针没出现在会话里 | 压缩后若会话直接结束，没有下一次 `agent/pre-step`；文件仍已落盘，可手动 grep |
| `archiveDir` 下出现字面量 `~` 目录 | 旧代码不展开 `~`；改用绝对路径，或升级后重启 |
| 工具统计显示 `(none)` | 段是 1.0.0 之前的旧产物；删掉对应 `segment_*.md` 并重算 |
