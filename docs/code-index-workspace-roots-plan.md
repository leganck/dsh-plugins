# roots 自动推导计划与实施记录

- 状态：已实施（0.13.1）
- 日期：2026-10-22

## 目标

删除用户配置里的 `roots`，允许路径从 DSH workspace / 会话 cwd / `.dshworkspace.json` 自动推导。

## 规则

```text
workspaceRoot = ctx sandboxPolicy.workspaceRoot
sessionCwd    = exec.agent.session.cwd ?? exec.cwd ?? process.cwd()
定义文件      = 从 sessionCwd 向上查找 .dshworkspace.json

允许路径 = workspaceRoot ∪ sessionCwd ∪ 定义文件.roots
没有信息时只允许 sessionCwd，不允许任意路径
```

## 实现

- 新增 `lib/workspace-roots.js`：
  - `findWorkspaceDefinition`
  - `normalizeWorkspaceDefinition`
  - `resolveAllowedRoots`
  - `isInsideRoots`
- `assertAllowed(repoRoot, exec)` 按当前工具调用动态计算允许根；`sandboxPolicy.resolve({session})` 优先，apply 阶段没有 session 时退回默认 workspaceRoot；
- 四个工具（index/search/map/status）传入 `exec`；
- 自动 watcher 内部使用 `{ trusted: true }`，registry 中已索引仓库继续监听；
- 旧 `roots` 配置保留一版兼容：接受但忽略，启动 warning；
- `code_index_status` 输出“允许路径”；
- `_loaded.json` 改为记录 `workspaceRoots` / `workspaceSources`。

## 迁移

本地 profile 删除：

```yaml
roots: [ "D:/Projects", "D:/oss" ]
```

创建项目级多根声明：

```json
// D:/Projects/.dshworkspace.json
{
  "version": 1,
  "roots": [
    { "id": "projects", "path": "." },
    { "id": "oss", "path": "D:/oss" }
  ],
  "primary": "projects"
}
```

## 验证

- `test-workspace-roots.mjs` 17 项；
- 全量插件测试；
- 本地安装 0.13.0 后验证 workspace 内路径通过、外部路径拒绝；
- 发布 market 与 GitHub tag。
