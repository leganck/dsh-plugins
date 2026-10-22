/**
 * 仓库级 simhash：给“跨 lineage 冷启动”找候选索引用。
 *
 * 它只是候选发现信号，不是存储键；真正 adopt 时还必须做 chunk hash 交集计算。
 * 两个变体：
 *  - path：包含仓库相对路径，适合同结构 clone / 分支 / fork；
 *  - content：只用文件内容哈希，适合路径被重命名的 vendor 副本。
 */
import { sha256 } from './chunker.js'

const BITS = 64

function feature(text) {
  return BigInt(`0x${sha256(text).slice(0, 16)}`)
}

function simhashOf(files, pick) {
  const scores = new Array(BITS).fill(0)
  for (const f of files) {
    const h = feature(pick(f))
    const size = Number(f.size) || 0
    const weight = Math.min(16, Math.log2(1 + size))
    for (let bit = 0; bit < BITS; bit += 1) {
      scores[bit] += h & (1n << BigInt(bit)) ? weight : -weight
    }
  }
  let out = 0n
  for (let bit = 0; bit < BITS; bit += 1) {
    if (scores[bit] >= 0) out |= 1n << BigInt(bit)
  }
  return out.toString(16).padStart(16, '0')
}

/**
 * @param {{path?:string,rel?:string,sha?:string,size?:number}[]} files 本地文件的 sha/size
 * @returns {{v:number,path:string,content:string,files:number}}
 */
export function computeSimhash(files) {
  const sorted = [...(files ?? [])].sort((a, b) => String(a.path ?? a.rel ?? '').localeCompare(String(b.path ?? b.rel ?? '')))
  const norm = sorted.map((f) => ({
    rel: String(f.path ?? f.rel ?? '').replace(/\\/g, '/'),
    sha: String(f.sha ?? ''),
    size: Number(f.size) || 0,
  }))
  return {
    v: 1,
    path: simhashOf(norm, (f) => `${f.rel}\u0000${f.sha}`),
    content: simhashOf(norm, (f) => f.sha),
    files: norm.length,
  }
}

export function hammingHex(a, b) {
  try {
    let x = BigInt(`0x${String(a)}`) ^ BigInt(`0x${String(b)}`)
    let n = 0
    while (x) {
      n += Number(x & 1n)
      x >>= 1n
    }
    return n
  } catch {
    return BITS
  }
}
