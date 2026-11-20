# 正文直读端点：`GET /v1/namespaces/{namespace}/bodies`

> 状态：已实现（`server.py` → `bodies_payload()` + `_do_GET` 路由）
> 自测：`python tests/test_bodies.py`（临时 SQLite，无需模型/网络）
> 相关：`IndexStore.bodies(lineage_id, hashes)`（`index_store.py`，按血统读 `blobs` 表）

## 1. 用途

`POST /v1/namespaces/{ns}/chunks` 只写正文、`GET /v1/namespaces/{ns}/status` 只报计数，
客户端拿不到「这个 hash 的正文是什么」。本端点补上这条读路径：**按内容哈希直读块正文**，
用于把检索结果（只有 hash/path/行号）还原成可展示、可重排、可喂给模型的文本。

设计口径：

- **内容寻址**：入参是 sha256 内容哈希，不是 path/行号；同一段代码换路径/行号仍是同一个 hash。
- **按血统取数**：`blobs` 以 `(lineage_id, hash)` 为主键，所以同一仓库的分支/克隆天然共享正文；
  但别的血统即使有同名 hash 也**不算命中**（如实进 `missing`）。
- **全部有界**：一次最多 200 个 hash、默认最多返回 200 KB；超预算的块不返回半截正文。

## 2. 请求

```
GET /v1/namespaces/{namespace}/bodies?hashes=h1,h2&max_bytes=N
```

### 2.1 鉴权

与其它 namespace GET 一致：`Authorization: Bearer <api key>`（index 或 admin 角色均可），
或后台会话 / HTTP Basic（`_api_ok() or _admin_ok()`）。
服务端一把 Key 都没配时保持开放（首次部署/自测口径，与 `/v1/search` 相同）。
若使用带 `repoIds` 限制的 index key，namespace 的 repoId 必须在白名单内，否则 `404`。

### 2.2 路径参数 `namespace`

canonical namespace，形如 `{repoId}@{chunkFp}#{kind}:{refToken}[~root:{sha8}]`
（见 `index_store.canonical_namespace`），例如 `demo@fp-bodies#main:default`。

**必须整体 URL 编码后作为单个 path segment**（`encodeURIComponent` / `urllib.parse.quote(ns, safe="")`）：

| 原始字符 | 编码 | 为什么 |
| --- | --- | --- |
| `/` | `%2F` | 不编码会被当成分段边界，路由解析失败 |
| `#` | `%23` | 不编码会被 `urlparse` 当 fragment 截掉，服务端只看到半截路径 |
| `@` `:` `~` | `%40` `%3A` `%7E`（可选） | 编码更稳，服务端 `unquote` 后还原 |

服务端解析方式与 `POST /v1/namespaces/{ns}/chunks` 完全一致：取 `/v1/namespaces/` 后
用 `rpartition("/")` 切出 `{ns}` 与 `bodies`，再 `unquote`。所以编码后的 namespace
里**不能出现裸 `/`**；`/v1/namespaces` 与 `/bodies` 之间必须恰好一个 segment。

> 注意：`#` 不编码时会被客户端/`urlparse` 当 fragment 截掉，服务端根本看不到 `/bodies` 后缀，
> 结果不是 400 而是通用 `404 {"error":"not found"}` —— 排查时先检查编码。

### 2.3 查询参数

| 参数 | 必填 | 默认 | 上限/规则 |
| --- | --- | --- | --- |
| `hashes` | 否 | `""`（空结果） | 逗号分隔；**去重后 ≤ 200 个**；每项必须是 64 位 hex（sha256）。空项/重复项丢弃不报错；非 hex 项进 `rejected` 且不查库。超 200 → `400 too-many-hashes`（不静默截断）。可重复传参（`hashes=a&hashes=b` 会拼接）。 |
| `max_bytes` | 否 | `200000` | 返回正文的累计 **UTF-8 字节**上限；非整数回落默认；clamp 到 `[1, 2000000]`。 |

### 2.4 示例

```bash
NS='demo@fp-bodies#main:default'
ENC=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$NS")

curl -s -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:8000/v1/namespaces/$ENC/bodies?hashes=$H1,$H2&max_bytes=200000"
```

JS（与插件 `lib/remote.js` 的 `NS_ENC` 同口径）：

```js
const enc = encodeURIComponent(ns);
const qs = new URLSearchParams({ hashes: [h1, h2].join(","), max_bytes: "200000" });
const r = await fetch(`${base}/v1/namespaces/${enc}/bodies?${qs}`, { headers });
```

## 3. 响应

`200 OK`（JSON）：

```json
{
  "namespace": "demo@fp-bodies#main:default",
  "lineage_id": "a1b2c3…",
  "requested": 3,
  "returned": 2,
  "missing": ["<64-hex 未入库的 hash>"],
  "truncated": ["<64-hex 因字节预算没返回的 hash>"],
  "rejected": ["<非法 hash 原文>"],
  "bodies": [{ "hash": "<64-hex>", "body": "<块正文原文>" }],
  "ms": 1.7
}
```

| 字段 | 含义 |
| --- | --- |
| `namespace` | 解码后的 namespace 原样回显 |
| `lineage_id` | 该 namespace 所属血统（正文就是按它取的） |
| `requested` | 去重 + 去掉非法项后**有效请求**的 hash 数 |
| `returned` | `bodies` 的长度 |
| `missing` | 合法但在本血统 `blobs` 里**没有**的 hash（按请求顺序） |
| `truncated` | 有正文但**超出 `max_bytes` 预算**没返回的 hash（按请求顺序） |
| `rejected` | 客户端传了但不是 64 位 hex 的项（原文回显，便于定位） |
| `bodies` | `[{hash, body}]`，**顺序 = 请求顺序**；`body` 与上传时逐字节一致 |
| `ms` | 服务端处理耗时（毫秒，1 位小数） |

不变量：`requested == returned + len(missing) + len(truncated)`（`rejected` 不在此等式内，
因为它不是有效请求）。

### 3.1 有界装入规则

按 `hashes` 的请求顺序逐个装：

1. 没正文 → `missing`；
2. `已用字节 + len(body UTF-8) > max_bytes` → `truncated`，**跳过该块**（不返回半截正文）；
3. 否则装入 `bodies` 并累加字节。

预算用完**不会提前中止**：后面的小块仍可能装得下（贪心装箱），所以 `truncated`
不一定是尾部的连续区间。

### 3.2 错误

| 状态 | body | 场景 |
| --- | --- | --- |
| `400` | `{"error":"bad-namespace-path","message":"namespace 必须是单个 URL segment"}` | namespace 未编码（含裸 `/`）或路径为空 |
| `400` | `{"error":"too-many-hashes","count":N,"limit":200}` | 去重后有效 hash 数 > 200 |
| `404` | `{"error":"not-found"}` | API key 的 `repoIds` 白名单不含该 repoId |
| `404` | `{"error":"unknown-namespace"}` | namespace 未注册（从没 sync 过） |
| `503` | `{"error":"not ready","detail":"…"}` | 服务端索引层尚未就绪（启动中/构建失败） |

## 4. 降级约定（调用方必读）

本端点是**尽力而为**的正文补全，不是一致性读：`missing`/`truncated` 都是正常业务态，
调用方必须能降级，不得把「拿不到正文」当失败重试打爆服务端。

| 情况 | 调用方应如何处理 |
| --- | --- |
| `missing` 非空 | 该块正文服务端确实没有（客户端还没 `POST …/chunks` 上传、或已被 GC/不同血统）。**不要重试**：先走 `POST /v1/namespaces/{ns}/chunks` 补正文；在此之前用本地已有正文（插件本地有 BM25 原文）或占位文案（如 path:start-end）降级展示。 |
| `truncated` 非空 | 是**客户端预算**问题，不是服务端错误。按 `bodies` 已返回的部分先渲染；剩余 hash **分批**再用更小的 `hashes` 集合重试（例如每批 50 个、`max_bytes` 调大但 ≤ 2000000），或只在用户展开时按需再取。**禁止**在循环里对同一批原样重试。 |
| `400 too-many-hashes` | 客户端 bug：请求前先分片（≤200）。不要靠提高上限绕过。 |
| `400 bad-namespace-path` | 客户端 bug：namespace 没做 `encodeURIComponent`。仓库名含 `/` 时尤其容易漏。 |
| `404 unknown-namespace` | 该 namespace 还不存在：先 `POST /v1/namespaces/sync`。不要重复 GET。 |
| `503 not ready` | 服务端启动中：指数退避（如 1s/2s/4s，最多 3 次）后降级为「无正文」模式。 |
| 整体超时/失败 | 与 `missing` 同级的降级：本次检索照常返回（hash/path/行号已在检索结果里），正文缺失不影响命中集合。 |

推荐口径：**正文是可选增强，检索结果（hash/path/start/end）才是主数据**。
任何情况下都不应因为拿不到正文而丢弃检索命中。

## 5. 边界与实现说明

- 上限是**代码里的死限制**（`MAX_BODIES_HASHES=200`、`BODIES_MAX_BYTES_DEFAULT=200000`、
  `BODIES_MAX_BYTES_LIMIT=2000000`），不进 admin 配置；要改走代码评审。
- URL 长度：200 × (64 hex + 1 分隔符) ≈ 13 KB 查询串，远低于服务端 `http.server`
  的 64 KB 请求行上限（`readline(65537)`，超了直接 414）；再长请客户端分片，
  **不要**试图调高服务端请求行上限。
- 统计：`_endpoint_group()` 把本端点归为 `bodies`，并计入 admin 统计的 `retrieval` 分类；
  请求会记到调用方 key 的 namespace 归属（与 `/v1/search` 同口径）。
- 劫持/越权：只按 `store.repo(namespace)` 得到的 `lineage_id` 取数，不接受调用方指定血统。
- 不返回 `path/start/end`：本端点只解决正文，位置元信息来自检索结果；需要时用 `/v1/search`。
