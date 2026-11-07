# 安装与验证

本包是一个标准 DSH **bundle**：`package.json` 声明 `dsh.bundle.patch`，包内
`cordis.patch.yml` 插入 `dsh-report` 插件行。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| DSH | 桌面版 0.2.x（Client `dsh.client` + Host `webServer` 可用） |
| Node | `^22.19 || >=24`（Host 用 `node:sqlite`，无原生依赖） |
| 平台 | Windows / macOS / Linux 均可（不依赖原生模块） |

## 1. 安装（官方 bundle 路径）

按官方技能 `cordis-plugin-development`，通过 `plugin_manager` 安装：

```text
plugin_manager(action: "install_bundle", target: "<指向 release/local-dsh-report-<version>.tgz 或包目录的绝对路径>")
```

优先传 `release/` 里的 `.tgz`：pnpm 对目录用 `link:`，源码目录会成为运行时依赖；
对 `.tgz` 则解包成实体安装，源码与运行时解耦。

没有现成 `.tgz` 时先在包目录执行：

```sh
node build-release.mjs
```

判定是否生效：**看返回的 `application` / `warnings`**。
`restart-required` 表示需要重启 DSH 后才会加载新一代模块。

## 2. 配置

首次安装时插件行使用默认配置（数据目录 `~/.dsh/dsh-report`、时区 `Asia/Shanghai`）。
机器相关的配置在**设置 →「报告与统计」**里写入（GitLab 地址/Token、同步仓库范围、
提交作者别名、模板与写作指引），Token 存 DSH 凭据库，不落明文。

也可以直接覆盖 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-report
  name: '@local/dsh-report'
  config:
    dataDir: ''                 # 空 = <DSH_HOME>/dsh-report
    timezone: Asia/Shanghai
    defaultReportType: week
    gitlab:
      baseUrl: https://gitlab.example.com
      tokenRef: dsh-report/gitlab-token
```

## 3. 验证

1. 左侧栏出现「报告与统计」图标，点击打开主面板；
2. 设置页出现「报告与统计」分区：保存 GitLab 连接 → 刷新仓库 → 在「同步仓库范围」保存范围；
3. 统计页：查询一个范围 → 贡献墙 / 摘要 / 提交记录 / 仓库树有数据；
4. 同步对话框：选窗口 → 开始同步；任务历史里可「查看统计」；
5. 报告页：新建报告 → 生成后详情 / 导出 / 编辑模板可用；
6. Agent 工具：`report_brief` / `report_stats` / `report_commits` / `report_update` 等 9 个可调用。

数据落在 `<dataDir>/report.db`（SQLite WAL）；作者别名在 `<dataDir>/author-aliases.json`，
模板覆盖在 `<dataDir>/prompts.json`。
