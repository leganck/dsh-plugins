# 插件源（DSH plugin market index）

DSH 的「插件源」就是**一个 JSON 文件**：用户在 Discover / Settings 里填它的 URL，Host 直接
`fetch`（**不跟随重定向**，只接受 http/https，无凭证），用 `@deepseek-ai/dsh-plugin-market-index`
按 **format 1** 校验，再给出每个版本的安装 target。安装本身仍走 `plugin_manager.installBundle`。

```
market/
  index.json        ← 插件源本体（生成物，别手改）
  build-index.mjs   ← 生成器：读 plugins/*/package.json + git HEAD
```

## 一句话用法

```sh
node market/build-index.mjs           # 改完代码 / 发版后重新生成
node market/build-index.mjs --check   # 只校验不写（可放进 CI）
```

然后把 `market/index.json` 推上去，"源地址"就是它的 raw URL：

```
https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json
```

在 DSH 里加：**Plugins → Discover → 添加源**，粘贴上面的 URL。
（本机 profile 已启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，所以 Discover 页可见。）

不想点 UI 也可以直接改 profile 补丁（`plugin-market` 行的 `indexes` 是 volatile 配置）：

```yaml
- id: plugin-market
  config:
    indexes:
      - "https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json"
```

## 为什么用 git 源而不是 npm 源

我们的包是 `"private": true`、没发 npm，所以每个版本用 **git 源**、**钉死 commit**：

```json
"source": {
  "type": "git",
  "url": "https://github.com/leganck/dsh-plugins.git",
  "commit": "<40 位小写 sha>",
  "path": "plugins/dsh-code-index"
}
```

DSH 会把它拼成 pnpm 规格交给安装器：

```
git+https://github.com/leganck/dsh-plugins.git#<commit>&path:/plugins/dsh-code-index
```

也就是说：**用户装到的是那个 commit 里的那个目录**，与主分支后续改动无关 —— 发版就要重新生成索引
（commit 变了）。以后真发 npm 了，把 `source` 换成 `{ "type": "npm", "registry": "https://..." }` 即可。

## format 1 的硬约束（踩了就装不上）

| 约束 | 说明 |
|---|---|
| `version` 必须是**精确 SemVer** | `0.10.0` ✅ / `^0.10.0`、`0.10` ❌ |
| `commit` 必须是**小写 40 位** | 生成器直接取 `git rev-parse HEAD` |
| `source.url` 必须 https + canonical + ≥2 段路径 + 不能是 tarball | `.../dsh-plugins.git` ✅ |
| 插件 `name` 必须是合法 npm 包名，且索引内唯一 | `@local/dsh-code-index` ✅ |
| `icon` 相对路径按**索引 URL** 解析 | 生成器写 `../plugins/<name>/icon.svg` → 解析到同源 https |
| 被引用的 `category` / `labels` / `sortKeys` id 必须先在 `metadata` 里声明 | 生成器统一声明 |

生成后建议用官方校验器验一遍（与 DSH 本体同一个包）：

```sh
npm i -D '@deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2'
node -e "import('@deepseek-ai/dsh-plugin-market-index').then(m => { const fs=require('node:fs');
  const idx = m.parseMarketIndex(JSON.parse(fs.readFileSync('market/index.json','utf8')), 'https://raw.githubusercontent.com/leganck/dsh-plugins/main/market/index.json');
  console.log('ok', idx.plugins.length) })"
```

## 发版流程

1. 改插件 → 提交；
2. `node market/build-index.mjs`（版本号取自各插件 `package.json`，commit 取 HEAD）；
3. 提交 `market/index.json` 并推送；
4. 用户在 Discover 里刷新即可看到 `update-available` / 新安装。

> 注意：安装器不会执行依赖脚本（DSH 默认拦），所以插件**不能依赖** `postinstall` 之类的钩子；
> 我们这个插件本来就是"按需安装依赖"（`code_index_deps`），不受影响。

## 已知限制

- 索引是**单文件全量**：插件多了要分页排序也只能在一个文件里；几千个插件没问题，上万个就要服务端协议了。
- 源**未签名**：索引里的 name/version 只是"声明"，真正装什么由被安装的 manifest 决定。
  所以我们把 `commit` 钉死，至少保证内容不可漂移。
- 仓库必须**公开**（Host fetch 不带凭证）。私有仓库需要另外的鉴权方案，本文件不覆盖。
