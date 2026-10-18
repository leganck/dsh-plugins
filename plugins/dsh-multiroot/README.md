# dsh-multiroot

> **接入状态**：已可被插件源发现（`market/index.json` 含 `@local/dsh-multiroot`），
> 但尚未在 profile 安装；`root_write` / `root_edit` / `root_run` 仅有设计，未实现。


Cursor 式「多目录工作空间」的 DSH 插件 —— **目前是骨架**。

设计出自 [`docs/analysis/`](docs/analysis/)（`multi-root-workspace.md` 是可行性分析，
`plugin-multiroot-design.md` 是实现设计）。

## 现在能用什么

- **根注册表**：从会话目录向上找 `.dshworkspace.json`（最多 `maxUpLevels` 层），
  或用插件配置的内联 `roots`；都没有则退化为"单根 = 会话当前目录"。
- **`workspace_roots` 工具**：列出 `id / 绝对路径 / 是否只读 / 主根`，以及这份定义从哪来。
  多根场景下先让它确认根 id，再按根行动。

`.dshworkspace.json` 放在工作空间锚点目录（通常就是你会话打开的目录），随仓库提交：

```json
{
  "version": 1,
  "primary": "app",
  "roots": [
    { "id": "app",  "path": ".",                          "label": "本仓" },
    { "id": "oss",  "path": "D:/oss/microservice-a" },
    { "id": "spec", "path": "C:/Users/legan/Documents/spec", "readonly": true }
  ]
}
```

| 字段 | 规则 |
|---|---|
| `id` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，全局唯一 —— 模型只该记住这个名字 |
| `path` | 绝对路径，或**相对定义文件所在目录**（`"."` = 锚点自身）；必须是存在的目录 |
| `readonly` | `true` = 写/改/跑一律拒绝（服务端硬拒，不靠提示词）——**当前只是注册表里记录的语义**，`root_write/edit/run` 尚未实现 |
| `primary` | 必须是某个 id；缺省 = 第一个根 |

校验失败**大声点名**字段路径（如 `roots[1].id 必须是 …`），不静默降级。

## 还没实现（设计已定，见 design 文档）

- `root_write` / `root_edit` / `root_run`：每次调用把 `sandboxPolicy.workspaceRoot` 切到目标根
  （§3 工具族 / §4 沙箱语义）。这三个必须有测试覆盖"越界拒绝"才上线。
- 提示词注入（`systemPrompt.context` 里一段 "Workspace roots: …"）。
- Client 半（UI）：侧栏列出多个根、切换主根。
- code-index 桥：让它从同一份定义读 `roots`（可选，收益大）。

## 自测

```sh
node test.mjs     # 25 项：发现/校验/优先级/工具调用
```
