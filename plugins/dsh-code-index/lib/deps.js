/**
 * 嵌入依赖的**按需**安装与解析。
 *
 * ## 为什么不写在 package.json 里
 *
 * 早期实现把 `onnxruntime-node` 与 `@huggingface/transformers` 声明为 `optionalDependencies`，
 * 于是**每次装插件都要**：下载并落盘 463 MB；触发构建脚本审批（pnpm 与 npm 都会拦）；
 * 最坏情况撞上服务侧空闲超时（实测 pnpm 打印完 `Done in 2s` 却不退出 → 10 分钟超时 → 安装回滚）。
 *
 * 2026-10-16 实测确认了三条关键事实，于是改成按需：
 *
 * 1. **onnxruntime-node 的 npm 包自带各平台二进制**（`bin/napi-v6/{darwin,linux,win32}/{arm64,x64}`，
 *    43 个文件、解压 301 MB）。它的 `postinstall` 只是"若缺则从 NuGet 补下载"——
 *    **不跑脚本也能用**：实测 `--ignore-scripts` 装完后 `require('onnxruntime-node')` 成功、
 *    `env.versions={common:1.30.0,node:1.30.0}`、`listSupportedBackends()` 返回
 *    `[cpu(bundled), dml(bundled), webgpu(bundled)]` —— **DirectML 也在**。
 * 2. 所以可以 `npm install --ignore-scripts`，**完全不触发构建脚本审批**。
 * 3. 同一份安装里非本平台的二进制占大头，可安全修剪：实测 463.2 MB → 240.1 MB（省 223 MB），
 *    修剪后分词与后端枚举仍然正常。
 *
 * ## 本模块的边界
 *
 * - **不自动安装**：`installDeps()` 只被显式动作调用（工具参数 / 用户要求），绝不在 apply 时或
 *   建库过程中偷偷跑。缺依赖时调用方走"纯 FTS5 降级 + 如实报告原因"。
 * - **解析顺序**：受管目录优先，其次包内 `node_modules`（兼容旧安装形态）。
 * - 目录默认放 `%LOCALAPPDATA%\dsh-code-index\embed-deps`（Windows）/ `~/.cache/...`（POSIX）：
 *   不进 `$DSH_HOME`（避免与 profile 混在一起），更不进代码仓库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 固定版本：可复现优先。onnxruntime-node 1.30.0 是实测 `dml` 可用的那版。 */
export const EMBED_PACKAGES = [
  { name: 'onnxruntime-node', version: '1.30.0' },
  { name: '@huggingface/transformers', version: '3.8.1' },
]

export const MANIFEST_NAME = 'deps.json'
export const SCHEMA_VERSION = 1

/** 默认受管目录 */
export function defaultDepsDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-code-index', 'embed-deps')
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'dsh-code-index', 'embed-deps')
}

export function manifestPath(dir) {
  return path.join(dir, MANIFEST_NAME)
}

export function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))
  } catch {
    return null
  }
}

export function writeManifest(dir, data) {
  const m = { schema: SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...data }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + '\n', 'utf8')
  return m
}

/** 目录体积（跳过软链，避免跟出去） */
export function dirSizeBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
        } catch {
          /* 忽略竞态 */
        }
      }
    }
  }
  return total
}

/**
 * 解析器链：受管目录优先，其次插件自身目录（兼容把依赖装在包内的旧形态）。
 * 用 `createRequire(<dir>/package.json)` 而不是 `import(spec)`：ESM 的裸标识符解析
 * 以**导入方文件**为基准，装到受管目录后是解析不到的。
 */
export function makeResolvers({ depsDir, alsoDirs = [] } = {}) {
  const resolvers = []
  for (const d of [depsDir, ...alsoDirs]) {
    if (!d) continue
    try {
      resolvers.push(createRequire(path.join(d, 'package.json')))
    } catch {
      /* 目录不存在时 createRequire 仍可创建，这里只是防御 */
    }
  }
  return resolvers
}

/** 按解析器链加载一个包；全失败则抛出最后一个错误 */
export function loadFrom(resolvers, spec) {
  let last
  for (const req of resolvers) {
    try {
      return req(spec)
    } catch (e) {
      last = e
    }
  }
  throw last ?? new Error(`无法解析 ${spec}`)
}

/**
 * 读受管目录里某个包的版本。
 *
 * **不要**用 `require.resolve('<pkg>/package.json')`：包可以用 `exports` 字段不暴露 `./package.json`
 * （`@huggingface/transformers` 就是如此），那样会把"已安装"误判成"缺失"——
 * 本函数的测试抓到过这个 bug。直接按 npm 的扁平布局读文件即可。
 */
function pkgVersion(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 依赖现状。**不抛错**——缺依赖是正常状态（插件要能降级）。
 */
export function depsStatus({ depsDir, alsoDirs = [] } = {}) {
  const dir = depsDir ?? defaultDepsDir()
  const resolvers = makeResolvers({ depsDir: dir, alsoDirs })
  const packages = []
  const missing = []
  for (const { name, version } of EMBED_PACKAGES) {
    // 先看受管目录里有没有（这才是"按需安装"的对象）
    const inManaged = pkgVersion(dir, name)
    const resolvable = resolvers.length
      ? (() => {
          try {
            loadFrom(resolvers, name)
            return true
          } catch {
            return false
          }
        })()
      : false
    const entry = { name, wanted: version, installedInManagedDir: inManaged, resolvable }
    packages.push(entry)
    if (!inManaged) missing.push(name)
  }
  const exists = fs.existsSync(dir)
  return {
    dir,
    dirExists: exists,
    installed: missing.length === 0,
    missing,
    packages,
    sizeBytes: exists ? dirSizeBytes(dir) : 0,
    manifest: readManifest(dir),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
  }
}

/** 构造 npm 安装参数（抽出来是为了能单测，不必真跑网络） */
export function buildInstallArgs({ dir, registry, packages = EMBED_PACKAGES }) {
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir]
  for (const p of packages) args.push(`${p.name}@${p.version}`)
  if (registry) args.push('--registry', registry)
  return args
}

/**
 * 在 Windows 上**不能**用 `execFile('npm.cmd')`：Node ≥20.12 出于 CVE-2024-27980 直接 EINVAL
 * （实测：`npm.cmd` → EINVAL、`npm` → ENOENT、`cmd.exe /d /s /c npm …` → 成功）。
 */
export function npmInvocation(args) {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `npm ${args.join(' ')}`] }
  }
  return { file: 'npm', argv: args }
}

/**
 * 按需安装。**只在显式动作里调用**。
 * @returns {Promise<{ok:boolean, note:string, status?:object, stdout?:string}>}
 */
export async function installDeps({ depsDir, registry, log = () => {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const dir = depsDir ?? defaultDepsDir()
  if (!dir) return { ok: false, note: '未指定依赖目录' }
  fs.mkdirSync(dir, { recursive: true })
  // npm 需要一个 package.json 才不会往上层找
  const pj = path.join(dir, 'package.json')
  if (!fs.existsSync(pj)) {
    fs.writeFileSync(pj, JSON.stringify({ name: 'dsh-code-index-embed-deps', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  const args = buildInstallArgs({ dir, registry })
  const { file, argv } = npmInvocation(args)
  log(`安装嵌入依赖到 ${dir}（${EMBED_PACKAGES.map((p) => `${p.name}@${p.version}`).join(', ')}）`)
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await run(file, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    const st = depsStatus({ depsDir: dir })
    const saved = { installedAt: new Date().toISOString(), packages: EMBED_PACKAGES, sizeBytes: st.sizeBytes }
    writeManifest(dir, saved)
    return {
      ok: st.installed,
      note: st.installed
        ? `安装完成：${EMBED_PACKAGES.map((p) => `${p.name}@${p.version}`).join(', ')}；${(st.sizeBytes / 1048576).toFixed(1)} MB，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s（未执行任何依赖脚本）`
        : `安装结束但仍有缺失：${st.missing.join(', ')}`,
      status: st,
      stdout: String(stdout ?? '') + String(stderr ?? ''),
    }
  } catch (e) {
    return {
      ok: false,
      note: `安装失败：${String(e.message).slice(0, 300)}`,
      stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 4000),
      status: depsStatus({ depsDir: dir }),
    }
  }
}

/**
 * 修剪非本平台的二进制。
 *
 * 实测收益：463.2 MB → 240.1 MB（省 223 MB），修剪后分词与后端枚举仍正常。
 * 只动 `<任意>/onnxruntime-node/bin/napi-v<数字>/<平台>/<架构>/` 这一种形状，其它一律不碰。
 *
 * 注意：npm 只在"包树变化"时重装，**不会**因为文件被删而自动恢复，
 * 所以需要恢复时用 `installDeps` 前先 `removeDeps`（见 `repairDeps`）。
 */
export function pruneForeignPlatforms(dir) {
  const removed = []
  let freed = 0
  const keepPlatform = process.platform
  const keepArch = process.arch
  /** 认定"这是我们要修剪的原生包"的路径特征：避免误删无关目录下的同名结构（本函数自己的测试抓到过） */
  const NATIVE_PKG_SEGMENT = `${path.sep}onnxruntime-node${path.sep}`
  const candidates = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      const p = path.join(cur, e.name)
      if (/^napi-v\d+$/.test(e.name)) {
        if (p.includes(NATIVE_PKG_SEGMENT)) candidates.push(p)
      } else stack.push(p)
    }
  }
  for (const binDir of candidates) {
    let plats = []
    try {
      plats = fs.readdirSync(binDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const p1 of plats) {
      if (!p1.isDirectory()) continue
      const p1p = path.join(binDir, p1.name)
      if (p1.name !== keepPlatform) {
        freed += dirSizeBytes(p1p)
        try {
          fs.rmSync(p1p, { recursive: true, force: true })
          removed.push(p1p)
        } catch {
          /* 占用中则跳过 */
        }
        continue
      }
      let arches = []
      try {
        arches = fs.readdirSync(p1p, { withFileTypes: true })
      } catch {
        continue
      }
      for (const p2 of arches) {
        if (!p2.isDirectory() || p2.name === keepArch) continue
        const p2p = path.join(p1p, p2.name)
        freed += dirSizeBytes(p2p)
        try {
          fs.rmSync(p2p, { recursive: true, force: true })
          removed.push(p2p)
        } catch {
          /* 占用中则跳过 */
        }
      }
    }
  }
  if (removed.length) {
    const m = readManifest(dir) ?? {}
    writeManifest(dir, { ...m, prunedFor: `${keepPlatform}-${keepArch}`, prunedAt: new Date().toISOString(), freedBytes: freed })
  }
  return { removed, freedBytes: freed, kept: `${keepPlatform}-${keepArch}` }
}

/** 整目录删除（修复/卸载用） */
export function removeDeps(dir) {
  if (!fs.existsSync(dir)) return { removed: false, note: `目录不存在：${dir}` }
  const bytes = dirSizeBytes(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return { removed: true, freedBytes: bytes, note: `已删除 ${dir}（回收 ${(bytes / 1048576).toFixed(1)} MB）` }
}

/** 修复 = 删掉再装（解决"修剪过、想恢复别平台"与"装坏了"两种情况） */
export async function repairDeps(opts = {}) {
  const dir = opts.depsDir ?? defaultDepsDir()
  const r = removeDeps(dir)
  const out = await installDeps({ ...opts, depsDir: dir })
  return { ...out, note: `${r.note}；${out.note}` }
}
