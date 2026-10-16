/**
 * 模型下载器：把 ONNX 模型拉到 `~/.dsh/models/<name>/`。
 *
 * ## 为什么固定走 ModelScope
 * 本机实测（同一台机器、同一时段）：
 *   - `hf-mirror.com`   → **不可用**：308 重定向后 **0 字节**；更早一次是 2.9–26 KB/s（151 s 才 429 KB）
 *   - `huggingface.co`  → 小文件能通；**CDN 上的大文件 20 秒 0 字节**（走 us.aws.cdn.hf.co）
 *   - `modelscope.cn`   → **4.9–6.9 MB/s**（266 MB 用 54 秒）
 * 所以默认源就是 ModelScope；`--source hf` 只在特殊情况下用。
 *
 * ## 为什么要写成脚本而不是两条命令
 * 踩过两次同一个坑：**把"0 字节"当成下载成功**。本脚本对每个文件校验
 * ① HTTP 状态 ② 实际字节数 ③ 与 `content-length` 是否一致 ④ 是否达到该文件的最小合理体积，
 * 任一不满足就**明确报错并非零退出**，不留下半个文件当成品。
 *
 * 用法：
 *   node tools/fetch-model.mjs --list
 *   node tools/fetch-model.mjs --check                          # 只校验本地已有文件
 *   node tools/fetch-model.mjs --model bge-small-zh-v1.5        # 默认 all（按需的量化版本都拉）
 *   node tools/fetch-model.mjs --model bge-small-zh-v1.5 --quant fp16
 *   node tools/fetch-model.mjs --model bge-reranker-base --quant int8
 *   node tools/fetch-model.mjs --model bge-small-zh-v1.5 --dry-run
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 模型清单：每个模型的必需文件、可选量化版本、以及各文件的最小合理体积（用于抓"0 字节/截断"） */
export const MODELS = {
  'bge-small-zh-v1.5': {
    repo: 'Xenova/bge-small-zh-v1.5',
    role: '嵌入模型（向量检索必需；插件默认找这个目录）',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json'],
    onnx: { fp16: 'onnx/model_fp16.onnx', int8: 'onnx/model_int8.onnx', q4: 'onnx/model_q4.onnx', quantized: 'onnx/model_quantized.onnx' },
    /** 一台机器**至少**要有的量化版本：GPU 走 fp16、CPU 走 int8（插件按 backend 选文件） */
    required: ['fp16', 'int8'],
    minBytes: {
      'config.json': 200,
      'tokenizer.json': 100_000,
      'tokenizer_config.json': 200,
      'onnx/model_fp16.onnx': 30_000_000,
      'onnx/model_int8.onnx': 15_000_000,
      'onnx/model_q4.onnx': 8_000_000,
      'onnx/model_quantized.onnx': 15_000_000,
    },
  },
  'bge-reranker-base': {
    repo: 'Xenova/bge-reranker-base',
    role: '交叉编码器（**实验性**：重排实测为净负收益，见 COMPARISON-CURSOR.md 第五节；插件不引用它）',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'],
    onnx: { int8: 'onnx/model_int8.onnx' },
    required: ['int8'],
    minBytes: {
      'config.json': 200,
      'tokenizer.json': 1_000_000,
      'tokenizer_config.json': 200,
      'special_tokens_map.json': 50,
      'onnx/model_int8.onnx': 200_000_000,
    },
  },
}

export const SOURCES = {
  modelscope: (repo, file) => `https://modelscope.cn/models/${repo}/resolve/master/${file}`,
  modelscopeApi: (repo, file) => `https://modelscope.cn/api/v1/models/${repo}/repo?Revision=master&FilePath=${file}`,
  hf: (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`,
}

/** 该模型默认要拉哪些文件。
 *  - `quant='all'`：清单里所有量化版本（下载用默认，保证换 backend 不用再下）
 *  - `quant='required'`：该机器**必需**的那几个（校验用；否则会把故意没下的变体报成失败）
 */
export function defaultFilesOf(name, quant = 'all') {
  const m = MODELS[name]
  if (!m) throw new Error(`未知模型：${name}（可用：${Object.keys(MODELS).join(', ')}）`)
  const onnx =
    quant === 'all'
      ? Object.values(m.onnx)
      : quant === 'required'
        ? (m.required ?? Object.keys(m.onnx)).map((q) => m.onnx[q])
        : [m.onnx[quant]].filter(Boolean)
  if (!onnx.length) throw new Error(`模型 ${name} 没有量化版本 ${quant}（可用：${Object.keys(m.onnx).join(', ') || '无'}）`)
  return [...m.files, ...onnx]
}

const mb = (n) => (n / 1048576).toFixed(1)

/** 下载单个文件；任何一步不合格都抛错，并且**删掉半成品** */
export async function fetchOne(url, dest, minBytes) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  const tmp = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const t0 = Date.now()
  const buf = Buffer.from(await res.arrayBuffer())
  const secs = (Date.now() - t0) / 1000
  if (!buf.length) throw new Error(`拿到 0 字节（源不可用？）  declared=${declared}`)
  if (declared && buf.length !== declared) throw new Error(`字节数不符：收到 ${buf.length}，声明 ${declared}`)
  if (minBytes && buf.length < minBytes) throw new Error(`体积过小：${buf.length} < 期望至少 ${minBytes}（可能被截断或是错误页面）`)
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return { bytes: buf.length, declared, secs, speed: buf.length / 1048576 / Math.max(secs, 0.001) }
}

function arg(k, d) {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const has = (k) => process.argv.includes(k)

async function main() {
  const modelDirBase = arg('--dir', path.join(os.homedir(), '.dsh', 'models'))
  const source = arg('--source', 'modelscope')
  const build = SOURCES[source]
  if (!build) throw new Error(`未知源：${source}（可用：${Object.keys(SOURCES).join(', ')}）`)

  if (has('--list')) {
    for (const [name, m] of Object.entries(MODELS)) {
      console.log(`  ${name}`)
      console.log(`    仓库：${m.repo}`)
      console.log(`    用途：${m.role}`)
      console.log(`    必需：${m.files.join(', ')}`)
      console.log(`    量化：${Object.entries(m.onnx).map(([q, f]) => `${q} → ${f}`).join('；') || '（无）'}`)
      console.log(`    目录：${path.join(modelDirBase, name)}\n`)
    }
    return
  }

  const name = arg('--model')
  const quant = arg('--quant', 'all')
  const dryRun = has('--dry-run')
  const checkOnly = has('--check')
  const targets = name ? [name] : Object.keys(MODELS)

  let bad = 0
  for (const n of targets) {
    const m = MODELS[n]
    // 校验模式默认只看"该模型必需的"量化版本（否则会把故意没下的变体报成失败）；
    // 显式传了 --quant 就按显式来。
    const q = checkOnly && !process.argv.includes('--quant') ? 'required' : quant
    const files = defaultFilesOf(n, q)
    const dir = path.join(modelDirBase, n)
    console.log(`──── ${n}（${checkOnly ? '校验' : dryRun ? '试运行' : '下载'}）→ ${dir}`)
    for (const f of files) {
      const dest = path.join(dir, f.replace(/^onnx\//, ''))
      const min = m.minBytes[f]
      if (checkOnly || dryRun) {
        const ok = fs.existsSync(dest)
        const size = ok ? fs.statSync(dest).size : 0
        const enough = ok && (!min || size >= min)
        console.log(`  ${enough ? '✅' : '❌'} ${path.basename(dest).padEnd(24)} ${ok ? `${mb(size)} MB` : '缺失'}${min && ok && !enough ? `（小于期望 ${mb(min)} MB）` : ''}`)
        if (!enough && !dryRun) bad++
        continue
      }
      try {
        const r = await fetchOne(build(m.repo, f), dest, min)
        console.log(`  ✅ ${path.basename(dest).padEnd(24)} ${mb(r.bytes)} MB  ${r.secs.toFixed(1)}s  ${r.speed.toFixed(2)} MB/s`)
      } catch (e) {
        console.log(`  ❌ ${path.basename(dest).padEnd(24)} ${String(e.message).slice(0, 120)}`)
        bad++
      }
    }
    console.log('')
  }
  if (bad) {
    console.error(`失败 ${bad} 项。源 ${source}：先换源试试（--source modelscope | hf）；不要把 0 字节当成功。`)
    process.exitCode = 1
  } else {
    console.log('全部就绪。')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`失败：${String(e.message)}`)
    process.exitCode = 1
  })
}
