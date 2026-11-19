# code-index 使用指南（消费侧）

> 索引在跑、但没人查 —— 多半是这三件事：**常用仓没建库**、**没显式传 `path`**、**不知道该在什么时候用**。
> 本文按「什么时候用 → 传什么 → 坏了怎么办」组织。服务端/插件的实现细节看 `plugins/dsh-code-index/README.md`。

本机快照（2026-11-18 17:17，`node scripts/preindex-common-repos.mjs`）：
`D:\Code\smartpos` 下 46 个 git 仓库，**只有 3 个有可用索引（6.5%）**，另有 6 个正在建；
8 个常用仓里只有 2 个可用（`smartpos-crm-order`、`smartpos-svc-center`）。

---

## 1. 先决条件：库

| 要做的事 | 命令 |
| --- | --- |
| 看哪些仓建了/没建（只读） | `node scripts/preindex-common-repos.mjs` |
| 只看常用仓 + 直接给出该跑的命令 | `node scripts/preindex-common-repos.mjs --common --commands` |
| 建库 / 增量刷新 | `code_index path=D:\Code\smartpos\erp\smartpos-erp-pos` |
| 看某个仓的覆盖与新鲜度 | `code_index_status path=D:\Code\smartpos\erp\smartpos-erp-pos` |

没建库时 `code_search` / `code_map` / `code_graph` 都会返回「该目录还没有索引」——**不是工具坏了，是没库**。
索引库落在 `C:\Users\leganck\.dsh\code-index\<仓库名>-<路径sha1前8位>\index.db`，按仓库隔离，不进 git。

---

## 2. 触发时机表

| 你在做什么 | 用哪个工具 | 参数示例 |
| --- | --- | --- |
| **实现定位**：「XX 逻辑在哪个文件/哪个类」 | `code_search` | `path=D:\Code\smartpos\erp\smartpos-erp-pos` `query="bill list 账单查询 mapper"` |
| **调用链**：「谁调用了这个方法 / 它又调了谁」 | `code_search` + `expand` 或 `code_graph` | `query="BillMapper billList"` `expand=callers`；或 `code_graph symbol=billList direction=in` |
| **影响面**：「改这个方法/这张表会波及哪里」 | `code_graph`（首选）或 `code_search expand=impact` | `code_graph symbol=billList direction=in type=calls hops=2 limit=20` |
| **跨仓关联**：「POS 调的哪个 ERP 接口 / CRM 与 ERP 的字段怎么对应」 | 两个仓各查一次 `code_search`（一次只查一个库） | 仓 A：`path=…\smartpos-erp-pos query="支付 记账 PayBook"` → 拿到类/接口名 → 仓 B：`path=…\smartpos-svc-pay query="PayBook feign client"` |
| **找 mapper 对应 SQL**：「这个 DAO 方法对应哪条 SQL / 哪张表」 | `code_search expand=mapper` | `path=D:\Code\smartpos\erp\smartpos-erp-pos` `query="BillMapper billList"` `expand=mapper` |
| **找测试 / 找类似实现**（同目录还有哪儿这么写） | `code_search current_file=` | `path=…\smartpos-erp-pos` `query="审核 账单"` `current_file=smartpos-erp-pos/src/main/java/smartpos/erp/pos/service/base/BillService.java` |
| **冷启动，不知道代码在哪** | `code_map` | `path=D:\Code\smartpos\erp\smartpos-erp-pos depth=2` |
| **查确切字符串**（错误码、日志原文、配置 key） | ❌ 不用 `code_search` | 用 grep / `ops_grep`，比索引准且快 |

一句话记法：**问「在哪/什么关系」用 `code_search`；问「谁连着我」用 `code_graph`；问「目录长什么样」用 `code_map`；问「这串字在哪」用 grep。**

---

## 3. `path` 显式点名约定

**为什么必须传**：工具允许访问的根 = 工作区根（`C:\Users\leganck\.dsh\profiles\desktop`）+ 会话 cwd。
业务会话的 cwd 常是 `D:\work\bug-analysis`（**不是 git 仓库、也不含业务代码**）。不传 `path` 时工具就落到 cwd 上 →
在一个文档目录里检索，命中全是工单 md/json，还会顺手在该目录建出一个空库（见 `report-empty-indexes.md`）。

**三条硬规则**（0.16+ 授权语义）：

1. `path` 必须是**仓库根绝对路径**：有 `.git` 目录，或 git worktree 的 `.git` 文件。
2. 父目录、子目录都不算：「`D:\Code\smartpos`」「`…\smartpos-erp-pos\src`」都会被拒。
3. 显式点名 + 确实是 git 根 = 授权；建过一次库后注册表会记住（`repos.json`），换会话不必重新点名 ——
   但**新会话仍建议显式传**，因为默认值取决于 cwd，而 cwd 不由你控制。

| 写法 | 结果 |
| --- | --- |
| `path=D:\Code\smartpos\erp\smartpos-erp-pos` | ✓ 仓库根，正常 |
| `path=D:\Code\smartpos` | ✗ 是父目录（本身不是 git 仓），报「路径不在当前工作空间内」 |
| `path=D:\Code\smartpos\erp\smartpos-erp-pos\src` | ✗ 子目录，不是 git 根 |
| 不传 `path`（cwd=`D:\work\bug-analysis`） | ⚠ 不报错但没用：在文档目录里检索，且会建空库 |

---

## 4. `expand` 四档（图扩展）

`expand` 在 `code_search` 命中 top-N 块之后，按**代码自己的边**（imports / calls / overrides / mapper_stmt / table_ref）做 1 跳扩展，
输出独立区块「【关联代码】」，带边类型、位置与置信度。四档回答四种问题：

| `expand` | 回答什么问题 | 例子 |
| --- | --- | --- |
| `callers` | **谁在调我**——改方法签名/行为前要知道有哪些调用点 | `query="billList 账单查询"` `expand=callers` → `BillService.billList`、`BillController.billList` |
| `callees` | **我在调谁**——想顺着读下游实现，而不是全文搜名字 | `query="BillService billList"` `expand=callees` → `BillMapper.billList` |
| `mapper` | **MyBatis 方法与 XML statement / 表名怎么对应**——「这个 DAO 方法走哪条 SQL」 | `query="BillMapper billList"` `expand=mapper` → `mybatis/mapper/BillMapper.xml` 的 `<select id="billList">` + `bill_order` 等表名 |
| `impact` | **影响面**——一次把上下游 + mapper/表引用都摊开，评估「改这里会炸哪」 | `query="BillMapper billList"` `expand=impact` |

有界纪律（防上下文洪水）：**每类边 ≤5 条、总量 ≤20 条、1 跳**，区块总长 ≤1500 字符；没有关联时不出该区块，没传 `expand` 时输出与旧版完全一致。

`code_graph` 是同一套图的「纯查询版」，能指定方向与深度，适合已经有明确符号名的场景：

```
code_graph path=D:\Code\smartpos\erp\smartpos-erp-pos symbol=billList direction=in type=calls hops=2 limit=20
```

`direction`：`in`（谁指向我 = 调用方）/ `out`（我指向谁 = 被调用方）/ `both`（默认）。
另有 `chunk_hint`（拿一段自然语言/代码片段先定位块，再用它当起点）与 `type`（`imports|calls|overrides|mapper_stmt|table_ref`）。

> 兼容性：`expand` 与 `code_graph` 属于 0.17 的图查询能力。若调用报「未知参数 expand」/「没有 code_graph 工具」，
> 说明当前会话加载的还是旧插件——重启会话后再用，别反复重试。

---

## 5. 常见失败与处置

| 症状 | 真实原因 | 处置 |
| --- | --- | --- |
| 返回「该目录还没有索引：…」 | 该仓没建过库 | `code_index path=<仓库根>`；或先跑 `node scripts/preindex-common-repos.mjs` 看清单 |
| 返回「路径不在当前工作空间内」 | 没传 `path` / 传了父目录或子目录 / 不是 git 仓 | 改传**仓库根绝对路径**（有 `.git` 的那层） |
| 报拒绝但脚本说「✓ 已建库」 | 库存在但 `chunks=0`（空库，历史残留） | `code_index_status path=…` 确认；`code_index path=… mode=full` 重建；空库成因见 `report-empty-indexes.md` |
| 命中一堆同名类/方法，看不出哪个是本仓的 | 同名跨仓，且边是**按名字匹配**的低置信度边 | `path` 锁到一个仓；`code_graph` 每条邻居都带 `path:行`；`weight` 低的结果只当线索 |
| 纯中文 query 召回很差 | 语义向量对中文标识符跨语言召回弱 | 中英混合（`"billList 账单 查询"`）；先用 grep/`code_map` 拿到真实标识符再搜 |
| 语义命中少但关键词命中还行 | 远端向量不通（只丢语义召回，不报错） | 不影响使用；要纯关键词就 `mode=fts` |

---

## 6. 8 个常用仓的预索引命令

来自 `node scripts/preindex-common-repos.mjs --common`（2026-11-18 17:17 快照）。**没标 ✓ 的都还没有可用索引（部分已在建），跑一次即补齐/续建**：

| 仓库 | 绝对路径 | 索引状态 | 命令 |
| --- | --- | --- | --- |
| smartpos-crm-order | `D:\Code\smartpos\crm\smartpos-crm-order` | ✓ 2246 块 | （已有）`code_index path=D:\Code\smartpos\crm\smartpos-crm-order` 可增量刷新 |
| smartpos-crm-policy | `D:\Code\smartpos\crm\smartpos-crm-policy` | 空库(在建) | `code_index path=D:\Code\smartpos\crm\smartpos-crm-policy` |
| smartpos-erp-pos | `D:\Code\smartpos\erp\smartpos-erp-pos` | 空库(在建) | `code_index path=D:\Code\smartpos\erp\smartpos-erp-pos` |
| smartpos-erp-eai | `D:\Code\smartpos\erp\smartpos-erp-eai` | 空库(在建) | `code_index path=D:\Code\smartpos\erp\smartpos-erp-eai` |
| smartpos-svc-pay | `D:\Code\smartpos\svc\smartpos-svc-pay` | 空库(在建) | `code_index path=D:\Code\smartpos\svc\smartpos-svc-pay` |
| smartpos-svc-center | `D:\Code\smartpos\svc\smartpos-svc-center` | ✓ 1530 块 | （已有）可增量刷新 |
| smartpos-svc-erp-chain | `D:\Code\smartpos\svc\smartpos-svc-erp-chain` | 空库(在建) | `code_index path=D:\Code\smartpos\svc\smartpos-svc-erp-chain` |
| smartpos-svc-saas-business | `D:\Code\smartpos\svc\saas\smartpos-svc-saas-business` | 空库(在建) | `code_index path=D:\Code\smartpos\svc\saas\smartpos-svc-saas-business` |

一次贴完（复制即用）：

```
code_index path=D:\Code\smartpos\crm\smartpos-crm-policy
code_index path=D:\Code\smartpos\erp\smartpos-erp-pos
code_index path=D:\Code\smartpos\erp\smartpos-erp-eai
code_index path=D:\Code\smartpos\svc\smartpos-svc-pay
code_index path=D:\Code\smartpos\svc\smartpos-svc-erp-chain
code_index path=D:\Code\smartpos\svc\saas\smartpos-svc-saas-business
```

注意三点：
- 清单里的「erp/smartpos-erp-chain」实际目录是 **`svc/smartpos-svc-erp-chain`**（脚本已按实际目录名认领）。
- 派生目录（`smartpos-svc-pay-5.0`、`smartpos-crm-order-5.0` 等）是**独立仓库**，各自一套索引；要查 5.0 线就点名 5.0 的路径。
- 快照之后（17:08–17:13）上表 6 个待建仓的库已被创建、正在建（脚本显示 `空库(在建)`）。命令不用变：
  再跑一次 `code_index` 是**增量续建**，不会重复劳动；建完用 `node scripts/preindex-common-repos.mjs --common` 复核。

---

## 7. 三个照抄配方

**① 从 0 定位一个功能的实现与调用链**

```
code_map    path=D:\Code\smartpos\erp\smartpos-erp-pos depth=2
code_search path=D:\Code\smartpos\erp\smartpos-erp-pos query="bill list 账单查询" expand=callers
```

**② 改一个 mapper 方法前，摸清影响面（SQL + 调用方）**

```
code_search path=D:\Code\smartpos\erp\smartpos-erp-pos query="BillMapper billList" expand=mapper
code_graph  path=D:\Code\smartpos\erp\smartpos-erp-pos symbol=billList direction=in hops=2 limit=20
```

**③ 跨仓找「谁调了对方的接口」**

```
code_search path=D:\Code\smartpos\svc\smartpos-svc-pay    query="erp 记账 接口 payBook"
code_search path=D:\Code\smartpos\erp\smartpos-erp-pos    query="payBook 记账 PayBook" expand=callers
```
