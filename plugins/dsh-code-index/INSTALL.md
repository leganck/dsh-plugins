# 安装与验证

## 0. 前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| Node | **≥ 23.4**（`node:sqlite` 免 flag 可用） | `node -v` |
| DSH | 已装的桌面版（profile `desktop`） | — |
| 平台 | Windows x64（GPU 走 DirectML）；其它平台可跑 CPU/int8 | — |

DSH 自带运行时里的 node 即可（本机为 v24.21.0）：
`C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

## 1. 放置插件

`C:\Users\you\dsh-bundles\dsh-code-index\`（工作区外，避免被工作区清理）

```
index.js  lib/  package.json  test.mjs  test-plugin.mjs  README.md
```

## 2. 安装依赖（661 MB，含全平台原生二进制）

```powershell
cd C:\Users\you\dsh-bundles\dsh-code-index
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
# 新版 npm 会拦 postinstall；onnxruntime-node 的原生二进制靠它下载，必须放行：
npm install-scripts approve onnxruntime-node
npm rebuild onnxruntime-node --foreground-scripts --registry=https://registry.npmmirror.com
# 校验 DirectML 就位（GPU 路径需要）
Test-Path .\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\DirectML.dll
```

## 3. 放置嵌入模型（可选；不做这步则只有关键词检索）

模型：`bge-small-zh-v1.5` 的 ONNX 版（Xenova 转换），放到
`C:\Users\you\.dsh\models\bge-small-zh-v1.5\`，需要这些文件：

| 文件 | 大小 | 用途 |
|---|---|---|
| `model_fp16.onnx` | 45.3 MB | GPU/DirectML 路径 |
| `model_int8.onnx` | 22.8 MB | CPU 路径 |
| `tokenizer.json` | 0.4 MB | 分词 |
| `tokenizer_config.json` | 367 B | transformers.js 需要（缺它会在加载时读不到 `tokenizer_class`） |

来源（PowerShell，走 ModelScope 国内镜像最快）：

```powershell
$b='https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master'
$d="$env:USERPROFILE\.dsh\models\bge-small-zh-v1.5"; New-Item -ItemType Directory -Path $d -Force | Out-Null
foreach($f in @('onnx/model_fp16.onnx','onnx/model_int8.onnx','tokenizer.json','tokenizer_config.json','config.json')){
  curl.exe -sSL -o (Join-Path $d (Split-Path $f -Leaf)) "$b/$f"
}
```

> 官方 `BAAI/bge-small-zh-v1.5` 仓库**只有 PyTorch 权重、没有 onnx**；onnx 在 `Xenova/bge-small-zh-v1.5`。

## 4. 注册到 profile

编辑 `C:\Users\you\.dsh\profiles\desktop\cordis.patch.yml`，在**末尾**追加：

```yaml
- insert:
    - id: code-index
      name: "file:///C:/Users/you/dsh-bundles/dsh-code-index/index.js"
      config:
        indexDirBase: "C:/Users/you/.dsh/code-index"
        roots:
          - "D:/Code"
        embedding:
          backend: "auto"
          modelDir: "C:/Users/you/.dsh/models/bge-small-zh-v1.5"
```

## 5. 重启 DSH 应用

**必须重启**：实测补丁层的热加载只对**已存在的**行生效，**新插入的行要重启才加载**。
（判定方式：看 `~/.dsh/code-index/_loaded.json` 是否出现、`loadedAt` 与 `pid` 是否是当前进程。）

## 6. 验证

```powershell
# ① 加载标记（插件自己写的，app 加载后才会出现）
Get-Content "$env:USERPROFILE\.dsh\code-index\_loaded.json" -Raw

# ② 用 file:// 直接导入，确认模块本身干净
node -e "import('file:///C:/Users/you/dsh-bundles/dsh-code-index/index.js').then(m=>console.log(m.BUILD))"
```

在 DSH 里依次调用：

```
code_index_status()                                   # 应报告"从未建库"
code_index(path="D:/Code/demo/svc/legacy-java-service")
code_search(query="<你仓库里某个类名或方法名>")
```

## 7. 回滚

1. 删掉 `cordis.patch.yml` 末尾的 insert 块（文件里有注释标明起止）
2. 重启应用
3. 可选：删除索引目录 `C:\Users\you\.dsh\code-index\`（或整个插件目录）

## 自测（不依赖 app）

```powershell
cd C:\Users\you\dsh-bundles\dsh-code-index
node test.mjs --repo D:\Code\your-repo          # 核心 32 项
node test-plugin.mjs --repo D:\Code\your-repo   # 插件接口 24 项
```
