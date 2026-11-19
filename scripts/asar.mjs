#!/usr/bin/env node
// Minimal asar reader: list entries matching a pattern, or extract files.
// Usage:
//   node scripts/asar.mjs list <asar> <substring-or-regex> [limit]
//   node scripts/asar.mjs extract <asar> <path-inside-asar> <dest-file>
import fs from 'node:fs'

const [, , cmd, asarPath, arg, arg2] = process.argv

function readHeader(p) {
  const fd = fs.openSync(p, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('cannot read header size')
    const s1 = sizeBuf.readUInt32LE(0) // pickle payload size
    const s2 = sizeBuf.readUInt32LE(4) // header size
    const headerBuf = Buffer.alloc(s2)
    if (fs.readSync(fd, headerBuf, 0, s2, 8) !== s2) throw new Error('cannot read header')
    const len = headerBuf.readUInt32LE(4)
    const json = headerBuf.toString('utf8', 8, 8 + len)
    return { header: JSON.parse(json), base: 8 + s2 }
  } finally {
    fs.closeSync(fd)
  }
}

function walk(node, prefix, out) {
  if (!node || !node.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size, offset: child.offset, unpacked: !!child.unpacked })
  }
}

const { header, base } = readHeader(asarPath)
const files = []
walk(header, '', files)

if (cmd === 'list') {
  const re = new RegExp(arg, 'i')
  const hits = files.filter((f) => re.test(f.path)).slice(0, Number(arg2 ?? 200))
  for (const f of hits) console.log(`${f.unpacked ? 'U' : ' '} ${f.size}\t${f.path}`)
  console.error(`total=${files.length} shown=${hits.length}`)
} else if (cmd === 'extract') {
  const entry = files.find((f) => f.path === arg)
  if (!entry) {
    console.error(`not found: ${arg}`)
    process.exit(1)
  }
  if (entry.unpacked) {
    const unpackedPath = asarPath.replace(/\.asar$/, '.asar.unpacked') + '\\' + arg.split('/').join('\\')
    fs.copyFileSync(unpackedPath, arg2)
  } else {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const buf = Buffer.alloc(entry.size)
      fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
      fs.writeFileSync(arg2, buf)
    } finally {
      fs.closeSync(fd)
    }
  }
  console.log(`extracted ${entry.path} -> ${arg2} (${entry.size} bytes)`)
} else {
  console.error('unknown command')
  process.exit(1)
}
