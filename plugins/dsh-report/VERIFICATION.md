# 验收证据矩阵（objective ↔ 证据）

> 目标：在 DSH 中交付完整可用的报告插件（复刻 workbench「报告」全部功能，独立 DSH bundle，安装到当前 profile，Web UI 验证）。
> 更新时间：2026-11-06

## 1. GitLab 提交同步

| 项 | 证据 | 状态 |
|---|---|---|
| GitLab 客户端 6 端点 / 分页头 / 重试 / 超时 | `lib/gitlab.js`；`test/data` 55+ 用例 | ✅ |
| 同步编排（范围/候选/任务/覆盖度/取消/部分失败语义） | `lib/sync.js`；`test/data/sync.test.mjs` 56 用例 | ✅ |
| 端到端（Mock GitLab → 插件 HTTP → 落库 → 统计） | `node scripts/e2e-mock-sync.mjs`：19/19 断言通过；202 拉取 / 190 入库 / 2 仓库 / 103 活跃日 | ✅（本地 mock） |
| 真实 GitLab | 需要地址 + token；等待用户提供 | ⏳ 外部依赖 |

## 2. 确定性统计与主题

| 项 | 证据 | 状态 |
|---|---|---|
| Go→JS 领域移植（分类/行数口径/主题/周期/业务域） | `lib/domain/*`；`test/domain` 98 用例；Go 实机对拍 0 diff（day-commits 49/49） | ✅ |
| 实时统计 `/line-stats` | 实测 200：`190 commits / 2 repos / 6 branches / 17 merge / 10 cherry` | ✅ |
| 某天提交 `/reports/day-commits` | 实测 200（字段齐全、repo 过滤生效）；非法日期 400 | ✅ |
| 报告统计投影 | `persist.js` + API `/reports/:id/stats`：lineStats/topics/repoBranchStats 落库可读 | ✅ |

## 3. 报告生成与改写

| 项 | 证据 | 状态 |
|---|---|---|
| 生成编排（prompt + 会话创建 + 轮询） | `lib/services.js` `generateReport`；`scripts/smoke-host.mjs` 用 stub sessionController 验证 `generate-session-created` | ✅（离线） |
| 改写/保存（report_update 同周期覆盖） | `lib/tools.js` + `test/api/tools.test.mjs` 83+ 用例 | ✅ |
| 真实模型生成一次完整报告 | 需要创建 DSH 会话（消耗模型），等待用户确认 | ⏳ 外部依赖 |

## 4. UI（列表/详情/统计/同步/设置）

| 项 | 证据 | 状态 |
|---|---|---|
| 组件实现 | `client-src/*` 10 文件 → `lib/client.js`（269KB） | ✅ |
| 视觉对齐 workbench | `_ref/DESIGN-NOTES.md`（实测布局/颜色/字号）；四态截图 `_ref/fw-*.png` | ✅ |
| 渲染自测 | `node scripts/visual-check.mjs`（headless Edge）四态无异常 | ✅ |
| 真实 DSH 注册 | client inspect：`sidebar.panellist#dsh-report`、`main#dsh-report`、`settings.section#dsh-report` 三处均 active；左侧栏已出现「报告与统计」入口 | ✅ |
| 真实 DSH 目视 | 客户端热更新已在页面生效（`client-hello` 记录）；点左侧栏「报告与统计」即可看到面板，待用户确认视觉效果 | ⏳ 用户动作 |
| 暗色主题 | 主要表面已改用 DSH theme token（`--dsw-alias-*`），新增配色为数据色 | ✅/部分 |

## 5. 9 个 Agent 工具

| 项 | 证据 | 状态 |
|---|---|---|
| 注册与 schema | `lib/tools.js`；`test/api/tools.test.mjs`；host 启动日志 `tools-registered count=9`；Tool inspect 可见 `report_*` | ✅ |
| 只读/写并发标记、导出 32k 截断、hint 原文 | 同上 | ✅ |

## 6. 模板与写作契约

| 项 | 证据 | 状态 |
|---|---|---|
| 模板/guidance 来自 Go 源，支持覆盖与清空 | `lib/domain/templates*`、`lib/config.js`；`PUT /templates` 部分更新实测 200 | ✅ |
| 设置页可编辑/保存 | `client-src/80-sync.js` SettingsPage；渲染自测通过 | ✅ |

## 7. Bundle / 安装

| 项 | 证据 | 状态 |
|---|---|---|
| `dsh.bundle` + `dsh.client` | `package.json`、`cordis.patch.yml` | ✅ |
| 安装到当前 profile | `plugin_manager install_bundle` → `application: applied`；`include:dsh-report` active | ✅ |
| 构建 | `node scripts/build-client.mjs`；`node --check lib/client.js` | ✅ |
| 测试总览 | 全量 `node --test`：243/243 | ✅ |

## 8. 当前 profile 的运行状态

- 启动：`apply-entered(build 0.1.0) → db-open → tools-registered(9) → apply-finished`，`reports=1`
- HTTP：`/ping`、`/config`、`/templates`、`/line-stats`、`/sync/jobs`、`/gitlab/connections`、`/sync/coverage`、`/reports/day-commits` 全部 200
- 数据：库内留有 Mock GitLab demo 数据（2 仓库 / 190 提交 / 1 份演示周报），用 `node scripts/clear-demo-data.mjs` 清理

## 剩余两项（外部依赖）

1. **刷新 DSH 页面**（Ctrl+R）后目视确认新 UI —— 客户端模块只在页面加载时读取。
2. **真实 GitLab 同步** + **真实模型生成报告** —— 需要用户提供 token / 授权创建会话。


## 提交作者别名（2026-11-06 17:4x）

| 验收点 | 证据 | 状态 |
|---|---|---|
| 推断算法单测 | `test/data/author-aliases.test.mjs` 8 条：已知身份过滤、计数阈值/相对截断、已有别名去重、缺失提交容错 | ✅ |
| host 端点 | GET 200 → PUT 200 往返一致；无连接时 POST 返回 400「还没有 GitLab 连接，请先在设置里保存连接」 | ✅ |
| 真实链路（Mock GitLab） | 建 mock 连接后 POST suggest：8 个 push 事件 / 8 个头提交，候选 `other@example.com`、`同事甲`（各 8 次），message「已推断 other@example.com、同事甲，可写入别名后保存」 | ✅ |
| 生成提示 | 别名非空时附加「【本人提交作者别名】…（这些作者身份提交的提交也算本人的工作。）」到 report session prompt | ✅ |
| 设置 UI | 「提交作者别名」区块：别名 textarea +「从 GitLab 推断」+「保存别名」+ 候选列表；样式对齐交付台账 | ✅（headless 截图 `_ref/fw-settings.png`） |
| 测试 | 全量 251/251 | ✅ |

## 真实环境端到端（2026-11-07）

| 验收点 | 证据 | 状态 |
|---|---|---|
| 真实 GitLab 连接 | `/gitlab/connections` → `https://process.smartpos.top/git1`，用户 `lailiqiang`，hasToken=true | ✅ |
| 真实同步（窗口 1） | 36 仓库 2026-11-02~11-08 → succeeded，137 提交 | ✅ |
| 真实同步（窗口 2） | 38 仓库 2025-11-02~2026-11-08 → succeeded，3,681 提交 / 0 错误 | ✅ |
| 真实统计接口 | `/line-stats` 近 12 个月：3,861 提交 / 27 仓库 / 71 分支 / +2,396,442 −1,900,017 | ✅ |
| 真实报告生成 | `week:2026-11-02:2026-11-08` 由真实模型生成，147 提交 / 12 仓库 / 25 分支，报告详情统计 tab 显示真实聚合 | ✅ |
| 真实作者别名推断 | `POST /gitlab/suggest-author-aliases` → 150 个 push 事件 / 110 个头提交，无新候选（账号身份已覆盖），无报错 | ✅ |
| 多连接解析 | `gitlabForConnection` 读 connections 表 base_url，config 仅回退 | ✅ |
| 客户端注册 | client inspect：`sidebar.panellist#dsh-report`、`main#dsh-report`、`settings.section#dsh-report` 均 active | ✅ |
| 真实 UI 使用 | 用户侧截图/操作：仓库树、同步对话框、生成报告、报告详情统计 tab 均为真实数据 | ✅ |
| 全量测试 | 251/251（含 8 条作者别名推断单测） | ✅ |

### 已知遗留

- 统计页仍有产品级细化项（M2/M3）：日期范围控件、报告统计与统计页联动等，见 `docs/plugin-extraction/STATS-PARITY-PLAN.md`
- 暗色主题未在真实页面实测
- 2 份演示报告（`week:2026-10-19`、`week:2026-10-26`）由 Mock 数据生成，交付前可清理
