/**
 * 扫描边界自测：gitignore / cursorignore / docs / 禁用模块 / 二进制。
 * 无网络、无模型；跑一次 < 1s。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkRepo } from './lib/scan.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-ignore-'))
function mk(rel, text = '') {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}
function files(opts = {}) {
  return walkRepo(root, opts).map((f) => f.rel).sort()
}

mk('.gitignore', 'legacy/*\n!legacy/keep.groovy\ndocs/old.md\n')
mk('.cursorignore', 'docs/private.md\n')
mk('.cursorindexingignore', 'docs/secret.md\n')
mk('legacy/old.groovy', 'class Old {}')
mk('legacy/keep.groovy', 'class Keep {}')
mk('docs/a.md', '# a')
mk('docs/private.md', '# private')
mk('docs/secret.md', '# secret')
mk('docs/old.md', '# old')
mk('.cursorignore.note', 'not an ignore file')
mk('business-5.0/active/app.groovy', 'class App {}')
mk('business-5.0/legacy-groovy/old.groovy', 'class Legacy {}')
mk('business-5.0/assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
mk('business-5.0/data.bin', 'not in include')
mk('docs/note.docx', 'fake office bytes')
mk('src/App.java', 'class App {}')

console.log('\n[1] ignore + docs + include')
const base = files()
check('gitignore 排除 legacy/old', !base.includes('legacy/old.groovy'), base.join(','))
check('gitignore 反选保留 legacy/keep', base.includes('legacy/keep.groovy'), base.join(','))
check('cursorignore 排除 private.md', !base.includes('docs/private.md'), base.join(','))
check('cursorindexingignore 排除 secret.md', !base.includes('docs/secret.md'), base.join(','))
check('gitignore 排除 docs/old.md', !base.includes('docs/old.md'), base.join(','))
check('Markdown 文档默认索引', base.includes('docs/a.md'), base.join(','))
check('Office 文档不索引', !base.includes('docs/note.docx'), base.join(','))
check('禁用 Groovy 模块默认索引', base.includes('business-5.0/legacy-groovy/old.groovy'), base.join(','))
check('二进制伪装文本被跳过', !base.includes('business-5.0/assets/logo.png'), base.join(','))

console.log('\n[2] 显式排除禁用模块')
const excluded = files({ excludePaths: ['business-5.0/legacy-groovy'] })
check('excludePaths 排除禁用模块', !excluded.includes('business-5.0/legacy-groovy/old.groovy'), excluded.join(','))
check('active 模块保留', excluded.includes('business-5.0/active/app.groovy'), excluded.join(','))

console.log('\n[3] 关闭 ignore 恢复旧行为')
const noIgnore = files({ ignoreFiles: [], binarySniff: false })
check('ignoreFiles=[] 时 private.md 回来', noIgnore.includes('docs/private.md'), noIgnore.join(','))
check('ignoreFiles=[] 时 legacy/old 回来', noIgnore.includes('legacy/old.groovy'), noIgnore.join(','))
check('binarySniff=false 时不额外过滤（扩展名仍需在 include 内）', !noIgnore.includes('business-5.0/assets/logo.png'), noIgnore.join(','))

console.log('\n[4] 统计')
const all = walkRepo(root, {})
check('统计 ignored > 0', all.scanStats.ignored > 0, String(all.scanStats?.ignored))
check('按来源统计 cursorignore', all.scanStats.bySource.cursorignore >= 1, JSON.stringify(all.scanStats.bySource))
check('按来源统计 exclude', files({ excludePaths: ['business-5.0/legacy-groovy'] }).length > 0)
const exStats = walkRepo(root, { excludePaths: ['business-5.0/legacy-groovy'] }).scanStats
check('exclude 来源计数', exStats.bySource.exclude >= 1, JSON.stringify(exStats.bySource))

console.log('\n[5] 嵌套 .gitignore')
mk('nested/.gitignore', '*.tmp.md\n')
mk('nested/keep.md', '# keep')
mk('nested/drop.tmp.md', '# drop')
const nested = files()
check('嵌套 gitignore 生效', !nested.includes('nested/drop.tmp.md'), nested.join(','))
check('嵌套 gitignore 保留其他文件', nested.includes('nested/keep.md'), nested.join(','))

console.log(`\n通过 ${pass}，失败 ${fail}`)
if (fail) process.exitCode = 1
