# server/ — 两个 Python 服务

本目录只放**服务端**（Python）。DSH 插件在 `plugins/`，两者通过 HTTP（`/v1/*`）交互，不要互相 import。

| 服务 | 端口（宿主） | 镜像 | 职责 | 入口 |
|---|---|---|---|---|
| `code-index-service/` | `18000` | `ghcr.io/leganck/dsh-embed` | 远端索引层：`/v1/namespaces/*`（sync / search / status）、`/embed`、`/rerank`、控制台 | `server.py` |
| `review-service/` | `18001` | `ghcr.io/leganck/dsh-review` | GitLab MR AI 评审：webhook → 取 diff → 语法图/上下文 → 并行流水线 → 评审报告 | `app/server.py` |

两个服务都是**单进程 Python + SQLite/文件卷**，不依赖 DSH runtime；部署方式是容器（`deploy/` 下的 compose）。

## 目录约定

两个服务从 2026-11 起遵循同一布局：

```
<service>/
  *.py / app/      # 运行期代码
                   #   code-index：13 个平铺模块（server.py 用动态 _load() 按名加载 knn/governor/…，
                   #              且 Dockerfile 的 COPY 契约就是这几个文件名，故不打包成 app/）
                   #   review：app/ 包（python -m app.server）
  tests/           # 测试：code-index 是 selftest.py（FAKE_EMBED，不需要模型）；
                   #       review 是 pytest + fixtures
  deploy/          # 部署文件：compose*.yaml、.env.example、legacy/（历史路径）
  docs/            # 设计/实测文档
  scripts/         # 辅助脚本（拉模型、导出、压测、P0 原型 spikes）
  Dockerfile       # 镜像定义（code-index 另有 Dockerfile.app：分层发布用）
  README.md        # 配置项、运行、排障
```

## 快速开始

```bash
# code-index（CPU 开箱即用；默认拉 GHCR latest-cpu，数据在 dsh-embed-data 卷）
cd server/code-index-service
cp deploy/.env.example deploy/.env          # 填 API_KEY / ADMIN_PASSWORD
docker compose -f deploy/compose.yaml up -d
curl -s http://127.0.0.1:18000/health | head -c 400

# review-service
cd server/review-service
cp deploy/.env.example deploy/.env          # 填 GitLab / LLM 凭据
docker compose -f deploy/compose.yaml up -d
```

GPU / 模型挂载 / Jina 变体等叠加方式见 `code-index-service/README.md` 的「部署」一节。

## 自测（不需要模型/外部服务）

```bash
# code-index：256 项，FAKE_EMBED=1（不加载 ONNX）
cd server/code-index-service && python tests/selftest.py

# review-service：pytest
cd server/review-service && python -m pytest tests -q
```

CI（`.github/workflows/ci.yml`）跑的就是这两条。

## 发布

| 工作流 | 触发 | 产物 |
|---|---|---|
| `publish-image.yml` | tag `server-v*` / 手动 | `dsh-embed`：base → app（cpu/gpu + 模型变体），容器内自测通过才推 |
| `publish-review-image.yml` | tag `review-v*` / 手动 | `dsh-review` |

通用流程：先构建 base（改动 Dockerfile 依赖层才会重建）→ app 只叠加代码与模型 → 容器内跑 `selftest.py` → 推 GHCR。
细节见 `code-index-service/docs/image-matrix.md`。
