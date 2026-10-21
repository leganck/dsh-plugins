# 镜像标签矩阵（`ghcr.io/leganck/dsh-embed`）

> 目标：**标签只跟"运行时"增长，不跟"模型"增长。**
> 模型不进镜像矩阵，走 Release 资产 + 挂载（`compose.models.yaml` / `compose.jina.yaml`）。

## 常驻标签（用户只需要认这几个）

| 标签 | 内容 | 用途 |
|---|---|---|
| `latest-cpu` | CPU 运行时 + bge-base-zh-v1.5 | 默认推荐（开箱即用） |
| `latest-gpu` | GPU 运行时（CUDA 12 + ORT 1.19.2）+ bge | 大规模建库 / 高并发 |
| `base-cpu` / `base-gpu` | 只有运行时（无模型） | 配合挂载：jina / 重排 / 自定义模型 |
| ~~`latest-cpu-rerank` / `latest-gpu-rerank`~~ | **deprecated**（保留 1 个版本周期） | 重排改为挂载 `model-rerank`，缺省自动降级 |

## 版本 pin（每次 release 才产生）

```
server-vX.Y.Z-cpu / server-vX.Y.Z-gpu                    # 应用层
server-vX.Y.Z-base-cpu / server-vX.Y.Z-base-gpu          # 底座（一般不用）
```

需要"精确到某次构建"时用 **digest**，不再推 `sha-*` 标签。

## 已停止发布

| 内容 | 原因 | 替代 |
|---|---|---|
| `latest-jina-cpu` / `latest-jina-gpu`、`dsh-embed-jina-v*` | 模型不该进镜像矩阵 | `latest-*`（或 `base-*`）+ `compose.jina.yaml` + Release 资产 |
| `jina-cpu` / `jina-gpu` 简写别名 | 与 `latest-jina-*` 重复 | —— |
| `sha-*` | 每次构建 +2~4，永不过期 | `server-v*` 或 digest |
| `latest-*-rerank` | 与模型挂载重复 | `compose.models.yaml` 挂 `model-rerank` |

> 已存在的旧标签仍可拉取（**冻结**，不再更新）。清理需要 `write:packages` 权限：
> `gh auth refresh -h github.com -s write:packages` 后按下面命令删除，或在 GitHub Packages 页面手动删。

## 清理旧标签（需要权限）

```bash
# 列出所有 tag（匿名即可）
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:leganck/dsh-embed:pull&service=ghcr.io" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://ghcr.io/v2/leganck/dsh-embed/tags/list" | jq -r '.tags[]'

# 删除某个版本（按 tag 找到 version id；需要 read/write:packages）
gh api /users/leganck/packages/container/dsh-embed/versions --paginate \
  --jq '.[] | select(.metadata.container.tags[]? | test("^(sha-|jina-cpu|jina-gpu)$")) | .id' \
  | xargs -I{} gh api -X DELETE /users/leganck/packages/container/dsh-embed/versions/{}
```

## 部署示例

```bash
# 1) bge 开箱即用（默认）
docker run -d --name dsh-embed -p 127.0.0.1:18000:8000 \
  -v dsh-embed-data:/data ghcr.io/leganck/dsh-embed:latest-cpu

# 2) jina（同一镜像 + 挂载模型 + 几个环境变量）
node scripts/fetch-jina-model.mjs              # → models/model-jina/
docker run -d --name dsh-embed -p 127.0.0.1:18000:8000 \
  -v dsh-embed-data:/data \
  -v "$PWD/models/model-jina:/models/model:ro" \
  -e MODEL_NAME=jina-embeddings-v2-base-code \
  -e POOLING=auto -e QUERY_PREFIX= -e PAD_TOKEN='<pad>' -e PAD_ID=1 -e SEP_ID=0 \
  ghcr.io/leganck/dsh-embed:base-gpu            # 有 GPU 时

# 3) 重排（可选挂载，不挂自动降级）
-v "$PWD/models/model-rerank:/models/model-rerank:ro"

# compose 等价写法：
docker compose -f compose.yaml -f compose.gpu.yaml -f compose.jina.yaml up -d
```
