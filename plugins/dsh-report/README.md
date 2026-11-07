# 报告与统计（dsh-report）

DSH bundle：把 GitLab 提交同步、确定性统计、AI 报告生成三件事收进一个面板。

- **统计页**：贡献墙（按查询范围逐日）、摘要、分支、提交记录（月→日→当天提交、仓库筛选）、仓库树
- **报告页**：报告树 + 详情（正文/统计）、生成/重生成/导出/删除、编辑模板
- **同步范围**：设置里可一次勾选多个 GitLab 连接，跨连接的仓库在同一棵树里选择；保存后同步与生成会覆盖所有已选连接（不再是只同步第一个连接）
- **同步**：「同步仓库范围」在设置里维护；同步对话框负责窗口、进度、任务历史（可「查看统计」）。
  窗口开始/结束日期联动（选一个快捷范围同时改两端），从统计页打开时默认带当前统计范围
- **覆盖度预览**：同步窗口下方的「本地已有数据」显示该窗口本地库已有的提交/新增/删除/活跃天与按仓库明细，用来判断窗口是否已同步过，避免重复拉取
- **生成**：所有报告共用一个 Agent 会话（`<dataDir>/generation-session.json`，会话失效自动重建）；
  报告范围内没有本地提交时，先按设置里的连接/仓库范围**自动同步**该窗口再生成；
  没有连接或没有同步范围时直接提示去设置，不会起一个空会话
- **连接别名**：每个 GitLab 连接可设置「连接名称」（别名），列表、同步范围、同步对话框都按别名展示
- **多 GitLab 连接**：每个连接独立 baseUrl + Token（Token 按连接存凭据库），同步范围、候选仓库、任务历史、作者别名推断都按连接隔离
- **设置分区**：GitLab 连接、提交作者别名（可从 GitLab 推断）、时区/默认类型、模板与写作指引
- **9 个 Agent 工具**：`report_brief` / `report_commits` / `report_stats` / `report_update` /
  `report_list` / `report_get` / `report_export` / `report_delete` / `report_sync`

UI 走 DSH 三处插槽（`sidebar.panellist` / `main` / `settings.section`），样式只用
`--dsw-alias-*` 主题 token（亮暗跟随 DSH）。

## 安装

见 [INSTALL.md](INSTALL.md)。一句话：`plugin_manager install_bundle` 指向本包或
`release/local-dsh-report-<version>.tgz`。

## 配置

| 位置 | 内容 |
|---|---|
| 设置 →「报告与统计」 | GitLab 地址/Token、同步仓库范围、提交作者别名、时区/默认报告类型、模板与写作指引 |
| `<dataDir>/report.db` | 本地提交、报告、同步任务（SQLite WAL） |
| `<dataDir>/author-aliases.json` | 提交作者别名 |
| `<dataDir>/prompts.json` | 模板/写作指引覆盖 |
| DSH 凭据库 | `dsh-report/gitlab-token`（不落明文） |

机器相关配置默认值在 `cordis.patch.yml` 的 `dsh-report` 行；用户 profile 的补丁层可覆盖。

## 数据口径

- 日期一律 `YYYY-MM-DD`，按本机时区取 `00:00–23:59:59`；统计默认「不含合并和拣选」。
- 同步：`GET /projects/:id/repository/commits` 分页拉取，逐提交取 detail（stats）与 branch refs；
  merge / cherry-pick 标记按 commit message 逐条解析；大范围覆盖该区间本地数据。
- 生成：host 创建一个 DSH 会话，提示模型按 `report_brief → report_stats → report_commits →
  report_update` 链路工作；别名会写进提示，报告落 `reports` 表。

## 开发

```sh
node scripts/build-client.mjs   # client-src/*.js → lib/client.js
node test/run.mjs               # 单元/集成测试（node:test）
node build-release.mjs          # npm pack → release/*.tgz + SHA256SUMS.txt
```

目录：

```text
index.js            Host 入口（配置/服务/工具/HTTP 注册）
lib/                Host：db / gitlab / sync / api / tools / domain / services
lib/client.js       浏览器半（由 client-src 生成，勿手改）
client-src/         客户端源码（01 起分文件，99-apply 注册槽位）
test/               node:test 用例
docs/               设计与对齐计划
```

## 与 workbench 的关系

本插件把 workbench 的「报告」功能迁到 DSH：统计口径（`buildRealtimeAnalytics` 等）、
报告模板/写作契约、`report_*` 工具语义保持一致；UI 结构按 DSH 平台重排（不是逐像素复刻）。
统计页与 workbench 的差异计划见 [docs/STATS-PARITY-PLAN.md](docs/STATS-PARITY-PLAN.md)。
