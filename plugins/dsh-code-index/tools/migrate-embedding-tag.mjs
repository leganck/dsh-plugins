/**
 * 一次性迁移：把全局向量缓存的 key 前缀从"旧 tag"改成"新 tag"。
 *
 * ## 为什么需要它
 * 0.4.6 起 `modelTag` 里加入了**模型文件内容哈希**（`bge-small-zh-v1.5-<sha8>-fp16`），
 * 目的是让"同 tag ⇔ 同一份模型（含分词器）"跨机器成立。但 tag 变了 → 历史向量的 key
 * 前缀也随之变化 → 如果不迁移，几十万条历史向量会**因为前缀不同而全部用不上**（重算纯属浪费，
 * 它们本来就是同一份模型算出来的）。
 *
 * ## 做法
 * key 的形状是 `<tag>:<sha256(文本)>`，尾巴不变，只有前缀变 → 一条 `UPDATE` 原地改前缀即可
 * （用 UPDATE 而不是"插新删旧"，避免文件体积短暂翻倍）。
 *
 * ## 用法
 *   node tools/migrate-embedding-tag.mjs [--dry-run] [--model-dir <dir>] [--cache <db>]
 *
 * 可重复执行（第二次会因为找不到旧前缀而报 0 条）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sqliteDriver } from '../lib/store.js'
import { modelFingerprint } from '../lib/embedder.js'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}
const dryRun = argv.includes('--dry-run')
const modelDir = arg('--model-dir', path.join(os.homedir(), '.dsh', 'models', 'bge-small-zh-v1.5'))
const cachePath = arg('--cache', path.join(os.homedir(), '.dsh', 'index', 'vectors.db'))

if (!fs.existsSync(cachePath)) {
  console.error(`缓存不存在：${cachePath}`)
  process.exit(1)
}

/** 旧 tag 的精度后缀 → 对应的模型文件（决定用哪个文件算指纹） */
const QUANTS = [
  { quant: 'fp16', file: 'model_fp16.onnx' },
  { quant: 'int8', file: 'model_int8.onnx' },
]

const db = new (sqliteDriver())(cachePath)
console.log(`缓存：${cachePath}`)
console.log(`模型目录：${modelDir}`)
console.log(`模式：${dryRun ? '试运行（不写入）' : '正式执行'}\n`)

let totalUpdated = 0
db.exec('begin')
try {
  for (const { quant, file } of QUANTS) {
    const oldTag = `bge-small-zh-v1.5-${quant}`
    const modelPath = path.join(modelDir, file)
    if (!fs.existsSync(modelPath)) {
      console.log(`  ${quant}: 跳过（找不到 ${file}）`)
      continue
    }
    const newTag = `bge-small-zh-v1.5-${modelFingerprint(modelDir, file)}-${quant}`
    const before = Number(db.prepare('select count(*) n from vec where key like ?').get(`${oldTag}:%`).n)
    if (!before) {
      console.log(`  ${quant}: 无旧前缀条目（${oldTag}）`)
      continue
    }
    // key = `<tag>:<hex>` → 保留 `:hex`，只换前缀
    const res = db
      .prepare('update or replace vec set key = ? || substr(key, ?) where key like ?')
      .run(newTag, oldTag.length + 1, `${oldTag}:%`)
    console.log(`  ${quant}: ${oldTag}  →  ${newTag}   迁移 ${res.changes} 条（命中旧前缀 ${before} 条）`)
    totalUpdated += Number(res.changes)
  }
  if (dryRun) {
    db.exec('rollback')
    console.log(`\n试运行完成：本应迁移 ${totalUpdated} 条（已回滚）`)
  } else {
    db.exec('commit')
    console.log(`\n迁移完成：共 ${totalUpdated} 条`)
  }
} catch (e) {
  try {
    db.exec('rollback')
  } catch {
    /* ignore */
  }
  console.error(`失败并回滚：${String(e.message).slice(0, 200)}`)
  process.exitCode = 1
} finally {
  const n = Number(db.prepare('select count(*) n from vec').get().n)
  console.log(`当前缓存条目数：${n}`)
  db.close()
}
