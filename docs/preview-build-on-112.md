# 112 本地构建方案：GitHub CI 构建 + 112 直建两条路（2026-11-20）

## 预研结论（已实测）

| 项 | 值 | 结论 |
|---|---|---|
| docker | client/server 29.5.2 | ✅ 新版 |
| buildx | v0.34.1 | ✅ 可用 |
| 磁盘 | 38G 用 64%（余 14G） | ✅ 够（镜像 779MB + 构建层 ~2G） |
| 内存 | 7.5G 总 / 892Mi 空闲 | ⚠️ 挖掘空间紧，但 base 层缓存构建不跑重任务 |
| CPU/架构 | 4 核 x86_64 | ✅ 与 CI 同架构 |
| ghcr 拉取 | 通（latest-cpu 刚拉成功） | ✅ base 镜像可直接 FROM |
| 已缓存镜像 | latest-cpu = server-v0.17.0-cpu（779MB） | ✅ 首次构建连 base 拉取都省了 |

## 方案：112 直建「预览镜像」（不走 GitHub CI）

GitHub CI 仍是**正式发版通道**（分层缓存+smoke 门禁），112 直建用于**预览**：
agent 改完代码 → rsync 到 112 → `docker build -f Dockerfile.app`（FROM 已缓存的 base）→
起预览容器（不同端口，如 18080）→ 浏览器看效果 → 满意再走正式 CI 发版。

### 优点
- 反馈环最短：改完 1-2 分钟出预览，不用等 CI 排队
- 不污染正式镜像 tag：预览用 `dsh-embed:preview`
- 数据隔离：预览容器挂**独立的空数据卷**（或只读挂现有卷的副本），不碰生产索引

### 预览部署形态

```bash
# 在 112 上执行（脚本化到 scripts/preview-deploy.sh）
mkdir -p /srv/dsh-preview && cd /srv/dsh-preview
# rsync 代码（本机执行）：rsync -az --delete server/code-index-service/ root@112:/srv/dsh-preview/src/
docker build -f src/Dockerfile.app \
  --build-arg BASE_IMAGE=ghcr.io/leganck/dsh-embed:server-v0.17.0-cpu \
  --build-arg VERSION=preview \
  --build-context models=src/models \      # 若无本地 models 目录则用 nomodel 目标
  -t dsh-embed:preview src/
docker rm -f dsh-embed-preview 2>/dev/null
docker run -d --name dsh-embed-preview -p 127.0.0.1:18080:8000 \
  -v dsh-embed-preview-data:/data \
  -e API_KEY=<预览KEY> -e ADMIN_USER=admin -e ADMIN_PASSWORD=<预览密码> \
  dsh-embed:preview
```

### 模型层问题
Dockerfile.app 的 embed 目标需要 models build context（213MB bge）。两个选项：
- **A（推荐）**：preview 用 `nomodel` 目标 + 挂载宿主机模型目录（若 112 上有导出的模型文件）；
  没有就从现有容器里 `docker cp dsh-embed:/models /srv/dsh-preview/models` **一次性拷出**（779MB，几秒），之后每次构建用本地 context，零下载。
- B：走 GitHub CI（模型在 actions/cache）——回到正式通道，不适合快速预览。

### 端口与凭据
- 预览端口 18080 只绑 127.0.0.1？——不行，用户要从工作机浏览器访问。绑 0.0.0.0:18080 但**必须带独立强 KEY**（预览库无敏感数据，且 admin 有密码）。
- 预览数据卷独立（dsh-embed-preview-data），想看真实数据时换 `--volumes-from` 只读参考——首版不做，空库+seed 灌入即可演示。

## 时机
现在 gov/dedup/ui2 三个 agent 还在改代码。等 ui2 回报并通过 Lead 抽验后执行首建：
1. `git archive` 当前工作区（含未提交改动）→ rsync 到 112
2. 首建 preview 镜像 + 起 18080 容器
3. `seed.py --url http://192.168.50.112:18080` 灌 223 条（预览库）
4. 用户浏览器开 `http://192.168.50.112:18080/admin` 看 v3

## 回滚
预览容器独立，`docker rm -f dsh-embed-preview` 即撤；生产容器（18000）全程不动。
