/**
 * 重排档位常量（0.10.0 起本地重排已移除：重排只有远端实现，见 lib/remote.js）。
 *
 * 实测（103 题、bge-small 候选池 top-20，历史数据）：
 * | 配置 | hit@3 | 每查询延迟 |
 * |---|---|---|
 * | 不重排 | 42.7% | ~40 ms |
 * | quality（top-20） | 59.2% | 939 ms |
 * | fast（top-10） | 57.3% | 474 ms |
 *
 * `RERANK_TIERS` 仍决定"取多少候选送给远端"；`RERANK_MAX_TOKENS` 是远端请求的截断长度。
 */

/** 两档：候选数与延迟成正比 */
export const RERANK_TIERS = {
  fast: { candidates: 10, label: '快档' },
  quality: { candidates: 20, label: '常规档' },
}

/** 重排输入的截断长度：实测 256 相对 512 质量只差 2.9pt、耗时减半 */
export const RERANK_MAX_TOKENS = 256
