/**
 * 确定性夹具仓库：给 CI 和"没传 --repo"的本地测试用。
 *
 * 为什么要它：`test.mjs` / `test-plugin.mjs` 都需要一个真实仓库来扫描、切块、建索引，
 * 以前靠 `--repo D:\Code\your-repo` 这种机器相关路径 —— 换台机器必挂，CI 更没法跑。
 *
 * 约束：
 *   - **确定性**：不写时间戳、不写随机串，同样的文件内容每次一样（测试可复现）
 *   - **有多语言**：.js/.ts/.tsx/.go/.java/.md，覆盖 AST 与启发式两条切块路径
 *   - **有可区分词**：`ZEPHYRQUARTZ` 之类的生造词，供 BM25 检索断言用，不和真实语料撞
 *
 * 用法：
 *   node scripts/ci-fixture.mjs            # 建到临时目录并打印路径
 *   node scripts/ci-fixture.mjs --dir X    # 建到指定目录（已存在则直接复用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 生造词：只出现在夹具里，检索断言不会误命中真实语料 */
export const MARKER = 'ZEPHYRQUARTZ'

const FILES = {
  'README.md': `# fixture repo

A tiny repository used by the DSH plugin test suites.
The distinctive token ${MARKER} must be findable by keyword search.
`,
  'src/util.js': `export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/\\s+/g, '-')
}

export function pairOf(name) {
  return { name, marker: '${MARKER}' }
}
`,
  'src/view.ts': `export interface Row {
  id: string
  title: string
}

export function renderRow(row: Row): string {
  return row.id + ':' + row.title
}
`,
  'src/widget.tsx': `import * as React from 'react'

export function Widget({ label }: { label: string }) {
  return <span className="widget">{label}</span>
}
`,
  'pkg/handler.go': `package pkg

// Handler answers one request.
func Handler(name string) string {
	return "ok:" + name
}
`,
  'service/Main.java': `package service;

public final class Main {
    public static void main(String[] args) {
        System.out.println("ok");
    }
}
`,
  'docs/note.md': `# note

${MARKER} appears once here so markdown chunking has something to find.
`,
}

/**
 * 建（或复用）夹具仓库。
 * @param {{dir?: string|null}} [opts]
 * @returns {string} 仓库绝对路径
 */
export function makeFixtureRepo({ dir = null } = {}) {
  const root = dir ? path.resolve(dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fixture-'))
  for (const [rel, body] of Object.entries(FILES)) {
    const target = path.join(root, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // 复用已有目录时也重写一遍：保证内容确定，不受上一次运行的干扰
    fs.writeFileSync(target, body)
  }
  return root
}

// 直接执行时：建夹具并打印路径
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf('--dir')
  const dir = i >= 0 ? process.argv[i + 1] : null
  const root = makeFixtureRepo({ dir })
  console.log(root)
}
