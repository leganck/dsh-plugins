# 多根工作空间调研（存档，未实施）

> **状态：仅调研，未落地。** 本目录是 2026-10 对"Cursor 式多目录工作空间"的取证与设计稿，
> 结论是**不做本体改造**，改为"每仓库一个索引 + `subagent({cwd})` + 变更账本"的轻量路线。
> 代码里没有 `dsh-workspace` 插件；README / 安装流程也不引用本目录。

## 文档索引

| 文件 | 内容 |
|---|---|
| [`multi-root-workspace.md`](multi-root-workspace.md) | 总报告：DSH 单根假设的五个落点、Cursor 能力缺口矩阵、两条改造路线与成本 |
| [`plugin-multiroot-design.md`](plugin-multiroot-design.md) | 插件式多根的完整设计（根注册表、工具、管线、UI 分层、成本附录） |
| [`A-host-path-sandbox.md`](A-host-path-sandbox.md) | Host 侧取证：`workingDirectory`、`sandboxPolicy`、`ctx.fs`、工具层 cwd |
| [`B-client-ui.md`](B-client-ui.md) | Client/Web 侧取证：Slot 树、Remote 面、设置页挂载点 |
| [`C-plugin-impact.md`](C-plugin-impact.md) | 对本仓两个插件的改造影响面与打包约定 |
| [`design/host-tools-contract.md`](design/host-tools-contract.md) | Host ToolDefinition / 观察 / 审批 / shell 契约参考 |
| [`design/client-ui-contract.md`](design/client-ui-contract.md) | Client 设置 / Remote / Tab / Slot 契约参考 |

## 为什么保留

- `design/*` 两份契约是通用的 DSH 扩展性参考，即使不做多根也有复用价值；
- 若将来真要实现多根，`plugin-multiroot-design.md` 可直接作为起点；
- 历史结论（不改造本体）可避免重复调研。

## 为什么没进 README

本仓库定位是"可安装的插件分发"，不是 DSH 扩展性研究仓。为保持根目录干净，
调研稿统一收在 `docs/` 下，不与 `plugins/`、`server/` 混在一起。
