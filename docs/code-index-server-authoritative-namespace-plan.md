# code-index：服务端权威 namespace + 运行时可观测性（0.14.0）

状态：已实现（2026-10-22）。关联破坏性变更：服务端 `server-v0.14.1`、插件 `code-index-v0.14.0`、review-service 同步升级。

## 1. 为什么改

档 3 的 canonical namespace 原先在两处实现：

- 客户端 `plugins/dsh-code-index/lib/scope.js` 的 `canonicalNamespace`；
- 服务端 `server/code-index-service/index_store.py` 的 `canonical_namespace`。

任何一处规则漂移都会产生"本地以为在写 A、服务端实际写 B"的静默错位。现在**服务端是唯一权威**：客户端只提交输入（`repoId`、`chunkFp`、原始 `scope`），服务端计算并返回 canonical namespace。

## 2. API（破坏性，无旧别名）

```text
POST /v1/namespaces/sync
  {repoId, chunkFp, scope?{kind,ref,commit?,ttlDays?}, namespace?, ...清单字段}
  -> {..., namespace}                 # 首次同步无需预先知道 namespace

POST /v1/namespaces/resolve
  {repoId, chunkFp, scope} -> {namespace, exists, revision?}

POST /v1/namespaces/{ns}/chunks
POST /v1/namespaces/{ns}/vectors
POST /v1/namespaces/{ns}/embed
GET  /v1/namespaces/{ns}/status
```

- `/v1/repos/*` 与 `/v1/namespaces/{ns}/sync` **已删除**，返回 `410 path-removed`。
- `namespace` 只作为显式逃生口；正常客户端不发送，服务端按 `repoId/chunkFp/scope` 计算。
- 客户端把响应里的 `namespace` 写入 `remote_namespace`，后续 chunks/embed/status 都用它。

## 3. 鉴权 / 数据范围

- 全局数据（`GET /v1/status`、`/v1/scopes`、`/v1/spaces`、`/v1/lineages/*`）和所有 `/v1/admin/*`、DELETE：仅管理员。
- 索引 Key：只访问 `/v1/namespaces/*`、`/v1/search`、`/v1/embed|/rerank`、`/v1/scopes/resolve`。
- Key 支持 `repoIds`；为空=不限。越权返回 404，不泄露 namespace 是否存在。
- `/health` 保持公开最小探活。

## 4. 运行时

- `GET /v1/admin/runtime`：CPU（cgroup v2 / `/proc/stat`）、内存（cgroup v2 / `/proc/meminfo`）、GPU（`nvidia-smi`）、ORT active/available providers。
- 控制台总览增加系统负载卡，5 秒轮询；CPU/GPU/内存超过阈值变色；GPU 不可见时明确显示 CPU-only。
- `POST /v1/admin/models/check`：切换/启用前预检，返回非阻塞 warnings：
  `embed-tag-change`、`dimension-change`、`cpu-runtime`、`provider-fallback`、`vram-low`、`rerank-cpu`。
- 切换模型弹确认框展示预检结果；仍允许继续切换。

## 5. 验证

```bash
# 服务端（不加载 ONNX）
cd server/code-index-service && FAKE_EMBED=1 python selftest.py
python scripts/check-admin-html.py

# 插件
pnpm --filter @local/dsh-code-index test

# review-service
cd server/review-service && python -m app.selftest
python tests/test_sync.py && python tests/test_report.py
```
