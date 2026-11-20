#!/usr/bin/env node
/**
 * 拉取服务端需要的 ONNX 模型，供**构建镜像时内置**（`--build-context models=./models`）。
 *
 * 为什么模型不进 git：embed 213 MB + rerank ≈531 MB，进历史就再也删不掉了。
 * 为什么默认 ModelScope：历史实测 `modelscope.cn` 4.9–6.9 MB/s，而 HF 的 CDN 大文件
 * 曾出现"20 秒 0 字节"；`--source hf` 只作为备用。
 *
 * 用法：
 *   node scripts/fetch-models.mjs                    # 两个模型都拉，默认 modelscope
 *   node scripts/fetch-models.mjs --only embed       # 只拉嵌入模型（默认镜像只需要它）
 *   node scripts/fetch-models.mjs --source hf        # 换源
 *   node scripts/fetch-models.mjs --check            # 只校验本地是否齐全（不下载）
 *
 * 产出：
 *   models/embed/        model_fp16.onnx + tokenizer.json + tokenizer_config.json
 *                        + config.json + special_tokens_map.json
 *   models/rerank/       同上（重排模型）
 *   models/LICENSE.md    来源、许可、下载时间、文件大小与校验和
 *
 * 关键约束：**目录名与文件名不能改**。服务端 `embedder.py` 用 `basename(model_dir)=='model'`
 * 推导模型名，拼出的向量标签（tag）会与现网对不上 → 客户端全量重嵌。Dockerfile 里固定
 * `COPY --from=models /embed /models/model`，所以这里只管把文件放对、放全。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.resolve(HERE, '..', 'models')

const SOURCES = {
  modelscope: (repo, file) => `https://modelscope.cn/models/${repo}/resolve/master/${file}`,
  hf: (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`,
}

/** 每个模型：仓库、需要的文件、最小字节数（防止把 0 字节/错误页当成功） */
const MODELS = {
  embed: {
    title: 'bge-base-zh-v1.5（fp16，中文嵌入）',
    repo: 'Xenova/bge-base-zh-v1.5',
    dir: 'model', // 与镜像内路径 /models/model 一致：embedder 用 basename 推导模型名，改不得
    license: 'MIT',
    files: {
      'model_fp16.onnx': { remote: 'onnx/model_fp16.onnx', minBytes: 180 * 1024 * 1024 },
      'tokenizer.json': { remote: 'tokenizer.json', minBytes: 100 * 1024 },
      'tokenizer_config.json': { remote: 'tokenizer_config.json', minBytes: 200 },
      'config.json': { remote: 'config.json', minBytes: 200 },
      'special_tokens_map.json': { remote: 'special_tokens_map.json', minBytes: 50 },
    },
  },
  rerank: {
    title: 'bge-reranker-base（fp16，交叉编码器）',
    repo: 'Xenova/bge-reranker-base',
    dir: 'model-rerank',
    license: 'MIT',
    files: {
      'model_fp16.onnx': { remote: 'onnx/model_fp16.onnx', minBytes: 400 * 1024 * 1024 },
      'tokenizer.json': { remote: 'tokenizer.json', minBytes: 100 * 1024 },
      'tokenizer_config.json': { remote: 'tokenizer_config.json', minBytes: 200 },
      'config.json': { remote: 'config.json', minBytes: 200 },
      'special_tokens_map.json': { remote: 'special_tokens_map.json', minBytes: 50 },
    },
  },
}

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = path.resolve(arg('--out', DEFAULT_OUT))
const SOURCE = arg('--source', 'modelscope')
const ONLY = arg('--only', 'all')
const CHECK = argv.includes('--check')
const FORCE = argv.includes('--force')

if (!SOURCES[SOURCE]) {
  console.error(`未知 --source ${SOURCE}；可用：${Object.keys(SOURCES).join(' | ')}`)
  process.exit(1)
}
const names = ONLY === 'all' ? Object.keys(MODELS) : ONLY.split(',').map((s) => s.trim())
for (const n of names) {
  if (!MODELS[n]) {
    console.error(`未知 --only ${n}；可用：all | ${Object.keys(MODELS).join(' | ')}`)
    process.exit(1)
  }
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 下载一个文件：先写 .part，校验大小后再改名（中断不会留下看似完整的坏文件） */
async function download(url, dest, minBytes, attempt = 1) {
  const part = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(part, { force: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const out = fs.createWriteStream(part)
  let got = 0
  let last = Date.now()
  for await (const chunk of res.body) {
    out.write(chunk)
    got += chunk.length
    if (Date.now() - last > 3000) {
      last = Date.now()
      const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : ''
      process.stdout.write(`      ${mb(got)}${pct}\r`)
    }
  }
  await new Promise((r) => out.end(r))
  if (got < minBytes) {
    fs.rmSync(part, { force: true })
    // 小文件/错误页：重试一次再放弃（源站偶发 200 + 空 body）
    if (attempt < 2) {
      console.log(`\n      ⚠️ 只拿到 ${mb(got)}（期望 ≥ ${mb(minBytes)}），重试一次`)
      await sleep(1500)
      return download(url, dest, minBytes, attempt + 1)
    }
    throw new Error(`下载不完整：${mb(got)} < ${mb(minBytes)}（0 字节/错误页不要当成功）`)
  }
  fs.renameSync(part, dest)
  return got
}

const manifest = []
let failed = 0

for (const name of names) {
  const m = MODELS[name]
  const dir = path.join(OUT, m.dir)
  console.log(`\n=== ${name}：${m.title}  ← ${SOURCE}/${m.repo}`)
  const entries = []
  for (const [localName, spec] of Object.entries(m.files)) {
    const dest = path.join(dir, localName)
    const exists = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (exists >= spec.minBytes && !FORCE) {
      console.log(`  · ${localName} 已存在 ${mb(exists)}，跳过`)
    } else if (CHECK) {
      console.log(`  ✗ ${localName} 缺失或过小（${mb(exists)} < ${mb(spec.minBytes)}）`)
      failed++
      continue
    } else {
      const url = SOURCES[SOURCE](m.repo, spec.remote)
      console.log(`  ↓ ${localName}  ← ${url}`)
      try {
        const size = await download(url, dest, spec.minBytes)
        console.log(`  ✅ ${localName}  ${mb(size)}`)
      } catch (e) {
        console.log(`  ✗ ${localName} 下载失败：${e.message}`)
        failed++
        continue
      }
    }
    entries.push({ name: localName, bytes: fs.statSync(dest).size, sha256: await sha256(dest) })
  }
  manifest.push({ key: name, ...m, entries })
}

// 许可证与清单（镜像里会带上：/models/LICENSE.md）
if (!CHECK && failed === 0) {
  const lines = [
    '# 内置模型清单与许可',
    '',
    '本目录的模型由 `scripts/fetch-models.mjs` 下载，随镜像一起分发（不在 git 里）。',
    '',
    '| 模型 | 仓库 | 许可 | 文件 | 大小 | sha256 |',
    '|---|---|---|---|---|---|',
  ]
  for (const m of manifest) {
    for (const e of m.entries) {
      lines.push(`| ${m.title} | ${m.repo} | ${m.license} | ${m.dir}/${e.name} | ${mb(e.bytes)} | \`${e.sha256}\` |`)
    }
  }
  lines.push(
    '',
    `下载源：${SOURCE}（modelscope = https://modelscope.cn ，hf = https://huggingface.co）`,
    `下载时间：${new Date().toISOString()}`,
    '',
    'bge 系列模型由 BAAI 发布，采用 MIT 许可；本仓库只做 ONNX 转换后的分发，未修改权重。',
    '',
  )
  fs.writeFileSync(path.join(OUT, 'LICENSE.md'), lines.join('\n'))
  console.log(`\n✅ 清单已写：${path.relative(process.cwd(), path.join(OUT, 'LICENSE.md'))}`)
}

const totalBytes = manifest.reduce((n, m) => n + m.entries.reduce((k, e) => k + e.bytes, 0), 0)
console.log(`\n合计 ${mb(totalBytes)}${failed ? `，失败 ${failed} 项` : ''}`)
if (failed) process.exitCode = 1
