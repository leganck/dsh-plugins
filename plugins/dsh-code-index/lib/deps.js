/**
 * 可选语法解析依赖（tree-sitter）的**按需**安装与解析。
 *
 * 0.10.0 起本地嵌入已移除，本模块只服务于 AST 切块；`embed` 组（onnxruntime-node +
 * @huggingface/transformers）已删除。目录名 `embed-deps` 是历史遗留，不再有嵌入依赖。
 *
 * ## 为什么不写进 package.json
 *
 * 重依赖会让每次装插件都下载/落盘数百 MB，并可能触发构建脚本审批或安装超时。
 * parser 组约 60 MB，只有用户显式 `code_index_deps action=install` 时才下载。
 *
 * ## 本模块的边界
 *
 * - **不自动安装**：`installDeps()` 只被显式动作调用（工具参数 / 用户要求），绝不在 apply 时或
 *   建库过程中偷偷跑。缺依赖时调用方走"heuristic 降级 + 如实报告原因"。
 * - **解析顺序**：受管目录优先，其次包内 `node_modules`（兼容旧安装形态）。
 * - 目录默认放 `%LOCALAPPDATA%\dsh-code-index\embed-deps`（Windows）/ `~/.cache/...`（POSIX）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 依赖**分组**：按需安装到同一个受管目录，共用一套解析器链。
 *
 * - `parser`：语法解析（tree-sitter + 各语言语法）→ 约 61 MB，用于 AST 切块
 *
 * 版本必须**同年代配对**：运行时 `tree-sitter@0.21.1` 配 0.21.x 的语法包。
 * 实测踩坑（2026-10-16）：`tree-sitter-java@0.23.5` 声称 `peerOptional tree-sitter@^0.21.1`，
 * 但它的预构建与 0.21.1 运行时不兼容——`setLanguage` 不报错、`parse` 也不报错，
 * **读取节点时**才炸出 `Cannot read properties of undefined (reading '138')`（那个数字是节点类型 id）。
 * 换成同年代的 0.21.0 后一切正常。**改版本时务必四个包一起验一次解析**。
 */
export const DEP_GROUPS = {
  parser: [
    { name: 'tree-sitter', version: '0.21.1' },
    { name: 'tree-sitter-java', version: '0.21.0' },
    { name: 'tree-sitter-javascript', version: '0.21.4' },
    { name: 'tree-sitter-typescript', version: '0.21.2' },
    // Groovy：本机 Grails 项目的主力语言（实测 legacy-java-service 里 .groovy 144 个 > .java 94 个）。
    // 该包 peer 正是 ^0.21.1 且带 win32-x64 预构建；导出形状是 {language, nodeTypeInfo}（**没有 name**），
    // 按我们的教训"整个元数据对象传给 setLanguage"实测可用（识别出 class_declaration / method_declaration）。
    { name: 'tree-sitter-groovy', version: '0.1.2' },
  ],
  /**
   * 按语言拆开的**可选**语法组：`code_index` 检测到仓库里有对应扩展名、但没装时会提示，
   * 用户只装自己要的那一个（2.7 / 5.8 / 10.8 MB），而不是被绑着下一个 19 MB 的大礼包。
   * 版本必须与 tree-sitter@0.21.1 同年代（最新 0.25.x 的 peer 是 ^0.25，会逼着升级运行时）。
   */
  'parser-go': [{ name: 'tree-sitter-go', version: '0.21.2' }],
  'parser-python': [{ name: 'tree-sitter-python', version: '0.21.0' }],
  'parser-rust': [{ name: 'tree-sitter-rust', version: '0.21.0' }],
}

/** 三个可选语法组一起装（= 老版本"全装 parser"的行为） */
DEP_GROUPS['parser-extra'] = [...DEP_GROUPS['parser-go'], ...DEP_GROUPS['parser-python'], ...DEP_GROUPS['parser-rust']]

/** 全部依赖包（跨组去重） */
export function allPackages() {
  const seen = new Map()
  for (const list of Object.values(DEP_GROUPS)) for (const p of list) seen.set(p.name, p)
  return [...seen.values()]
}

/** 依赖组名（供工具参数枚举） */
export const GROUP_NAMES = Object.keys(DEP_GROUPS)

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
 *
 * 顶层 `installed` / `missing` / `packages` 指的是 `group` 指定的那一组（默认 `embed`，
 * 保持旧调用可用）；`groups` 里两组都有。
 */
export function depsStatus({ depsDir, alsoDirs = [], group = 'parser' } = {}) {
  const dir = depsDir ?? defaultDepsDir()
  const resolvers = makeResolvers({ depsDir: dir, alsoDirs })
  const groups = {}
  for (const [g, pkgs] of Object.entries(DEP_GROUPS)) {
    const packages = pkgs.map(({ name, version }) => {
      let resolvable = false
      try {
        loadFrom(resolvers, name)
        resolvable = true
      } catch {
        resolvable = false
      }
      const actual = pkgVersion(dir, name)
      // **必须比对版本**。只判"在不在"会漏掉最要命的情况：受管目录里是别的版本。
      // 对 tree-sitter 尤其致命——运行时与语法包是 ABI 配对的，版本错位不会在
      // setLanguage/parse 时报错，而是读取节点时才炸（见本文件顶部注释）。
      const versionMatches = actual === version
      return { name, wanted: version, installedInManagedDir: actual, versionMatches, resolvable, ready: Boolean(actual) && versionMatches && resolvable }
    })
    groups[g] = {
      installed: packages.every((p) => p.ready),
      missing: packages.filter((p) => !p.installedInManagedDir).map((p) => p.name),
      mismatched: packages.filter((p) => p.installedInManagedDir && !p.versionMatches).map((p) => `${p.name}（装了 ${p.installedInManagedDir}，需要 ${p.wanted}）`),
      broken: packages.filter((p) => p.installedInManagedDir && p.versionMatches && !p.resolvable).map((p) => p.name),
      packages,
    }
  }
  const g = groups[group] ?? groups.embed
  const exists = fs.existsSync(dir)
  return {
    dir,
    dirExists: exists,
    group,
    installed: g.installed,
    missing: g.missing,
    mismatched: g.mismatched,
    broken: g.broken,
    packages: g.packages,
    groups,
    sizeBytes: exists ? dirSizeBytes(dir) : 0,
    manifest: readManifest(dir),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
  }
}

/** 构造 npm 安装参数（抽出来是为了能单测，不必真跑网络） */
export function buildInstallArgs({ dir, registry, packages = DEP_GROUPS.parser }) {
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
 * 按需安装某个依赖组（或 `all`）。**只在显式动作里调用**。
 */
export async function installDeps({ depsDir, registry, group = 'parser', log = () => {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const dir = depsDir ?? defaultDepsDir()
  if (!dir) return { ok: false, note: '未指定依赖目录' }
  const packages = group === 'all' ? allPackages() : DEP_GROUPS[group]
  if (!packages) return { ok: false, note: `未知依赖组：${group}（可用：${GROUP_NAMES.join(', ')}, all）` }
  fs.mkdirSync(dir, { recursive: true })
  // npm 需要一个 package.json 才不会往上层找
  const pj = path.join(dir, 'package.json')
  if (!fs.existsSync(pj)) {
    fs.writeFileSync(pj, JSON.stringify({ name: 'dsh-code-index-deps', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  const args = buildInstallArgs({ dir, registry, packages })
  const { file, argv } = npmInvocation(args)
  log(`安装 ${group} 依赖到 ${dir}（${packages.map((p) => `${p.name}@${p.version}`).join(', ')}）`)
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await run(file, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    const st = depsStatus({ depsDir: dir, group })
    const prev = readManifest(dir) ?? {}
    writeManifest(dir, {
      ...prev,
      installedAt: new Date().toISOString(),
      lastGroup: group,
      groups: { ...(prev.groups ?? {}), [group]: packages.map((p) => `${p.name}@${p.version}`) },
      sizeBytes: st.sizeBytes,
    })
    return {
      ok: st.installed,
      note: st.installed
        ? `安装完成（${group}）：${packages.map((p) => `${p.name}@${p.version}`).join(', ')}；累计 ${(st.sizeBytes / 1048576).toFixed(1)} MB，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s（未执行任何依赖脚本）`
        : `安装结束但仍有缺失：${st.missing.join(', ')}`,
      status: st,
      stdout: String(stdout ?? '') + String(stderr ?? ''),
    }
  } catch (e) {
    return {
      ok: false,
      note: `安装失败：${String(e.message).slice(0, 300)}`,
      stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 4000),
      status: depsStatus({ depsDir: dir, group }),
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
  const keepCombo = `${keepPlatform}-${keepArch}`

  /** 只处理两种已知形状，路径特征不匹配的一律不碰（本函数自己的测试抓到过误删） */
  const findDirs = (predicate, mustContain) => {
    const found = []
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
        if (predicate(e.name) && p.includes(mustContain)) found.push(p)
        else stack.push(p)
      }
    }
    return found
  }

  const drop = (target) => {
    freed += dirSizeBytes(target)
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      /* 占用中则跳过 */
    }
  }

  // 形状 ①：onnxruntime-node/bin/napi-v<N>/<platform>/<arch>/
  for (const binDir of findDirs((n) => /^napi-v\d+$/.test(n), `${path.sep}onnxruntime-node${path.sep}`)) {
    for (const p1 of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (!p1.isDirectory()) continue
      const p1p = path.join(binDir, p1.name)
      if (p1.name !== keepPlatform) {
        drop(p1p)
        continue
      }
      for (const p2 of fs.readdirSync(p1p, { withFileTypes: true })) {
        if (p2.isDirectory() && p2.name !== keepArch) drop(path.join(p1p, p2.name))
      }
    }
  }

  // 形状 ②：tree-sitter 语法包的 prebuilds/<platform>-<arch>/
  for (const pb of findDirs((n) => n === 'prebuilds', `${path.sep}tree-sitter`)) {
    for (const e of fs.readdirSync(pb, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== keepCombo) drop(path.join(pb, e.name))
    }
  }

  if (removed.length) {
    const m = readManifest(dir) ?? {}
    writeManifest(dir, { ...m, prunedFor: keepCombo, prunedAt: new Date().toISOString(), freedBytes: (m.freedBytes ?? 0) + freed })
  }
  return { removed, freedBytes: freed, kept: keepCombo }
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
  const out = await installDeps({ ...opts, depsDir: dir, group: opts.group ?? 'all' })
  return { ...out, note: `${r.note}；${out.note}` }
}
