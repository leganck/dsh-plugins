#!/usr/bin/env node
/**
 * 下载 jina-embeddings-v2-base-code 的 ONNX 产物到 `models/model-jina/`，并校验 sha256。
 *
 * 模型不进 git（321 MB）；发布资产挂在 GitHub Release 上，本脚本负责取回 + 校验：
 *
 *   node scripts/fetch-jina-model.mjs                 # 默认从 dsh-embed-jina-v0.1.0 下载
 *   node scripts/fetch-jina-model.mjs --release xxx    # 指定 release tag
 *   node scripts/fetch-jina-model.mjs --check          # 只校验本地文件（CI 门禁用）
 *   node scripts/fetch-jina-model.mjs --from ./dir     # 从本地目录复制（离线/内部镜像）
 *
 * 校验清单：scripts/jina-v2.sha256（sha256sum -c 格式）。
 * 许可：jina-embeddings-v2-base-code 为 Apache-2.0；再分发见 docs/jina-v2.md。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = join(ROOT, 'models', 'model-jina')
const MANIFEST = join(HERE, 'jina-v2.sha256')
const DEFAULT_RELEASE = 'dsh-embed-jina-v0.1.0'
const REPO = process.env.JINA_REPO || 'leganck/dsh-plugins'

function args(argv) {
  const out = { check: false, from: '', release: DEFAULT_RELEASE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--release') out.release = argv[++i]
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

function loadManifest() {
  const lines = readFileSync(MANIFEST, 'utf8').split('\n')
  const out = []
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(\S+)\s*$/)
    if (m) out.push({ sha256: m[1], name: m[2] })
  }
  if (!out.length) throw new Error(`校验清单为空：${MANIFEST}`)
  return out
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolvePromise(h.digest('hex')))
  })
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`)
  const tmp = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  renameSync(tmp, dest)
}

function copyFrom(dir, name, dest) {
  const src = join(dir, name)
  if (!existsSync(src)) throw new Error(`源目录缺文件：${src}`)
  copyFileSync(src, dest)
}

async function main() {
  const opt = args(process.argv.slice(2))
  if (opt.help) {
    console.log('用法：node scripts/fetch-jina-model.mjs [--check] [--from DIR] [--release TAG]')
    return
  }
  const manifest = loadManifest()
  mkdirSync(OUT_DIR, { recursive: true })

  if (opt.check) {
    let bad = 0
    for (const item of manifest) {
      const p = join(OUT_DIR, item.name)
      if (!existsSync(p)) {
        console.error(`✗ 缺文件：${item.name}`)
        bad++
        continue
      }
      const got = await sha256File(p)
      if (got !== item.sha256) {
        console.error(`✗ 校验失败：${item.name}（期望 ${item.sha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`)
        bad++
      } else {
        console.log(`ok ${item.name}`)
      }
    }
    if (bad) process.exit(1)
    console.log(`✅ jina-v2 模型校验通过（${manifest.length} 个文件）`)
    return
  }

  const base = `https://github.com/${REPO}/releases/download/${opt.release}`
  for (const item of manifest) {
    const dest = join(OUT_DIR, item.name)
    if (existsSync(dest) && (await sha256File(dest)) === item.sha256) {
      console.log(`skip ${item.name}（已存在且校验通过）`)
      continue
    }
    rmSync(dest, { force: true })
    if (opt.from) {
      copyFrom(opt.from, item.name, dest)
    } else {
      console.log(`下载 ${item.name} ← ${opt.release}`)
      await download(`${base}/jina-v2-${item.name}`, dest)
    }
    const got = await sha256File(dest)
    if (got !== item.sha256) {
      rmSync(dest, { force: true })
      throw new Error(`校验失败：${item.name}（期望 ${item.sha256}，实际 ${got}）`)
    }
    console.log(`ok ${item.name} ${(statSync(dest).size / 1e6).toFixed(1)} MB`)
  }
  console.log(`\n✅ 模型已就绪：${OUT_DIR}`)
  console.log('构建镜像：')
  console.log('  docker buildx build --build-context models=./models --build-arg FLAVOR=gpu \\')
  console.log('    --target embed-jina -t dsh-embed:jina-gpu .')
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
