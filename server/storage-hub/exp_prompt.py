# -*- coding: utf-8 -*-
"""经验抽取 prompt v2：固化的人工标准 + 词汇表（版本号只读，页面不可在线改）。

## 为什么 prompt 要放进代码常量
v2 的质量标准是**人工 17 条**（`server/exp-pipeline/experiences-v2-session-4ff93b80.jsonl`，
每条一行；md 里那份说明文档的条数编号已过时，以 jsonl 为准）
一条条写出来、再逐条对照九类垃圾核出来的。这套标准如果放到数据库、允许在线改，
就退化成"谁改谁有理"的软指标：改坏一次，整批抽出来的经验全部失真，而且
历史条目的 `audit.prompt_version` 再也无法解释"当时按什么标准抽的"。
因此 prompt 与版本号一起进代码，改 prompt 必须改 `PROMPT_VERSION` 并走代码评审。

## 两轴分类（不是按主题，是按"Agent 缺什么"）
- `lens`（认知障碍轴）：jargon 语义不可发现 / index 位置不可发现 / logic 行为不可发现
- `category`（内容领域轴）：business 业务知识 / debug 调试经验 / repo 仓库联动 / tool 工具环境
- `process`（交付流程）：**不是第五类有效 category**，而是"该由 skill 覆盖"的拒收标记。
  skill 里已经写着的规范（只推个人 fork、先沟通再动手之类）重复进经验库没有任何收益，
  所以命中即拒收，但拒收原因记 `skill-covered` 且**不计入垃圾率**——它不是垃圾，是 redundancy。

## 可审计三维
每条候选必须带 `audit={reusable_because, exclusions, evidence_quote}`：
写不出 `reusable_because` 就不是经验（"被召回后行为能否正向改变"是唯一标准）；
`exclusions` 记录核对过哪几类垃圾；`evidence_quote` 必须能回指素材原文，
缺失即拦（证据不足），这条是硬门。

## 与 `server/exp-pipeline/extract_v2_llm.py` 的关系
本模块是那个试跑脚本的**生产化固化版**：口径一致，但补齐了两轴 category、process 拒收、
九类垃圾与 reason code 一一对应、以及 prompt/Review 共用同一组数字（避免改一处漏一处）。

## v2.1 改了什么（依据 `docs/exp-eval.md` §8.2 的错例复盘，不是重新设计）
1. **长度从硬约束降为软约束**：round1 的 7 条 Review 误拦里 6 条死在长度硬阈值上，
   其中 2 条正是黄金 #11/#13。长度与"粒度混用"没有因果关系，写进 prompt 只当目标值，
   Review 侧超长只截断（记 `warnings:['trimmed']`）不判垃圾。
2. **lens 判定顺序写死**（黑话 → 位置 → 约束）+ 必填 `lens_reason`：
   round1 Category(lens) Acc 只有 50%，错法集中在"位置不可发现"被判成 `logic`。
3. **产出约束**："单段最多 3 条 + 只输出 JSON 数组不要解释"，压 reasoning/输出预算。
"""
# 版本号随 prompt 文本一起冻结：改 prompt 必须同时改这里（单测会核对两者一致性）。
PROMPT_VERSION = "exp-v2.1"

# ---------------------------------------------------------------- 轴一：三镜头（认知障碍）
LENSES = ("jargon", "index", "logic")
LENS_LABELS = {
    "jargon": "黑话镜头（语义不可发现）",
    "index": "索引镜头（位置不可发现）",
    "logic": "逻辑镜头（行为不可发现）",
}
LENS_DESCRIPTIONS = {
    "jargon": "项目内部黑话、缩写、代称，字面推不出含义（如「可摘」「惠管家」「D 站」）",
    "index": "某个能力/入口/表/工具在哪，读代码或按目录名都找不到",
    "logic": "反直觉的工程约束、隐式机制、踩过的坑（如「XLEN 不增长是常态」）",
}

# ---------------------------------------------------------------- 轴二：内容领域（四类有效值）
CATEGORIES = ("business", "debug", "repo", "tool")
CATEGORY_LABELS = {
    "business": "业务知识（业务规则、口径、单据与数据模型）",
    "debug": "调试经验（线上故障、数据异常的定位与修复动作）",
    "repo": "仓库联动（跨仓/分支/移植/发版等代码资产关系）",
    "tool": "工具环境（构建、查库、查日志、部署命令等工具用法）",
}
# 第五类 `process` 不参与入库：命中即拒收，reason=skill-covered，且不计入垃圾率。
REJECTED_CATEGORY = "process"
PROCESS_REJECT_REASON = "skill-covered"
CATEGORY_NOTE = (
    "`process`（交付流程）不是有效 category：凡「只推个人 fork」「先沟通再动手」这类"
    "已由 skill 覆盖的规范，一律不要输出。"
)

# ---------------------------------------------------------------- 九类垃圾（排除清单）
# no/code/name/desc 是给 prompt 用的；reason 是 Review 拦截时写进统计的稳定字符串，
# 页面按 reason 聚合垃圾率，所以 reason 一经发布不许改（改了就断历史对比）。
GARBAGE_CLASSES = (
    {
        "no": 1,
        "code": "factual-error",
        "name": "事实性错误",
        "desc": "编造约束、把临时说法当规则、类名/方法名/表名不存在",
        "reason": "garbage-1-factual-error",
    },
    {
        "no": 2,
        "code": "common-sense",
        "name": "通用常识",
        "desc": "任何项目都适用（多收集上下文、仔细检查、多看日志）",
        "reason": "garbage-2-common-sense",
    },
    {
        "no": 3,
        "code": "dialogue-summary",
        "name": "对话摘要",
        "desc": "只复述过程（本次改了 N 个文件、已经部署到 dev1），没有可复用结论",
        "reason": "garbage-3-dialogue-summary",
    },
    {
        "no": 4,
        "code": "one-off",
        "name": "一次性 case",
        "desc": "只对当前任务有效（今天/临时/这次），且写不出可复用三要素（触发条件+动作+机制）",
        "reason": "garbage-4-one-off",
    },
    {
        "no": 5,
        "code": "user-preference",
        "name": "用户主观偏好",
        "desc": "个人口味或习惯（我觉得/我习惯/建议你），不是团队机制",
        "reason": "garbage-5-user-preference",
    },
    {
        "no": 6,
        "code": "missing-context",
        "name": "缺少上下文",
        "desc": "when 为空或无法判定、指代不明（这一块/那个地方），不知对应哪个模块/接口",
        "reason": "garbage-6-missing-context",
    },
    {
        "no": 7,
        "code": "mixed-granularity",
        "name": "粒度混用",
        "desc": "通用规则与 case 细节混成一条（金额/工单明细写进 what）；**按内容判，不按长度判**",
        "reason": "garbage-7-mixed-granularity",
    },
    {
        "no": 8,
        "code": "not-actionable",
        "name": "不可执行",
        "desc": "抽象建议，看了也不知道下一步做什么（要具体到查什么/改什么/用什么参数）",
        "reason": "garbage-8-not-actionable",
    },
    {
        "no": 9,
        "code": "no-evidence",
        "name": "证据不足",
        "desc": "素材里没有依据、全靠推断，或 audit.evidence_quote 为空",
        "reason": "garbage-9-no-evidence",
    },
)
GARBAGE_CODES = tuple(g["code"] for g in GARBAGE_CLASSES)
REASON_GARBAGE = {g["code"]: g["reason"] for g in GARBAGE_CLASSES}
ALL_GARBAGE_REASONS = tuple(g["reason"] for g in GARBAGE_CLASSES)

# Review 的其它稳定拦截原因（不属于九类垃圾，但同样计入垃圾率）
REASON_UNREFINED = "unrefined-what-equals-why"  # what≈why，没提炼
REASON_INVALID = "invalid-field"  # lens/category 非法或缺字段
REASON_TOO_LONG = REASON_GARBAGE["mixed-granularity"]  # 超长归到粒度混用
REASON_WHEN_TOO_SHORT = REASON_GARBAGE["missing-context"]  # when 过短归到缺少上下文

# 不计入垃圾率的原因（redundancy，不是垃圾）
NON_GARBAGE_REASONS = (PROCESS_REJECT_REASON,)


def is_garbage_reason(reason):
    """skill-covered（redundancy）不算垃圾；其余拦截原因都算垃圾。"""
    return bool(reason) and reason not in NON_GARBAGE_REASONS


# ---------------------------------------------------------------- 可审计三维
AUDIT_DIMENSIONS = ("reusable_because", "exclusions", "evidence_quote")
AUDIT_DIMENSION_LABELS = {
    "reusable_because": "为什么算经验（这条召回后能让后续行为怎么改）",
    "exclusions": "通过了哪几条垃圾排除（九类编号）",
    "evidence_quote": "支撑它的素材原文片段（必须逐字来自素材）",
}

# ---------------------------------------------------------------- 文本长度（软约束，不是拦截条件）
# 这些数字同时出现在 prompt 正文与 Review 里：只在此处定义一份，
# prompt 由 `render_system_prompt()` 注入，单测核对"prompt 里出现的数字 == 常量"。
#
# **v2.1 起长度不再是垃圾判据**：round1 的 7 条 Review 误拦里 6 条死在
# `what>90 / when>70` 硬阈值上（其中 2 条正是黄金 #11/#13），而长度跟"粒度混用"
# 没有因果关系——真正的粒度判据是内容规则 `GRANULARITY_RE`（what 里出现金额/笔数）。
# 现在这三个数只做两件事：① prompt 里的目标字数（让模型写短）；② 超长时的**截断上限**
# （截断后记 `warnings=['trimmed']`，仍然放行）。
# 目标值取人工 17 条的自然长度；上限再放宽 1/3，避免截掉有价值的长句。
WHAT_TARGET = 90
WHEN_TARGET = 70
WHY_TARGET = 140
WHAT_MAX = 120  # 截断上限 = 目标 × 4/3，四舍五入
WHEN_MAX = 90
WHY_MAX = 200
# when 下限取 10 而不是 12：人工标准（17 条）里第 2、4 条 when 恰为 11 字
# （「怀疑流水被写到别的分区」「有销售流水但库存未扣减」），<12 会误伤这两条人工认可的经验。
# 10 仍能挡住「处理问题时」这类 5 字空条件，且不需要引入"含具体实体则放行"的复杂规则。
WHEN_MIN = 10
SIM_WHAT_WHY = 0.75
# lens 判定的自述理由上限（prompt 要求每条写出"为什么是这个镜头"，Review 用它做自洽性校验）
LENS_REASON_MAX = 20

# Dedup：宁严勿宽 + 禁止桥接（只与代表项两两比较，不做传递闭包）
DEDUP_WHAT = 0.82
DEDUP_WHEN = 0.70

# Merge：唯一目标前置（没有唯一同向目标一律 create，不猜）
MERGE_SAME_WHAT = 0.60  # 同向判定（what 相似度下限）
MERGE_OPPOSITE_WHAT = 0.45  # 方向相反判定（同主题但否定极性相反）

# 素材里允许进 evidence_quote 的最大长度（超过只截不判）
EVIDENCE_QUOTE_MAX = 80

# ---------------------------------------------------------------- prompt 正文
_SYSTEM_PROMPT_TEMPLATE = """你是 SmartPOS 交付团队的资深工程师。任务：从一段真实工作记录里提炼**可复用的团队经验**。

## 什么算经验（唯一标准）
被召回后，另一个 Agent 面对相似场景时**行为会正向改变**。凡是从素材里推得出来的常识、或者换个项目也照说的道理，都不算。

## 一、按「Agent 缺什么」选镜头 lens（三选一，必填；**按下面顺序判，命中即停**）
① 出现项目内部黑话/缩写/代称，字面推不出含义 → `jargon`（__LENS_JARGON__）
② 动作是「去哪找 / 在哪个类 / 哪张表 / 哪个环境 / 用哪条命令」→ `index`（__LENS_INDEX__）
③ 其余：涉及「必须 / 不能 / 不要 / 否则」这类反直觉约束或隐式机制 → `logic`（__LENS_LOGIC__）
- 无把握时选 `logic`（默认兜底），**不要按主题分类**，要按"Agent 光看代码/文档会缺什么"分类。
- 每条必须再填 `lens_reason`（≤__LENS_REASON_MAX__ 字）：一句话说明为什么是这个镜头。
  判 `index` 要写出"要找的是什么位置"（表/类/环境/命令）；判 `jargon` 要写出是哪个黑话词。

## 二、按内容领域选 category（四选一，必填）
- `business` __CAT_BUSINESS__
- `debug` __CAT_DEBUG__
- `repo` __CAT_REPO__
- `tool` __CAT_TOOL__
__CATEGORY_NOTE__

## 三、九类垃圾（命中任一即**不要输出**这条）
1 事实性错误：编造约束、把临时说法当规则、类名/方法名/表名不存在
2 通用常识：任何项目都适用（多收集上下文、仔细检查、多看日志、注意边界）
3 对话摘要：只复述过程（本次改了 N 个文件、已经部署到 dev1、接着我又跑了测试）
4 一次性 case：只对当前任务有效（今天、临时、这一次），**且写不出可复用三要素**（触发条件+动作+机制）
5 用户主观偏好：个人口味或习惯（我觉得、我习惯、建议你、最好先沟通）
6 缺少上下文：when 为空或无法判定、指代不明（这一块、那个地方），不知对应哪个模块/接口
7 粒度混用：通用规则与 case 细节混成一条（金额/工单明细/行数写进 what）——**看内容，不看字数**
8 不可执行：抽象建议，看了也不知道下一步做什么
9 证据不足：素材里没有依据、全靠推断，或写不出 evidence_quote

## 四、三个字段怎么写（这是质量的全部）
- `what`：**祈使句动作**，目标 ≤__WHAT_TARGET__ 字（硬上限 __WHAT_MAX__，超了会被截断）。
  说清改什么/查什么/用什么参数，下一步能直接照做。
  反例：`CHGJ-3735 涉及 3 笔共 34 元`（叙事+细节混杂）、`注意多收集上下文`（不可执行）、
  `Earlier claim 该文件与 5.0.x 一致 was wrong`（审计语气，且 what 与 why 重复）。
- `when_expr`：**可判定的触发条件**，目标 ≤__WHEN_TARGET__ 字（硬上限 __WHEN_MAX__）。
  收窄到"看到什么现象/处在什么场景"就能对上。禁止"处理问题时""遇到复杂情况"这类永远为真的空条件。
- `why`：**机制或后果**，目标 ≤__WHY_TARGET__ 字（硬上限 __WHY_MAX__）。
  讲清"不这么做会发生什么"，要能解释机理，不要复述动作。
- **三者必须互不相同**：what 讲动作、when_expr 讲触发、why 讲机制。what 与 why 语义重复（相似度 >__SIM_WHAT_WHY__）视为没提炼，直接不要输出。

## 五、可审计三维（每条必填，缺 evidence_quote 直接算无效）
`audit`：
- `reusable_because`：这条为什么能改变后续行为（≤40 字，写不出就不要这条）
- `exclusions`：你核对掉了哪几类垃圾（写编号，如 `"1,2,3,4,6,8"`）
- `evidence_quote`：**逐字**引自素材的原文片段（≤__EVIDENCE_QUOTE_MAX__ 字）；工单号/租户名可以只放这里，不要写进 what

## 六、其它硬要求
- **单段最多输出 3 条**（多于此只保留最有价值的 3 条）；一条只讲一件事，同一素材有多条独立经验就分别输出。
- 剥离审计语气（Earlier claim / was wrong / first attempt / 已验证）与工单号细节。
- 数量不设下限：全部不合格就输出 `[]`（宁缺勿滥，输出垃圾比少输出代价大得多）。

## 七、输出格式（**只输出 JSON 数组**，不要解释、不要代码块、不要前后缀）
[{"what":"...","when_expr":"...","why":"...","lens":"jargon|index|logic",
  "lens_reason":"为什么是这个镜头（≤__LENS_REASON_MAX__ 字）",
  "category":"business|debug|repo|tool",
  "evidence_issue":"工单号或空字符串",
  "audit":{"reusable_because":"...","exclusions":"1,2,3,4,6,8","evidence_quote":"..."}}]
"""

# 少样本：三条覆盖"logic+debug / index+repo / jargon+business"，
# 全部逐字取自人工 17 条标准（golden sample），让模型照质量而不是照描述对齐。
FEW_SHOT_EXAMPLES = (
    {
        "what": "上传流水后台查不到时，先比对同机同收银员相邻流水的落库分区，不要只查客户自己的库",
        "when_expr": "客户报上传成功但后台查不到流水",
        "why": "分区路由错时数据写进其他租户库，客户端仍收到 SUCCESS，只查本租户永远查不到",
        "lens": "logic",
        "lens_reason": "讲分区路由机制，不是去哪找",
        "category": "debug",
        "evidence_issue": "CHGJ-3943",
        "audit": {
            "reusable_because": "把排查起点从本租户库改成跨分区比对，是一步可执行的定位动作",
            "exclusions": "1,2,3,4,6,8",
            "evidence_quote": "分区 za4 正常；三笔上传被路由到 zb1，落进 tenant_id=140709",
        },
    },
    {
        "what": "两条产品线各自新建了同名类时，按已发版修复逐个 cherry-pick，禁止全分支 merge",
        "when_expr": "把 master-5.0.x 合进 5.2.3 这类跨线移植",
        "why": "两线独立在相同路径新建同类，全量 merge 后约 200 处找不到符号，且无法短期收敛",
        "lens": "logic",
        "lens_reason": "禁止 merge 是反直觉约束",
        "category": "repo",
        "evidence_issue": "SPLAT-5627",
        "audit": {
            "reusable_because": "阻止一次会把分支编译全废的常规操作（merge 才是默认直觉）",
            "exclusions": "2,3,6,8",
            "evidence_quote": "9 文件 16 冲突解决后 ~200 编译错误",
        },
    },
    {
        "what": "看到「可摘/不可摘」理解为「该工单能否移植到目标补丁线」",
        "when_expr": "发布清单或评论里出现可摘字样",
        "why": "团队内部黑话，字面推不出含义，直接按字面理解会把版本判断做反",
        "lens": "jargon",
        "lens_reason": "「可摘」是内部黑话",
        "category": "business",
        "evidence_issue": "CHGJ-2979",
        "audit": {
            "reusable_because": "给黑话建立唯一映射，消除语义盲区",
            "exclusions": "2,6",
            "evidence_quote": "文件与 5.0.x 一致 = 可摘",
        },
    },
)

MATERIAL_PLACEHOLDER = "{{MATERIAL}}"


def _fill(template):
    """注入常量，保证 prompt 里的数字与 Review 用的是同一份定义。"""
    repl = {
        "__LENS_JARGON__": LENS_DESCRIPTIONS["jargon"],
        "__LENS_INDEX__": LENS_DESCRIPTIONS["index"],
        "__LENS_LOGIC__": LENS_DESCRIPTIONS["logic"],
        "__CAT_BUSINESS__": CATEGORY_LABELS["business"],
        "__CAT_DEBUG__": CATEGORY_LABELS["debug"],
        "__CAT_REPO__": CATEGORY_LABELS["repo"],
        "__CAT_TOOL__": CATEGORY_LABELS["tool"],
        "__CATEGORY_NOTE__": CATEGORY_NOTE,
        "__WHAT_MAX__": str(WHAT_MAX),
        "__WHAT_TARGET__": str(WHAT_TARGET),
        "__WHEN_MAX__": str(WHEN_MAX),
        "__WHEN_TARGET__": str(WHEN_TARGET),
        "__WHY_MAX__": str(WHY_MAX),
        "__WHY_TARGET__": str(WHY_TARGET),
        "__LENS_REASON_MAX__": str(LENS_REASON_MAX),
        "__SIM_WHAT_WHY__": str(SIM_WHAT_WHY),
        "__EVIDENCE_QUOTE_MAX__": str(EVIDENCE_QUOTE_MAX),
    }
    out = template
    for key, value in repl.items():
        out = out.replace(key, value)
    return out


SYSTEM_PROMPT = _fill(_SYSTEM_PROMPT_TEMPLATE)

# 少样本序列化格式单独提出：`%` 的优先级高于 `+`，写成 `"a" + "b%s" + "c" % x` 会只格式化最后一段。
_FEW_SHOT_LINE = (
    '{"what":"%s","when_expr":"%s","why":"%s","lens":"%s","lens_reason":"%s","category":"%s",'
    '"evidence_issue":"%s","audit":{"reusable_because":"%s","exclusions":"%s",'
    '"evidence_quote":"%s"}}\n'
)


def _few_shot_block():
    rows = []
    for e in FEW_SHOT_EXAMPLES:
        rows.append(_FEW_SHOT_LINE % (
            e["what"],
            e["when_expr"],
            e["why"],
            e["lens"],
            e["lens_reason"],
            e["category"],
            e["evidence_issue"],
            e["audit"]["reusable_because"],
            e["audit"]["exclusions"],
            e["audit"]["evidence_quote"],
        ))
    return "".join(rows)


# 完整 prompt = 系统段 + 少样本 + 素材。素材用 replace 注入而不是 %/format，
# 避免素材里的 % / {} / 反斜杠被当成格式符（素材是任意工作记录，不能假设干净）。
PROMPT_TEMPLATE = (
    SYSTEM_PROMPT
    + "\n## 八、照这个质量对齐（示例，不要照抄内容）\n"
    + _few_shot_block()
    + "\n## 九、待提炼素材\n"
    + MATERIAL_PLACEHOLDER
)


def render_prompt(material):
    """把素材填进 prompt。用 replace 而不是 %/format：素材含 %、{}、反斜杠都不会炸。"""
    text = material if isinstance(material, str) else str(material or "")
    return PROMPT_TEMPLATE.replace(MATERIAL_PLACEHOLDER, text)


def prompt_fingerprint():
    """prompt 文本指纹（前 16 位）：audit 里记版本号时一并记它，能定位"同一版本号改过文本"。"""
    import hashlib

    return hashlib.sha256(PROMPT_TEMPLATE.encode("utf-8")).hexdigest()[:16]
