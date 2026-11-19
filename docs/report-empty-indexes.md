# 空索引库报告（只统计，不删除）

- 扫描时间：**2026-11-18 17:16:06（UTC+8）**
- 扫描根：`C:\Users\leganck\.dsh\code-index\*\index.db`（索引库根，等同插件 `advanced.indexDirBase`）
- 结论：**23 个索引库，9 个有内容、14 个 0 行**；其中 **8 个是真空壳**、**6 个是正在建的库**（别删）。
- 处置建议：**5 个建议删除**、**3 个建议保留并重建**、6 个在建**等待建完**。
- 空间收益很小（空壳合计 **368 KB**，占全部 187.3 MB 的 0.2%）；真正的收益是**去掉误报**——
  这些库存在但 0 块，会让 `code_index_status` 显示「有库」、而 `code_search` 报「该目录还没有索引」。

**本报告不执行任何删除；下面所有命令都只是「建议」，未运行。**

---

## 1. 判定口径

| 项 | 口径 |
| --- | --- |
| 行数 | 只读打开 `index.db`，`SELECT COUNT(*) FROM files` / `FROM chunks` |
| 空库 | `files = 0` 且 `chunks = 0`（有库文件、没内容） |
| **空壳 vs 在建** | 0 行且 **`index.db` mtime 早于 30 分钟** → 空壳；最近 30 分钟内创建/改动（通常同目录还有 `index.db-wal`）→ **在建，勿删** |
| 源目录反推 | 库目录名 = `<仓库名>-<sha1(Windows 绝对路径)前8位>`；9 个候选路径全部用 sha1 复算校验通过（`9/9 OK`） |
| 注册表印证 | `repos.json` 现有 9 条登记，**与 9 个非空库一一对应**；8 个空壳全部**不在**注册表里 |
| 成因线索 | 空壳的 `meta` 表只有 `schema_version`（没有 `repo_root` / `last_build_at`）→ 从没写入过文件记录 |

---

## 2. 空壳（8 个，建议处置）

| # | 库目录 | 源目录（sha1 反推） | files | chunks | 大小 | mtime | 判定 | 原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `CHGJ-3750-d7277185` | `D:\work\bug-analysis\CHGJ-3750` | 0 | 0 | 60 KB | 11-18 11:47 | **建议删除** | 工单临时目录（非 git 仓，28 个文件：11 py / 6 无扩展名 / 3 html / 2 json / 2 txt / 1 md）。这类单文件脚本用 grep 更快，索引没有收益 |
| 2 | `TEST-DISP-02-aa397207` | `D:\work\bug-analysis\TEST-DISP-02` | 0 | 0 | 60 KB | 11-18 11:47 | **建议删除** | **源目录已不存在**（改名或已删），库是纯残留，永远不可能有内容 |
| 3 | `chgj-3791-fbdd6c23` | `D:\work\bug-analysis\chgj-3791` | 0 | 0 | 60 KB | 11-18 11:47 | **建议删除** | 对应 `CHGJ-3791`（路径用小写传的），目录里只有 1 个 json；非 git 仓、临时目录 |
| 4 | `evidence-5d31dcd0` | `D:\work\bug-analysis\chgj-3735\evidence` | 0 | 0 | 60 KB | 11-18 11:47 | **建议删除** | 证据目录（31 json / 25 png / 7 js），是工单附件不是业务代码 |
| 5 | `skills-3ca26959` | `C:\Users\leganck\.dsh\profiles\desktop\skills` | 0 | 0 | 60 KB | 11-18 11:47 | **建议删除** | **源目录已不存在**；即便存在也是技能文档，不是代码 |
| 6 | `work-log-app-go-994d2b77` | `D:\Code\test\GolandProjects\work-log-app-go` | 0 | 0 | 60 KB | 11-18 11:47 | **建议保留 + 重建** | 真实 git 仓（19705 个文件 / 1266 个 `.go`）。60 KB 说明建库**跑完了但 0 个候选文件**（多半被 ignore 规则或扫描上限全筛掉）；库本身不用删，重建后看 `code_index_status` 的「仓库当前 N 个候选文件」定位原因 |
| 7 | `erp-9520f861` | `D:\Code\docs\business\erp` | 0 | 0 | 4 KB | 11-18 15:51 | **建议保留 + 重建** | git 仓（95 个文件 / 73 个 md 业务文档），常用参考材料。4 KB = 只建了 schema 就停了（探路式调用留下的壳），重建即有用 |
| 8 | `smartpos-delivery-ledger-7326ad6d` | `D:\work\smartpos-delivery-ledger` | 0 | 0 | 4 KB | 11-18 15:43 | **建议保留 + 重建** | 交付台账 git 仓（854 个文件：561 md / 141 yaml / 72 json / 13 mjs），高频使用，**不要删** |

> 空壳 8 个合计 **368 KB**。它们的 `index.db-wal` 有两个是 93 KB 的陈旧 WAL（#7、#8，最近一次连接没 checkpoint），不影响判定。

## 3. 在建（6 个，勿删）

扫描时（17:08–17:13）刚被创建、还没落盘，属于**正在跑 `code_index`**：

| 库目录 | 源目录 | mtime | WAL |
| --- | --- | --- | --- |
| `smartpos-svc-saas-business-5576575b` | `D:\Code\smartpos\svc\saas\smartpos-svc-saas-business` | 17:08 | 93 KB |
| `smartpos-crm-policy-12ac02a4` | `D:\Code\smartpos\crm\smartpos-crm-policy` | 17:13 | 93 KB |
| `smartpos-erp-eai-88e9a977` | `D:\Code\smartpos\erp\smartpos-erp-eai` | 17:13 | 93 KB |
| `smartpos-erp-pos-cb3fcfc4` | `D:\Code\smartpos\erp\smartpos-erp-pos` | 17:13 | 93 KB |
| `smartpos-svc-erp-chain-18f4e6d7` | `D:\Code\smartpos\svc\smartpos-svc-erp-chain` | 17:13 | 93 KB |
| `smartpos-svc-pay-655eeabd` | `D:\Code\smartpos\svc\smartpos-svc-pay` | 17:13 | 93 KB |

正好是 8 个常用仓里缺索引的那几个——**有人在按 `docs/code-index-usage.md` 的清单建库**。
处置：等建完（`code_index_status path=...` 看「待更新/覆盖」），当天别删；若 24h 后仍 0 行再按空壳处理。

## 4. 有内容（9 个，正常，仅列出便于核对）

| 库目录 | files | chunks | 大小 | mtime |
| --- | --- | --- | --- | --- |
| `bug-analysis-5c41e4bf` | 1038 | 2964 | 67.5 MB | 11-18 17:07 |
| `smartpos-crm-order-fc83b71c` | 696 | 2246 | 15.2 MB | 11-18 16:42 |
| `smartpos-svc-center-03f1536a` | 583 | 1530 | 9.8 MB | 11-18 13:27 |
| `smartpos-svc-saas-business-5.0-bed1e1c9` | 323 | 833 | 75.7 MB | 11-18 06:02 |
| `smartpos-saas-business-b2006596` | 137 | 399 | 3.3 MB | 11-18 08:02 |
| `dsh-plugins-github-36a1d82b` | 173 | 906 | 11.2 MB | 11-18 17:15 |
| `dsh-code-index-ca7374be` | 30 | 135 | 2.1 MB | 11-18 17:14 |
| `sql-70476fa0` | 64 | 178 | 1.6 MB | 11-18 08:52 |
| `desktop-4d2969b2` | 4 | 21 | 580 KB | 11-18 14:26 |

磁盘大头都在这 9 个里（`smartpos-svc-saas-business-5.0` 75.7 MB、`bug-analysis` 67.5 MB——WAL/向量占多数），
所以**清理空壳不会省空间**，只是把「有库但 0 块」的误报清掉。

---

## 5. 为什么会有空壳（三条成因）

1. **cwd 兜底建库**：会话 cwd `D:\work\bug-analysis` 本身是授权根，不传 `path` 的调用就在 cwd 下开库；
   探测的是 cwd 里的工单子目录（`CHGJ-3750`、`chgj-3791`、`chgj-3735\evidence`、`TEST-DISP-02`）→ 空壳。
2. **探路式调用**：`code_index_status` / `code_search` / `code_map` 会先 `Store.open`（建 schema）再判断 `chunks`。
   一次「先看看有没有库」就留下 4 KB 空壳（#7 `erp`、#8 `smartpos-delivery-ledger` 都是 4 KB）。
3. **改名/删除不自动清理**：库名由 `sha1(路径)[:8]` 决定，路径一变就永远对不上；
   源目录删掉后库还在（#2 `TEST-DISP-02`、#5 `skills` 的源目录都已不存在）。

---

## 6. 建议处置（未执行）

### 6.1 建议删除（5 个，先自检再删）

```bash
# 自检：确认仍是 0 行、且没有会话正在建库（mtime 在 1 分钟内变化就等等）
python -c "import sqlite3,pathlib as P;b=P.Path.home()/'.dsh'/'code-index';[print(n,c.execute('select count(*) from chunks').fetchone()[0]) for n in ['CHGJ-3750-d7277185','TEST-DISP-02-aa397207','chgj-3791-fbdd6c23','evidence-5d31dcd0','skills-3ca26959'] for c in [sqlite3.connect('file:'+str(b/n/'index.db')+'?mode=ro',uri=True)]]"

# 删除（本报告没有执行）
rm -rf "C:/Users/leganck/.dsh/code-index/CHGJ-3750-d7277185" \
       "C:/Users/leganck/.dsh/code-index/TEST-DISP-02-aa397207" \
       "C:/Users/leganck/.dsh/code-index/chgj-3791-fbdd6c23" \
       "C:/Users/leganck/.dsh/code-index/evidence-5d31dcd0" \
       "C:/Users/leganck/.dsh/code-index/skills-3ca26959"
```

删除安全性：这 5 个都**不在 `repos.json` 注册表**，删掉不影响任何已登记仓库；下次真需要检索这些目录会重新建库。

### 6.2 建议保留 + 重建（3 个）

```bash
code_index path=D:\Code\test\GolandProjects\work-log-app-go
code_index path=D:\Code\docs\business\erp
code_index path=D:\work\smartpos-delivery-ledger
```

重建后复核：`code_index_status path=...` 的「覆盖率 / 仓库当前 N 个候选文件」。
若 `work-log-app-go` 重建后**仍是 0 个候选文件**，问题在扫描规则（`.gitignore` 全忽略 / `maxFileBytes` / 扩展名过滤），不是库的问题——
先用 `code_index_status ... status_only=true` 看「已忽略：N 文件（gitignore / cursorignore / exclude）」的分项。

### 6.3 在建（6 个）

等建完，别删。复核方式：`node scripts/preindex-common-repos.mjs --common`，`空库(在建)` 变成 `✓ N块` 即完成。

---

## 7. 可复现命令

三条命令都在本机实测通过（Windows + MSYS bash / node 26.4.0 / python 3.14.6）。

**① python 单行（纯标准库，输出：库名 files chunks 字节 mtime）**

```bash
python -c "import sqlite3,pathlib,datetime;b=pathlib.Path.home()/'.dsh'/'code-index';[print(p.parent.name,c.execute('select count(*) from files').fetchone()[0],c.execute('select count(*) from chunks').fetchone()[0],p.stat().st_size,datetime.datetime.fromtimestamp(p.stat().st_mtime).strftime('%Y-%m-%d %H:%M')) for p in sorted(b.glob('*/index.db')) for c in [sqlite3.connect('file:'+p.as_posix()+'?mode=ro',uri=True)]]"
```

**② node 单行（多输出一列 `index.db-wal` 大小，用来区分「在建」）**

```bash
node -e "const{DatabaseSync}=require('node:sqlite'),fs=require('fs'),p=require('path'),b=p.join(require('os').homedir(),'.dsh','code-index');for(const e of fs.readdirSync(b).sort()){const d=p.join(b,e,'index.db');if(!fs.existsSync(d))continue;const s=fs.statSync(d);let w=0;try{w=fs.statSync(d+'-wal').size}catch{}const db=new DatabaseSync(d,{readOnly:true}),f=db.prepare('select count(*) c from files').get().c,c=db.prepare('select count(*) c from chunks').get().c;db.close();console.log([e,f,c,s.size,w,new Date(s.mtimeMs).toLocaleString('sv-SE').slice(0,16)].join('\t'))}"
```

两条命令已交叉核对：**23 个库的「库名 / files / chunks / 字节数」完全一致**（python 的目录排序在 Windows 上不区分大小写，行序会不同，按名字对齐即可）。

**③ sha1 反推校验（验证「库目录 ↔ 源目录」对应关系）**

```bash
node -e "const c=require('crypto');for(const p of process.argv.slice(1))console.log(c.createHash('sha1').update(p).digest('hex').slice(0,8),p)" "D:\work\bug-analysis\CHGJ-3750" "D:\Code\smartpos\svc\smartpos-svc-center"
# 输出：d7277185 D:\work\bug-analysis\CHGJ-3750   /   03f1536a D:\Code\smartpos\svc\smartpos-svc-center
```

附：配套的「哪些仓该建库 / 建没建」清单一键脚本

```bash
node scripts/preindex-common-repos.mjs            # 表格
node scripts/preindex-common-repos.mjs --json     # 机器可读
```
