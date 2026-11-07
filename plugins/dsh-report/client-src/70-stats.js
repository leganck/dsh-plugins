// ---------------------------------------------------------------- 统计面板 + 统计区域
//
// 组件契约（CONTRACTS.md §7.1）：
//   ── 报告详情「统计」tab ──
//   StatsPanel({ t, detail, stats })
//     t      : ctx.locale.bind('dshReport') 的结果；缺 key 时用 tx(t, key, '中文兜底') 回退，可为 undefined。
//     detail : ReportDetail（GET /reports/:id）——用 periodStart/periodEnd/generatedAt、
//              totalCommits/totalAdditions/totalDeletions/totalLines/repoCount/merge*，
//              以及三个已 JSON.parse 的分布：dateDistribution[{date,count}]、
//              domainDistribution[{name,count}]、topics[{domain,topicTitle,summary}]。
//     stats  : GET /reports/:id/stats → { stats, lineStats[], repoBranchStats[] }；可为 null（请求中）。
//               lineStats: { includeMerge, additions, deletions, total, pureAdditions }
//               repoBranchStats: { includeMerge, repoKey, branchName, commitCount, additions, deletions, total }
//     （StatsPanel 行为保持不变：只读、不发请求；stats 未到达时用 detail 兜底。）
//
//   ── 工作台「统计」区域 v2（按最新 upstream 统计页重排，见文件后半段）──
//   外壳分工（99-apply 组装）：aside = chrome + 区导航 + StatsAside；main = StatsMain。
//   StatsAside({ t, state, actions })     左栏：搜索仓库（本地过滤、命中全展开）+「全部仓库」行（总数、active）+
//                                         StatsRepoTree；空态「没有匹配的仓库」。
//   StatsMain({ t, state, actions })      主区整页：
//                                         stats-title（仓库名/namespace/「不含合并和拣选」+ 快捷范围 6 档 +
//                                         起止日期 + 查询（pending 时 primary）+ 同步数据 + 生成报告）
//                                         → 一年贡献墙 → 覆盖度提示 → 摘要大数字（N 提交 / M 个仓库 / +A -D）
//                                         → 分支条（选中仓库时）→ 提交记录（月 → 天 → 点天展开 submits）
//                                         → 「同步数据」Dialog(900) 内嵌 SyncPage（Phase 1；Phase 2 再四块样式化）。
//   StatsRepoTree({ nodes, activeKey, onSelect, depth, forceOpen })
//                                         递归仓库树：文件夹折叠、叶子=仓库+提交数、activeKey 高亮。
//   ContributionWall({ months, activeDay, onSelectDay, t })
//                                         12 个月贡献墙：每月「周列 × 7 行」网格，5 档绿，
//                                         title = formatActivityDay，点击 → onSelectDay(date)。
//   DayCommitsPanel({ date, repo, repoFilter, t })
//                                         单日提交：date 非空时 GET /reports/day-commits?date&repo；
//                                         repoFilter 为 activity 里的「只看某仓库」chip。
//
// 共享状态：模块级 saStats store（saSet / useStatsState），aside 与 main 各自订阅同一份
// （repoQuery / repoKey / draft+applied range / analytics / openMonths / openDay / dayRepo / syncOpen）。
// 交互：快捷范围只改草稿，「查询」才应用；点某天展开、再点收起；仓库 chip = 只看该仓库。
//
// 数据面：GET /line-stats?startDate&endDate&include=excludeMerge（已确认：include 用 excludeMerge、不传 limit）、
//         GET /reports/day-commits?date&repo。
// 行为边界：StatsPanel 不发请求；StatsMain / DayCommitsPanel 自己请求（同源插件 API），失败显示本地错误条；
// 选中仓库时单日提交排除 merge / cherry-pick，与该仓库「不含合并和拣选」口径一致。
// 字段同时兼容 camelCase / snake_case。
//
// 依赖（同 factory 作用域，勿在本文件重复声明）：h/React（00-header）、api/fmtInt/fmtDate/
// fmtDateTime/showToast（10-store）、Badge/Button/Spinner/EmptyState/Input/Dialog（30-primitives）、
// ChevronGlyph/FolderGlyph/DocGlyph（20-icons）、tx（99-apply）、SyncPage（80-sync.js，同步对话框内容）。
// 纯逻辑移植自 frontend/src/features/reporting/lib/{statsModel,analyticsPresentation}.ts
// （statsRepoList / buildStatsRepoTree / filterStatsRepoTree / allContributionDays / activityRepoDays /
//   buildActivityMonths / formatActivityDay / buildContributionWallFromDays / contributionLevel），
// 以及 upstream SyncView.vue 的快捷范围、pending/applied、activity 折叠与 day-commits 交互。

addClientCSS(`
.dsr-stats { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 22px; }
.dsr-statsHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-statsScope { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-kpiGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; }
.dsr-kpi {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsr-kpiLabel { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-kpiValue { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
.dsr-kpi.accent .dsr-kpiValue { color: var(--dsw-alias-brand-primary); }
.dsr-kpiHint { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dsr-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsr-cardHead { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsr-cardTitle { font-size: 12.5px; font-weight: 600; }
.dsr-cardBody { padding: 12px; }
.dsr-cardBody.tight { padding: 0; }

.dsr-lineGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; }
.dsr-line { display: flex; flex-direction: column; gap: 3px; padding: 9px 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dsr-lineTitle { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
.dsr-lineRow { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; }
.dsr-lineRow b { font-variant-numeric: tabular-nums; font-weight: 600; }
.dsr-add { color: var(--dsw-alias-state-success-primary); }
.dsr-del { color: var(--dsw-alias-state-error-primary); }

.dsr-trendSvg { width: 100%; height: auto; display: block; }
.dsr-trendLegend { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dsr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsr-table th {
  text-align: left; font-weight: 600; font-size: 11px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); padding: 7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsr-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsr-table tr:last-child td { border-bottom: 0; }
.dsr-table .dsr-num { text-align: right; font-variant-numeric: tabular-nums; }
.dsr-repoBtn {
  display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0;
  background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.dsr-repoBtn:hover { color: var(--dsw-alias-brand-primary); }
.dsr-repoNs { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsr-branchCell { padding-left: 26px !important; color: var(--dsw-alias-label-secondary); }
.dsr-branchRow td { background: var(--dsw-alias-bg-layer-2); font-size: 11.5px; }

.dsr-bars { display: flex; flex-direction: column; gap: 8px; }
.dsr-barRow { display: grid; grid-template-columns: minmax(88px, 132px) 1fr 54px; align-items: center; gap: 10px; font-size: 12px; }
.dsr-barName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-barTrack { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsr-barFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.dsr-barVal { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }

.dsr-topics { display: flex; flex-direction: column; gap: 8px; }
.dsr-topic { display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dsr-topicHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-topicTitle { font-size: 12.5px; font-weight: 600; }
.dsr-topicSummary { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsr-statsEmpty { padding: 26px 12px; }
`);

// ---------------------------------------------------------------- 纯逻辑（移植）
/** 安全取数：undefined/null/NaN → 0。 */
function stNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 安全取文本（trim）。 */
function stText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** 兼容 camelCase / snake_case 两种 API 投影。 */
function stPick(row, keys) {
  if (!row) return undefined;
  for (let i = 0; i < keys.length; i += 1) {
    const value = row[keys[i]];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** 净增行 = 新增 - 删除。 */
function stNet(additions, deletions) {
  return stNum(additions) - stNum(deletions);
}

/** `group/sub/repo` → { displayName: 'repo', namespace: 'group/sub' }。 */
function stSplitRepo(repoKey) {
  const path = stText(repoKey);
  const index = path.lastIndexOf('/');
  if (index <= 0) return { displayName: path || '未归属仓库', namespace: '' };
  return { displayName: path.slice(index + 1), namespace: path.slice(0, index) };
}

/** 行数三口径：includeMerge=false（排除 merge/cherry-pick）/ true（全部）。 */
function stLineRows(stats) {
  const raw = Array.isArray(stats && stats.lineStats) ? stats.lineStats : [];
  const rows = raw.map((row) => ({
    includeMerge: Boolean(stPick(row, ['includeMerge', 'include_merge'])),
    additions: stNum(stPick(row, ['additions'])),
    deletions: stNum(stPick(row, ['deletions'])),
    total: stNum(stPick(row, ['total'])),
    pureAdditions: stNum(stPick(row, ['pureAdditions', 'pure_additions'])),
  }));
  return rows.sort((left, right) => Number(left.includeMerge) - Number(right.includeMerge));
}

/** 仓库×分支 → 仓库聚合行（只取 includeMerge=false，与 workbench 统计面板一致）。 */
function stRepoRows(stats) {
  const raw = Array.isArray(stats && stats.repoBranchStats) ? stats.repoBranchStats : [];
  const groups = new Map();
  for (const row of raw) {
    if (Boolean(stPick(row, ['includeMerge', 'include_merge']))) continue;
    const commitCount = stNum(stPick(row, ['commitCount', 'commit_count']));
    if (commitCount <= 0) continue;
    const repoKey = stText(stPick(row, ['repoKey', 'repo_key'])) || '未归属仓库';
    const names = stSplitRepo(repoKey);
    let current = groups.get(repoKey);
    if (!current) {
      current = {
        repoKey,
        displayName: names.displayName,
        namespace: names.namespace,
        commitCount: 0,
        additions: 0,
        deletions: 0,
        total: 0,
        net: 0,
        branches: [],
      };
      groups.set(repoKey, current);
    }
    const branch = {
      branchName: stText(stPick(row, ['branchName', 'branch_name'])) || '未归属 refs',
      commitCount,
      additions: stNum(stPick(row, ['additions'])),
      deletions: stNum(stPick(row, ['deletions'])),
      total: stNum(stPick(row, ['total'])),
      net: stNet(stPick(row, ['additions']), stPick(row, ['deletions'])),
    };
    current.commitCount += branch.commitCount;
    current.additions += branch.additions;
    current.deletions += branch.deletions;
    current.total += branch.total;
    current.net = stNet(current.additions, current.deletions);
    current.branches.push(branch);
  }
  const rows = Array.from(groups.values());
  for (const row of rows) {
    row.branches.sort((left, right) => right.total - left.total || right.commitCount - left.commitCount);
  }
  rows.sort((left, right) => right.total - left.total || right.commitCount - left.commitCount);
  return rows;
}

/** 业务域分布 [{ name, count }] → 带占比的行。 */
function stDomainRows(detail) {
  const raw = Array.isArray(detail && detail.domainDistribution) ? detail.domainDistribution : [];
  const rows = raw.map((item, index) => ({
    key: `${index}-${stText(item && item.name)}`,
    name: stText(item && item.name) || '未分类',
    count: stNum(item && item.count),
  }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const max = rows.reduce((value, row) => Math.max(value, row.count), 0);
  return {
    total,
    rows: rows.map((row) => ({
      ...row,
      share: total ? Math.round((row.count / total) * 100) : 0,
      ratio: max ? row.count / max : 0,
    })),
  };
}

/** 日分布 [{ date, count }] → 趋势图数据。 */
function stTrend(detail) {
  const raw = Array.isArray(detail && detail.dateDistribution) ? detail.dateDistribution : [];
  const points = raw
    .map((item) => ({ date: stText(item && item.date), count: stNum(item && item.count) }))
    .filter((item) => Boolean(item.date));
  const dates = points.map((item) => item.date);
  const values = points.map((item) => item.count);
  const box = { width: 720, height: 176, left: 34, right: 12, top: 12, bottom: 24 };
  const plotWidth = box.width - box.left - box.right;
  const plotHeight = box.height - box.top - box.bottom;
  const maxValue = Math.max(1, ...values);
  const gap = 2;
  const slot = values.length ? plotWidth / values.length : plotWidth;
  const barWidth = Math.max(2, slot - gap);
  const bars = points.map((point, index) => {
    const height = Math.round((point.count / maxValue) * plotHeight);
    return {
      key: `${point.date}-${index}`,
      x: box.left + index * slot + gap / 2,
      y: box.top + (plotHeight - height),
      width: Math.min(barWidth, slot - gap / 2),
      height: Math.max(height, point.count > 0 ? 2 : 0),
      date: point.date,
      count: point.count,
    };
  });
  const tickCount = Math.min(5, points.length);
  const xTicks = [];
  if (points.length) {
    for (let i = 0; i < tickCount; i += 1) {
      const pos = Math.round((i * (points.length - 1)) / Math.max(tickCount - 1, 1));
      xTicks.push({ key: `x-${pos}`, x: box.left + pos * slot + slot / 2, label: points[pos].date.slice(5) });
    }
  }
  const yTicks = [0, 1, 2, 3].map((index) => ({
    key: `y-${index}`,
    y: box.top + (index * plotHeight) / 3,
    label: String(Math.round(maxValue - (maxValue * index) / 3)),
  }));
  return { box, bars, xTicks, yTicks, maxValue, plotBottom: box.top + plotHeight, total: values.reduce((sum, n) => sum + n, 0) };
}

/** topics → 归一化列表。 */
function stTopicRows(detail) {
  const raw = Array.isArray(detail && detail.topics) ? detail.topics : [];
  return raw.map((item, index) => ({
    key: `${index}-${stText(stPick(item, ['domain']))}`,
    domain: stText(stPick(item, ['domain'])),
    title: stText(stPick(item, ['topicTitle', 'topic_title'])) || '未命名主题',
    summary: stText(stPick(item, ['summary'])),
  }));
}

/** KPI：优先 detail，其次 stats.stats（/reports/:id/stats 的 report 投影）。 */
function stKpis(detail, stats) {
  const snapshot = (stats && stats.stats) || null;
  const merged = detail || snapshot || {};
  const lineRows = stLineRows(stats);
  const preferred = lineRows.find((row) => !row.includeMerge) || lineRows[0] || null;
  const totalLines = stPick(merged, ['totalLines', 'total_lines']);
  return {
    commits: stNum(stPick(merged, ['totalCommits', 'total_commits'])),
    additions: preferred ? preferred.additions : stNum(stPick(merged, ['totalAdditions', 'total_additions'])),
    deletions: preferred ? preferred.deletions : stNum(stPick(merged, ['totalDeletions', 'total_deletions'])),
    net: preferred ? stNet(preferred.additions, preferred.deletions) : stNum(totalLines),
    repos: stNum(stPick(merged, ['repoCount', 'repo_count'])),
    mergeCommits: stNum(stPick(merged, ['mergeCommitCount', 'merge_commit_count'])),
    cherryPicks: stNum(stPick(merged, ['cherryPickCommitCount', 'cherry_pick_commit_count'])),
    nonMerge: stNum(stPick(merged, ['nonMergeCommitCount', 'non_merge_commit_count'])),
    hasPreferredLine: Boolean(preferred),
  };
}

// ---------------------------------------------------------------- 子组件
function StatsCard({ title, aside, children, tight }) {
  return h(
    'section',
    { className: 'dsr-card' },
    h('div', { className: 'dsr-cardHead' }, h('div', { className: 'dsr-cardTitle' }, title), h('div', { className: 'dsr-spacer' }), aside || null),
    h('div', { className: `dsr-cardBody${tight ? ' tight' : ''}` }, children),
  );
}

function StatsKpi({ label, value, hint, accent }) {
  return h(
    'div',
    { className: `dsr-kpi${accent ? ' accent' : ''}` },
    h('div', { className: 'dsr-kpiLabel' }, label),
    h('div', { className: 'dsr-kpiValue' }, fmtInt(value)),
    hint ? h('div', { className: 'dsr-kpiHint' }, hint) : null,
  );
}

function StatsLineCards({ t, rows }) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  return h(
    'div',
    { className: 'dsr-lineGrid' },
    ...rows.map((row) =>
      h(
        'div',
        { className: 'dsr-line', key: row.includeMerge ? 'with-merge' : 'without-merge' },
        h(
          'div',
          { className: 'dsr-lineTitle' },
          row.includeMerge ? tr('lineWithMerge', '含 merge / cherry-pick') : tr('lineWithoutMerge', '不含 merge / cherry-pick'),
        ),
        h(
          'div',
          { className: 'dsr-lineRow' },
          h('span', null, tr('additions', '新增行')),
          h('b', { className: 'dsr-add' }, `+${fmtInt(row.additions)}`),
        ),
        h(
          'div',
          { className: 'dsr-lineRow' },
          h('span', null, tr('deletions', '删除行')),
          h('b', { className: 'dsr-del' }, `-${fmtInt(row.deletions)}`),
        ),
        h('div', { className: 'dsr-lineRow' }, h('span', null, tr('totalChange', '总变更')), h('b', null, fmtInt(row.total))),
        h(
          'div',
          { className: 'dsr-lineRow' },
          h('span', null, tr('pureAdditions', '纯增行')),
          h('b', null, fmtInt(row.pureAdditions)),
        ),
      ),
    ),
  );
}

function StatsTrendChart({ t, trend }) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const { box, bars, xTicks, yTicks, plotBottom } = trend;
  return h(
    'div',
    { className: 'dsr-trendWrap' },
    h(
      'svg',
      {
        className: 'dsr-trendSvg',
        viewBox: `0 0 ${box.width} ${box.height}`,
        role: 'img',
        'aria-label': tr('trendTitle', '提交趋势'),
      },
      ...yTicks.map((tick) =>
        h(
          'g',
          { key: tick.key },
          h('line', {
            x1: box.left,
            x2: box.width - box.right,
            y1: tick.y,
            y2: tick.y,
            stroke: 'currentColor',
            strokeOpacity: 0.12,
            strokeWidth: 1,
          }),
          h(
            'text',
            { x: box.left - 8, y: tick.y + 4, textAnchor: 'end', fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 },
            tick.label,
          ),
        ),
      ),
      ...bars.map((bar) =>
        h(
          'g',
          { key: bar.key },
          h('rect', {
            x: bar.x,
            y: bar.y,
            width: bar.width,
            height: bar.height,
            rx: 2,
            style: { fill: 'var(--dsw-alias-brand-primary)', opacity: 0.55 },
          }),
          h('title', null, `${bar.date} · ${bar.count} ${tr('commits', '提交')}`),
        ),
      ),
      h('line', {
        x1: box.left,
        x2: box.width - box.right,
        y1: plotBottom,
        y2: plotBottom,
        stroke: 'currentColor',
        strokeOpacity: 0.28,
        strokeWidth: 1,
      }),
      ...xTicks.map((tick) =>
        h(
          'text',
          { key: tick.key, x: tick.x, y: plotBottom + 15, textAnchor: 'middle', fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 },
          tick.label,
        ),
      ),
    ),
  );
}

function StatsRepoTable({ t, rows }) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const [open, setOpen] = React.useState(() => ({}));
  const toggle = (repoKey) => setOpen((current) => ({ ...current, [repoKey]: !current[repoKey] }));
  const header = h(
    'tr',
    null,
    h('th', null, tr('repos', '仓库')),
    h('th', { className: 'dsr-num' }, tr('commits', '提交')),
    h('th', { className: 'dsr-num' }, tr('additions', '新增行')),
    h('th', { className: 'dsr-num' }, tr('deletions', '删除行')),
    h('th', { className: 'dsr-num' }, tr('totalChange', '总变更')),
    h('th', { className: 'dsr-num' }, tr('netChange', '净增行')),
  );
  return h(
    'table',
    { className: 'dsr-table' },
    h('thead', null, header),
    h(
      'tbody',
      null,
      ...rows.flatMap((row) => {
        const isOpen = Boolean(open[row.repoKey]);
        const nodes = [
          h(
            'tr',
            { key: row.repoKey },
            h(
              'td',
              null,
              h(
                'button',
                { type: 'button', className: 'dsr-repoBtn', onClick: () => toggle(row.repoKey) },
                h('span', { style: { display: 'inline-flex', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(ChevronGlyph, { size: 12 })),
                h('span', null, row.displayName),
                row.namespace ? h('span', { className: 'dsr-repoNs' }, row.namespace) : null,
                h(Badge, null, String(row.branches.length)),
              ),
            ),
            h('td', { className: 'dsr-num' }, fmtInt(row.commitCount)),
            h('td', { className: 'dsr-num dsr-add' }, `+${fmtInt(row.additions)}`),
            h('td', { className: 'dsr-num dsr-del' }, `-${fmtInt(row.deletions)}`),
            h('td', { className: 'dsr-num' }, fmtInt(row.total)),
            h('td', { className: 'dsr-num' }, fmtInt(row.net)),
          ),
        ];
        if (isOpen) {
          for (const branch of row.branches) {
            nodes.push(
              h(
                'tr',
                { key: `${row.repoKey}::${branch.branchName}`, className: 'dsr-branchRow' },
                h('td', { className: 'dsr-branchCell' }, branch.branchName),
                h('td', { className: 'dsr-num' }, fmtInt(branch.commitCount)),
                h('td', { className: 'dsr-num dsr-add' }, `+${fmtInt(branch.additions)}`),
                h('td', { className: 'dsr-num dsr-del' }, `-${fmtInt(branch.deletions)}`),
                h('td', { className: 'dsr-num' }, fmtInt(branch.total)),
                h('td', { className: 'dsr-num' }, fmtInt(branch.net)),
              ),
            );
          }
        }
        return nodes;
      }),
    ),
  );
}

function StatsDomainBars({ rows, total }) {
  return h(
    'div',
    { className: 'dsr-bars' },
    ...rows.map((row) =>
      h(
        'div',
        { className: 'dsr-barRow', key: row.key, title: `${row.name} · ${row.count}（${row.share}%）` },
        h('span', { className: 'dsr-barName' }, row.name),
        h('span', { className: 'dsr-barTrack' }, h('span', { className: 'dsr-barFill', style: { width: `${Math.max(row.ratio * 100, 2)}%` } })),
        h('span', { className: 'dsr-barVal' }, `${fmtInt(row.count)} · ${row.share}%`),
      ),
    ),
    h('div', { className: 'dsr-hint' }, `共 ${fmtInt(total)} 次提交归属到 ${rows.length} 个业务域`),
  );
}

function StatsTopicList({ rows }) {
  return h(
    'div',
    { className: 'dsr-topics' },
    ...rows.map((row) =>
      h(
        'div',
        { className: 'dsr-topic', key: row.key },
        h('div', { className: 'dsr-topicHead' }, row.domain ? h(Badge, null, row.domain) : null, h('span', { className: 'dsr-topicTitle' }, row.title)),
        row.summary ? h('div', { className: 'dsr-topicSummary' }, row.summary) : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------- 面板入口
/**
 * 契约组件：统计 tab 内容。
 * @param {{ t?: Function, detail?: object|null, stats?: object|null }} props
 *   detail: ReportDetail（含 topics / 三个 distribution）
 *   stats : GET /reports/:id/stats → { stats, lineStats, repoBranchStats }
 */
function StatsPanel(props) {
  const { t, detail, stats } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const snapshot = (stats && stats.stats) || null;
  const merged = detail || snapshot || null;
  const lineRows = stLineRows(stats);
  const repoRows = stRepoRows(stats);
  const domain = stDomainRows(merged);
  const topics = stTopicRows(merged);
  const trend = stTrend(merged);
  const kpis = stKpis(detail, stats);
  const hasAny = Boolean(merged) || lineRows.length > 0 || repoRows.length > 0;

  if (!hasAny) {
    return h(EmptyState, { title: tr('noStats', '暂无统计数据'), hint: tr('noStatsHint', '这份报告还没有可展示的统计投影') });
  }

  const scopeHint = merged && merged.periodStart
    ? `${fmtDate(merged.periodStart)} → ${fmtDate(merged.periodEnd)}`
    : '';

  const cards = [];

  cards.push(
    h(
      'div',
      { className: 'dsr-kpiGrid', key: 'kpi' },
      h(StatsKpi, { label: tr('commits', '提交'), value: kpis.commits }),
      h(StatsKpi, { label: tr('additions', '新增行'), value: kpis.additions }),
      h(StatsKpi, { label: tr('deletions', '删除行'), value: kpis.deletions }),
      h(StatsKpi, { label: tr('totalLines', '净增行'), value: kpis.net, accent: true }),
      h(StatsKpi, { label: tr('repos', '仓库'), value: kpis.repos }),
      h(StatsKpi, { label: tr('mergeCommits', '合并提交'), value: kpis.mergeCommits, hint: `${tr('cherryPicks', '拣选提交')} ${fmtInt(kpis.cherryPicks)}` }),
    ),
  );

  if (lineRows.length) {
    cards.push(
      h(
        StatsCard,
        { key: 'lines', title: tr('lineStats', '代码行数（三种口径）'), tight: false },
        h(StatsLineCards, { t, rows: lineRows }),
      ),
    );
  }

  if (trend.bars.length) {
    cards.push(
      h(
        StatsCard,
        {
          key: 'trend',
          title: tr('trendTitle', '提交趋势'),
          aside: h('span', { className: 'dsr-trendLegend' }, `${trend.bars.length} 天 · ${fmtInt(trend.total)} ${tr('commits', '提交')}`),
        },
        h(StatsTrendChart, { t, trend }),
      ),
    );
  }

  if (repoRows.length) {
    cards.push(
      h(
        StatsCard,
        {
          key: 'repos',
          title: tr('repoBreakdown', '仓库分布'),
          aside: h(Badge, null, `${repoRows.length} ${tr('repos', '仓库')}`),
          tight: true,
        },
        h(StatsRepoTable, { t, rows: repoRows }),
      ),
    );
  }

  if (domain.rows.length) {
    cards.push(
      h(
        StatsCard,
        { key: 'domains', title: tr('domainDist', '业务域分布'), aside: h(Badge, null, `${domain.rows.length}`) },
        h(StatsDomainBars, { rows: domain.rows, total: domain.total }),
      ),
    );
  }

  if (topics.length) {
    cards.push(h(StatsCard, { key: 'topics', title: tr('topics', '主题概览'), aside: h(Badge, null, `${topics.length}`) }, h(StatsTopicList, { rows: topics })));
  }

  return h(
    'div',
    { className: 'dsr-stats' },
    h(
      'div',
      { className: 'dsr-statsHead' },
      h('span', { className: 'dsr-cardTitle' }, tr('statistics', '统计')),
      scopeHint ? h('span', { className: 'dsr-statsScope' }, scopeHint) : null,
      merged && merged.generatedAt ? h('span', { className: 'dsr-statsScope' }, `· ${tr('generatedAt', '生成时间')} ${fmtDateTime(merged.generatedAt)}`) : null,
    ),
    ...cards,
  );
}

// ================================================================ 统计区域 v2（按最新 upstream 统计页重排，T-261106-ui-stats-v2）
// 落位（主机壳 99-apply 负责组装）：
//   aside = chrome 行 + 区导航 + StatsAside({ t, state, actions })（搜索仓库 + 全部仓库行 + 仓库树）
//   main  = StatsMain({ t, state, actions })（stats-title 工具条 + 贡献墙 + 覆盖度提示 + 摘要 + 分支条 + 提交记录）
//   同步  = StatsMain 内「同步数据」→ Dialog(900) 内嵌同作用域 SyncPage（Phase 1；Phase 2 再按 upstream 四块样式化）
// StatsPanel({ t, detail, stats })（报告详情「统计」tab）保持不变。
//
// 数据面：GET /line-stats?startDate&endDate&include=excludeMerge（已确认：include 用 excludeMerge、不传 limit）
//         GET /reports/day-commits?date&repo
// 交互：快捷范围只改草稿，「查询」才应用；点某天展开当天提交（再点收起）；仓库 chip = 只看该仓库；
//       选中仓库时 KPI/摘要/贡献墙/分支条/提交记录全部按其过滤。
// 新样式类统一 dsr-stt-* 前缀；复用类（dsr-wall*/dsr-day*/dsr-repoTree*/dsr-kpi*）沿用上一版。

addClientCSS(`
.dsr-stt-aside { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsr-stt-asideSearch { height: 28px; }
.dsr-stt-allRepos {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 10px;
  border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.dsr-stt-allRepos:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-stt-allRepos.is-active { background: var(--dsw-alias-bg-layer-2); font-weight: 600; box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }
.dsr-stt-allRepos > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-stt-count { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsr-stt-asideEmpty { margin: 0; padding: 8px 10px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

.dsr-stt-main { display: flex; flex-direction: column; min-height: 100%; }
.dsr-stt-page { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 28px; min-height: 0; }
.dsr-stt-title { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.dsr-stt-titleCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsr-stt-name { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; }
.dsr-stt-path { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-stt-rule { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-stt-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dsr-stt-ranges { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dsr-stt-range {
  height: 26px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.dsr-stt-range:hover { color: var(--dsw-alias-label-primary); }
.dsr-stt-range.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.dsr-stt-range:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsr-stt-dates { display: inline-flex; align-items: center; gap: 6px; }
.dsr-stt-date {
  height: 28px; padding: 0 8px; font: inherit; font-size: 12px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
}
.dsr-stt-date:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-stt-dateSep { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dsr-stt-genWrap { display: inline-flex; }

.dsr-stt-wall { display: flex; flex-direction: column; gap: 8px; }
.dsr-stt-note { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsr-stt-error {
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); font-size: 12px;
}
.dsr-stt-summary { display: flex; align-items: baseline; gap: 22px; flex-wrap: wrap; padding: 2px 2px 0; }
.dsr-stt-figure { display: inline-flex; align-items: baseline; gap: 6px; margin: 0; }
.dsr-stt-figure strong { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.dsr-stt-figure span { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-stt-add { color: var(--dsw-alias-state-success-primary); font-variant-numeric: tabular-nums; }
.dsr-stt-del { color: var(--dsw-alias-state-error-primary); font-variant-numeric: tabular-nums; }

.dsr-stt-branches { display: flex; flex-direction: column; gap: 7px; }
.dsr-stt-branch { display: grid; grid-template-columns: minmax(90px, 180px) minmax(0, 1fr) auto; align-items: center; gap: 10px; font-size: 11.5px; }
.dsr-stt-branchName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.dsr-stt-branchTrack { height: 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsr-stt-branchFill { display: block; height: 100%; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent); }
.dsr-stt-branchMeta { color: var(--dsw-alias-label-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }

.dsr-stt-activity { display: flex; flex-direction: column; gap: 2px; }
.dsr-stt-activityTitle { margin: 0 0 4px; font-size: 12.5px; font-weight: 600; }
.dsr-stt-month { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsr-stt-month:last-child { border-bottom: 0; }
.dsr-stt-monthRow {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 6px;
  border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit;
  font-size: 12.5px; cursor: pointer; text-align: left;
}
.dsr-stt-monthRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-stt-monthRow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-stt-monthChevron { display: inline-grid; place-items: center; width: 12px; flex: none; color: var(--dsw-alias-label-secondary); }
.dsr-stt-monthLabel { flex: none; min-width: 72px; font-weight: 600; }
.dsr-stt-monthBar { flex: 1; min-width: 40px; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsr-stt-monthBarFill { display: block; height: 100%; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); }
.dsr-stt-monthCount { flex: none; min-width: 56px; text-align: right; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-size: 11.5px; }
.dsr-stt-days { display: flex; flex-direction: column; padding: 2px 0 8px 20px; }
.dsr-stt-day { border: 0; }
.dsr-stt-dayRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 2px 0; }
.dsr-stt-dayBtn {
  display: inline-flex; align-items: center; gap: 8px; padding: 4px 8px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
}
.dsr-stt-dayBtn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-stt-dayBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-stt-dayDate { font-variant-numeric: tabular-nums; }
.dsr-stt-dayCount { color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.dsr-stt-chips { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dsr-stt-chip {
  height: 20px; padding: 0 7px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 10.5px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsr-stt-chip:hover { color: var(--dsw-alias-label-primary); }
.dsr-stt-chip.is-active { color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsr-stt-chip.is-more { color: var(--dsw-alias-label-primary); }
.dsr-stt-dayDetail { padding: 2px 0 8px 8px; }

.dsr-stt-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 24px 4px; }
.dsr-stt-syncBody { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dsr-stt-syncBody .dsr-sync { padding: 0; max-width: none; }
.dsr-stt-todo { font-size: 11px; color: var(--dsw-alias-label-secondary); }
`);

// ---------------------------------------------------------------- 状态 store（aside 与 main 共享）
const SA_QUICK_RANGES = [
  { kind: 'last7', label: '近 7 天' },
  { kind: 'last30', label: '近 30 天' },
  { kind: 'week', label: '本周' },
  { kind: 'month', label: '当月' },
  { kind: 'lastMonth', label: '上个月' },
  { kind: 'last12', label: '近 12 个月' },
];

function saPad2(value) {
  return String(value).padStart(2, '0');
}

function saDateString(date) {
  return `${date.getFullYear()}-${saPad2(date.getMonth() + 1)}-${saPad2(date.getDate())}`;
}

function saAddDaysDate(base, days) {
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/** 快捷范围 → ['YYYY-MM-DD','YYYY-MM-DD']（本地时区；周一为本周首日）。 */
function saRangeForKind(kind) {
  const now = new Date();
  if (kind === 'last7') return [saDateString(saAddDaysDate(now, -6)), saDateString(now)];
  if (kind === 'last30') return [saDateString(saAddDaysDate(now, -29)), saDateString(now)];
  if (kind === 'week') {
    const weekday = now.getDay();
    const monday = saAddDaysDate(now, weekday === 0 ? -6 : 1 - weekday);
    return [saDateString(monday), saDateString(saAddDaysDate(monday, 6))];
  }
  if (kind === 'month') {
    return [saDateString(new Date(now.getFullYear(), now.getMonth(), 1)), saDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
  }
  if (kind === 'lastMonth') {
    return [saDateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)), saDateString(new Date(now.getFullYear(), now.getMonth(), 0))];
  }
  return [saDateString(saAddDaysDate(now, -364)), saDateString(now)];
}

/** 区间天数（含首尾）。 */
function saSpanDays(start, end) {
  if (!start || !end) return 0;
  const from = new Date(`${start}T00:00:00`).getTime();
  const to = new Date(`${end}T00:00:00`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000) + 1;
}

/** 自定义区间 → 报告类型（与 upstream useReportGenerate 的推断口径一致）。 */
function saInferReportType(start, end) {
  const days = saSpanDays(start, end);
  if (days <= 10) return 'week';
  if (days <= 45) return 'month';
  if (days <= 120) return 'quarter';
  return 'year';
}

/** 「11月5日」。 */
function saDayLabel(date) {
  const text = stText(date);
  return `${Number(text.slice(5, 7))}月${Number(text.slice(8, 10))}日`;
}

/** 归档数据里最早的一天（用于「有些日子还没同步」提示）。 */
function saEarliestDay(days) {
  let earliest = '';
  for (const day of days || []) {
    const date = stText(day && day.date).slice(0, 10);
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest;
}

// ---------------------------------------------------------------- 从 upstream 移植的纯逻辑
// （statsModel.ts：statsRepoList / buildStatsRepoTree / filterStatsRepoTree / allContributionDays /
//   activityRepoDays / buildActivityMonths / formatActivityDay；
//   analyticsPresentation.ts：buildContributionWallFromDays / contributionLevel）
/** line-stats 的 repoCards（excludeMerge 优先）。 */
function saRepoCards(response) {
  const cards = response && response.repoCards;
  const list = Array.isArray(cards) ? cards : (cards && (cards.excludeMerge || cards.items)) || [];
  return Array.isArray(list) ? list : [];
}

/** 仓库选项：coverage 仓库打底 + repoCards 覆盖计数（statsRepoList）。 */
function saRepoList(cards, coverageRepos) {
  const byKey = new Map();
  for (const repo of coverageRepos || []) {
    const repoKey = stText(repo && (repo.pathWithNamespace || repo.projectId));
    if (!repoKey || byKey.has(repoKey)) continue;
    const names = stSplitRepo(repoKey);
    byKey.set(repoKey, {
      repoKey,
      displayName: names.displayName,
      namespace: names.namespace,
      commitCount: 0,
      additions: 0,
      deletions: 0,
      branches: [],
      contributionDays: [],
    });
  }
  for (const card of cards || []) {
    const repoKey = stText(card && card.repoKey);
    if (!repoKey) continue;
    const names = stSplitRepo(repoKey);
    byKey.set(repoKey, {
      repoKey,
      displayName: names.displayName,
      namespace: names.namespace,
      commitCount: stNum(card.commitCount),
      additions: stNum(card.additions),
      deletions: stNum(card.deletions),
      branches: (Array.isArray(card.branches) ? card.branches : []).map((branch) => ({
        branchName: stText(branch && branch.branchName) || '未归属分支',
        commitCount: stNum(branch && branch.commitCount),
        additions: stNum(branch && branch.additions),
        deletions: stNum(branch && branch.deletions),
      })),
      contributionDays: Array.isArray(card.contributionDays) ? card.contributionDays : [],
    });
  }
  return Array.from(byKey.values()).sort(
    (left, right) => right.commitCount - left.commitCount || left.displayName.localeCompare(right.displayName, 'zh-CN'),
  );
}

function saEnsureGroup(parent, key, label) {
  const existing = parent.find((node) => node.type === 'group' && node.key === key);
  if (existing) return existing;
  const group = { type: 'group', key, label, commitCount: 0, children: [] };
  parent.push(group);
  return group;
}

function saSortTree(nodes) {
  nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'group' ? -1 : 1;
    return left.label.localeCompare(right.label, 'zh-CN');
  });
  for (const node of nodes) {
    if (node.type !== 'group') continue;
    saSortTree(node.children);
    node.commitCount = node.children.reduce(
      (sum, child) => sum + (child.type === 'group' ? child.commitCount : child.repo.commitCount),
      0,
    );
  }
}

/** 仓库按路径分段成树（buildStatsRepoTree）。 */
function saBuildTree(repos) {
  const roots = [];
  for (const repo of repos || []) {
    const segments = String(repo.repoKey || '').split('/').filter(Boolean);
    const groups = segments.length > 1 ? segments.slice(0, -1) : [];
    let bucket = roots;
    let key = '';
    for (const part of groups) {
      key = key ? `${key}/${part}` : part;
      bucket = saEnsureGroup(bucket, key, part).children;
    }
    bucket.push({
      type: 'repo',
      key: repo.repoKey,
      label: repo.displayName || segments[segments.length - 1] || repo.repoKey,
      repo,
    });
  }
  saSortTree(roots);
  return roots;
}

/** 按关键字过滤树，保留命中叶子的祖先（filterStatsRepoTree）。 */
function saFilterTree(nodes, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return nodes;
  const keep = (node) => {
    if (node.type === 'repo') {
      const hay = `${node.label} ${node.repo.repoKey} ${node.repo.namespace || ''}`.toLowerCase();
      return hay.includes(needle) ? node : null;
    }
    const children = node.children.map(keep).filter(Boolean);
    if (children.length) {
      return {
        ...node,
        children,
        commitCount: children.reduce(
          (sum, child) => sum + (child.type === 'group' ? child.commitCount : child.repo.commitCount),
          0,
        ),
      };
    }
    if (node.label.toLowerCase() === needle) return node;
    return null;
  };
  return nodes.map(keep).filter(Boolean);
}

/** 日提交分布（优先 dateDistribution，退化到 repoCards 的 contributionDays 求和）。 */
function saAllDays(response) {
  const distribution = Array.isArray(response && response.dateDistribution) ? response.dateDistribution : [];
  const fromDistribution = distribution
    .map((item) => ({ date: stText(item && item.date).slice(0, 10), count: stNum(item && (item.count !== undefined ? item.count : item.commitCount)) }))
    .filter((item) => item.date);
  if (fromDistribution.length) return fromDistribution;
  const totals = new Map();
  for (const card of saRepoCards(response)) {
    for (const day of Array.isArray(card.contributionDays) ? card.contributionDays : []) {
      const date = stText(day && day.date).slice(0, 10);
      if (!date) continue;
      totals.set(date, stNum(totals.get(date)) + stNum(day && day.count));
    }
  }
  return Array.from(totals, ([date, count]) => ({ date, count }));
}

/** 逐仓库逐日活跃度（activityRepoDays）。 */
function saRepoDays(cards) {
  const rows = [];
  for (const card of cards || []) {
    const repo = stSplitRepo(stText(card && card.repoKey)).displayName;
    if (!repo) continue;
    for (const day of Array.isArray(card.contributionDays) ? card.contributionDays : []) {
      rows.push({ date: day && day.date, repo, count: day && day.count });
    }
  }
  return rows;
}

/** 月 → 日 → 仓库（buildActivityMonths，月/日均为倒序）。 */
function saActivityMonths(days, repoDays) {
  const byDate = new Map();
  for (const day of days || []) {
    const date = stText(day && day.date).slice(0, 10);
    const count = stNum(day && day.count);
    if (!date || count <= 0) continue;
    byDate.set(date, { count, repos: [] });
  }
  for (const item of repoDays || []) {
    const date = stText(item && item.date).slice(0, 10);
    const repo = stText(item && item.repo);
    const count = stNum(item && item.count);
    if (!date || count <= 0 || !repo) continue;
    const slot = byDate.get(date);
    if (!slot) {
      byDate.set(date, { count, repos: [repo] });
      continue;
    }
    if (!slot.repos.includes(repo)) slot.repos.push(repo);
  }
  const months = new Map();
  for (const [date, slot] of byDate) {
    const key = date.slice(0, 7);
    const month = months.get(key) || { key, label: `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`, count: 0, days: [] };
    month.count += slot.count;
    month.days.push({ date, count: slot.count, repos: slot.repos.slice().sort((left, right) => left.localeCompare(right, 'zh-CN')) });
    months.set(key, month);
  }
  return Array.from(months.values())
    .sort((left, right) => right.key.localeCompare(left.key))
    .map((month) => ({ ...month, days: month.days.slice().sort((left, right) => right.date.localeCompare(left.date)) }));
}

/** 「11月5日 · 37 次 · crm/order」（formatActivityDay）。 */
function saFormatDay(day) {
  const date = stText(day && day.date);
  const month = Number(date.slice(5, 7));
  const dayOfMonth = Number(date.slice(8, 10));
  const names = (Array.isArray(day && day.repos) ? day.repos : []).filter(Boolean);
  const suffix = names.length ? ` · ${names.join('、')}` : '';
  return `${month}月${dayOfMonth}日 · ${fmtInt(stNum(day && day.count))} 次${suffix}`;
}

/** 提交计数分档（contributionLevel）：count>0 时按分位数落在 1–4 档。 */
function saLevel(count, positiveAsc) {
  if (count <= 0 || !positiveAsc.length) return 0;
  let below = 0;
  for (const value of positiveAsc) if (value < count) below += 1;
  const ratio = below / positiveAsc.length;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

/** 单月 → 周列 × 7 行网格（周日为第 1 行，与 upstream weekdayIndex 对齐）。 */
function saMonthGrid(month, positives) {
  const days = Array.isArray(month && month.days) ? month.days : [];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const parts = String((month && month.key) || '').split('-');
  const year = Number(parts[0]);
  const monthNumber = Number(parts[1]);
  if (!year || !monthNumber) return { key: '', label: '', count: 0, cells: [], weekCount: 0 };
  const totalDays = new Date(year, monthNumber, 0).getDate();
  const cells = [];
  let weekIndex = 0;
  for (let dayOfMonth = 1; dayOfMonth <= totalDays; dayOfMonth += 1) {
    const date = `${month.key}-${saPad2(dayOfMonth)}`;
    const weekdayIndex = new Date(year, monthNumber - 1, dayOfMonth).getDay();
    const slot = byDate.get(date);
    const count = slot ? stNum(slot.count) : 0;
    cells.push({
      key: date,
      date,
      count,
      weekIndex,
      weekdayIndex,
      level: saLevel(count, positives),
      repos: slot ? slot.repos : [],
      title: saFormatDay({ date, count, repos: slot ? slot.repos : [] }),
    });
    if (weekdayIndex === 6) weekIndex += 1;
  }
  const weekCount = cells.length ? Math.max(...cells.map((cell) => cell.weekIndex)) + 1 : 0;
  return { key: month.key, label: month.label, count: stNum(month.count), cells, weekCount };
}

/** 趋势点：点多于 90 个时按自然周聚合（供报告详情趋势复用；统计页 v2 不渲染趋势）。 */
function saTrendPoints(response) {
  const dist = Array.isArray(response && response.dateDistribution) ? response.dateDistribution : [];
  const points = dist
    .map((item) => ({ date: stText(item && item.date).slice(0, 10), count: stNum(item && (item.count !== undefined ? item.count : item.commitCount)) }))
    .filter((item) => item.date)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (points.length <= 90) return { points, aggregated: false };
  const buckets = new Map();
  for (const point of points) {
    const date = new Date(`${point.date}T00:00:00`);
    const monday = saAddDaysDate(date, -((date.getDay() + 6) % 7));
    const key = saDateString(monday);
    buckets.set(key, stNum(buckets.get(key)) + point.count);
  }
  const weekly = Array.from(buckets, ([date, count]) => ({ date, count })).sort((left, right) => left.date.localeCompare(right.date));
  return { points: weekly, aggregated: true };
}

/** 兼容旧调用：saRange(kind) === saRangeForKind(kind)。 */
function saRange(kind) {
  return saRangeForKind(kind);
}

const SA_INITIAL_RANGE = saRangeForKind('last12');

const saStats = {
  repoQuery: '',
  repoKey: '',
  kind: 'last12',
  draftStart: SA_INITIAL_RANGE[0],
  draftEnd: SA_INITIAL_RANGE[1],
  appliedStart: SA_INITIAL_RANGE[0],
  appliedEnd: SA_INITIAL_RANGE[1],
  appliedKind: 'last12',
  analytics: null,
  coverage: null,
  loading: false,
  error: '',
  openMonths: {},
  monthsInitFor: '',
  openDay: '',
  dayRepo: '',
  expandedChips: {},
  syncOpen: false,
  staleAfterSync: false,
};

const saListeners = new Set();

function saSet(patch) {
  Object.assign(saStats, patch);
  for (const listener of saListeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/** 订阅统计区状态（aside 与 main 共用同一个 store）。 */
function useStatsState() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const listener = () => force((value) => value + 1);
    saListeners.add(listener);
    return () => saListeners.delete(listener);
  }, []);
  return saStats;
}

/** 拉取 /line-stats（include=excludeMerge；不传 limit，api 默认不截断）。 */
async function saLoadAnalytics(force) {
  if (saStats.loading && !force) return;
  const start = saStats.appliedStart;
  const end = saStats.appliedEnd;
  if (!start || !end) return;
  saSet({ loading: true, error: '' });
  try {
    const [data, coverage] = await Promise.all([
      api.get(`/line-stats?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&include=excludeMerge`),
      api.get(`/sync/coverage?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`).catch(() => null),
    ]);
    saSet({ analytics: data || null, coverage: coverage || null, loading: false, openDay: '', dayRepo: '', staleAfterSync: false });
  } catch (error) {
    saSet({ loading: false, error: saErrText(error) });
  }
}

function saApplyRange() {
  saSet({
    appliedStart: saStats.draftStart,
    appliedEnd: saStats.draftEnd,
    appliedKind: saStats.kind,
    openDay: '',
    dayRepo: '',
    openMonths: {},
    monthsInitFor: '',
  });
  saLoadAnalytics(true);
}

function saSetQuickRange(kind) {
  const range = saRangeForKind(kind);
  saSet({ kind, draftStart: range[0], draftEnd: range[1] });
}

function saSetDraft(which, value) {
  // 手改日期后不再对应任何快捷范围
  if (which === 'start') saSet({ draftStart: value, kind: '' });
  else saSet({ draftEnd: value, kind: '' });
}

function saSelectRepo(repoKey) {
  saSet({ repoKey: repoKey || '', openDay: '', dayRepo: '', expandedChips: {} });
}

function saToggleMonth(key) {
  const next = { ...saStats.openMonths };
  if (next[key]) delete next[key];
  else next[key] = true;
  saSet({ openMonths: next });
}

function saToggleDay(date) {
  if (saStats.openDay === date) saSet({ openDay: '', dayRepo: '' });
  else saSet({ openDay: date, dayRepo: '' });
}

function saPickDayRepo(date, name) {
  const active = saStats.openDay === date && saStats.dayRepo === name;
  saSet({ openDay: date, dayRepo: active ? '' : name });
}

// 派生数据按 analytics 引用缓存，纯逻辑只跑一次
let saDerivedCache = { analytics: undefined, coverage: undefined, cards: [], repos: [], tree: [], summary: {} };

function saStatsDerived(analytics) {
  if (saDerivedCache.analytics === analytics && saDerivedCache.coverage === saStats.coverage) return saDerivedCache;
  const cards = saRepoCards(analytics);
  const coverageRepos = (saStats.coverage && Array.isArray(saStats.coverage.repos) && saStats.coverage.repos) || [];
  const repos = saRepoList(cards, coverageRepos);
  saDerivedCache = {
    analytics,
    coverage: saStats.coverage,
    cards,
    repos,
    tree: saBuildTree(repos),
    summary: (analytics && analytics.summary) || {},
  };
  return saDerivedCache;
}

// ---------------------------------------------------------------- 仓库树
/** 递归仓库树：文件夹折叠、叶子选中。props: { nodes, activeKey, onSelect, depth, forceOpen, t } */
function StatsRepoTree(props) {
  const { nodes, activeKey, onSelect, depth, forceOpen } = props || {};
  const level = Number.isFinite(depth) ? depth : 0;
  const [collapsed, setCollapsed] = React.useState(() => ({}));
  const rows = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const indent = 10 + level * 14;
    if (node.type === 'group') {
      const open = Boolean(forceOpen) || !collapsed[node.key];
      rows.push(
        h(
          'button',
          {
            key: `g:${node.key}`,
            type: 'button',
            className: 'dsr-repoTreeRow dsr-repoTreeFolder',
            style: { paddingLeft: `${indent}px` },
            'aria-expanded': open,
            onClick: () => setCollapsed((current) => ({ ...current, [node.key]: !current[node.key] })),
          },
          h(
            'span',
            { className: 'dsr-repoTreeChevron' },
            h('span', { style: { display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(ChevronGlyph, { size: 11 })),
          ),
          h(FolderGlyph, { size: 13 }),
          h('span', { className: 'dsr-repoTreeName' }, node.label),
          h('span', { className: 'dsr-repoTreeCount' }, fmtInt(node.commitCount)),
        ),
      );
      if (open && node.children && node.children.length) {
        rows.push(
          h(StatsRepoTree, {
            key: `gc:${node.key}`,
            nodes: node.children,
            activeKey,
            onSelect,
            depth: level + 1,
            forceOpen,
            t: props && props.t,
          }),
        );
      }
      continue;
    }
    const active = node.key === activeKey;
    rows.push(
      h(
        'button',
        {
          key: `r:${node.key}`,
          type: 'button',
          role: 'treeitem',
          'aria-selected': active,
          title: (node.repo && node.repo.repoKey) || node.key,
          className: `dsr-repoTreeRow dsr-repoTreeRepo${active ? ' is-active' : ''}`,
          style: { paddingLeft: `${indent}px` },
          onClick: () => onSelect && onSelect(node.key),
        },
        h('span', { className: 'dsr-repoTreeChevron' }),
        h(DocGlyph, { size: 13 }),
        h('span', { className: 'dsr-repoTreeName' }, node.label),
        h('span', { className: 'dsr-repoTreeCount' }, fmtInt(node.repo && node.repo.commitCount)),
      ),
    );
  }
  return h('div', { className: `dsr-repoTree${level === 0 ? ' is-root' : ''}`, role: level === 0 ? 'tree' : 'group' }, ...rows);
}

// ---------------------------------------------------------------- 贡献墙
/** 12 个月贡献墙：每月「周列 × 7 行」网格，5 档绿，点击某天回调。 */
function ContributionWall(props) {
  const { months, activeDay, onSelectDay, t, startDate, endDate } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);

  /** 提交日期 → 次数（来自 activity 的月/日）。 */
  const dayMap = new Map();
  for (const month of Array.isArray(months) ? months : []) {
    for (const day of Array.isArray(month.days) ? month.days : []) {
      const date = String((day && day.date) || '').slice(0, 10);
      if (date) dayMap.set(date, stNum(day && day.count));
    }
  }

  const pad2 = (value) => String(value).padStart(2, '0');
  const parseDay = (value) => {
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
  };
  const formatDay = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  const validStart = /^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''));
  const validEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''));
  let rangeStart = validStart ? String(startDate) : '';
  let rangeEnd = validEnd ? String(endDate) : '';
  if (!rangeStart || !rangeEnd) {
    const keys = [...dayMap.keys()].sort();
    if (!keys.length) {
      return h(EmptyState, { title: tr('noActivity', '这段时间还没有提交'), hint: tr('noActivityHint', '先去同步数据，或换一个范围') });
    }
    rangeStart = keys[0];
    rangeEnd = keys[keys.length - 1];
  }
  if (rangeStart > rangeEnd) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];

  // 按范围补全每一天（workbench buildContributionCells 的口径：范围内每天一个格子）
  const days = [];
  for (let cursor = parseDay(rangeStart); formatDay(cursor) <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
    const date = formatDay(cursor);
    days.push({ date, count: dayMap.get(date) || 0 });
  }
  if (!days.length) {
    return h(EmptyState, { title: tr('noActivity', '这段时间还没有提交'), hint: tr('noActivityHint', '先去同步数据，或换一个范围') });
  }

  const positives = days.filter((day) => day.count > 0).map((day) => day.count).sort((left, right) => left - right);
  const first = parseDay(days[0].date);
  const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const weekIndexOf = (date) => Math.floor((parseDay(date).getTime() - gridStart.getTime()) / (7 * 86400000));
  const weeks = Math.max(weekIndexOf(days[days.length - 1].date) + 1, 1);
  const dayOfWeek = (date) => parseDay(date).getDay();

  // 月标签：范围内每个月第一次出现的那天
  const monthLabels = [];
  let lastMonthKey = '';
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (key === lastMonthKey) continue;
    lastMonthKey = key;
    monthLabels.push({ key, label: `${Number(key.slice(5, 7))}月`, weekIndex: weekIndexOf(day.date) });
  }

  return h(
    'div',
    { className: 'dsr-wall' },
    h(
      'div',
      { className: 'dsr-wallScroll' },
      h(
        'div',
        { className: 'dsr-wallCanvas', style: { '--dsr-wall-weeks': String(weeks) } },
        ...monthLabels.map((item) =>
          h('span', { key: item.key, className: 'dsr-wallMonth', style: { gridColumn: `${item.weekIndex + 2} / span 3`, gridRow: '1' } }, item.label),
        ),
        ...[1, 3, 5].map((weekday) => h('span', { key: `wd-${weekday}`, className: 'dsr-wallWeekday', style: { gridColumn: '1', gridRow: String(weekday + 2) } }, weekday === 1 ? '一' : weekday === 3 ? '三' : '五')),
        ...days.map((day) =>
          h('button', {
            key: day.date,
            type: 'button',
            className: `dsr-wallCell level-${saLevel(day.count, positives)}${day.date === activeDay ? ' is-active' : ''}`,
            style: { gridColumn: String(weekIndexOf(day.date) + 2), gridRow: String(dayOfWeek(day.date) + 2) },
            title: `${saFormatDay(day.date)} · ${fmtInt(day.count)} 次提交`,
            'aria-label': `${saFormatDay(day.date)} ${fmtInt(day.count)} 次提交`,
            'aria-pressed': day.date === activeDay,
            onClick: () => onSelectDay && onSelectDay(day.date),
          }),
        ),
      ),
    ),
    h(
      'div',
      { className: 'dsr-wallLegend' },
      h('span', null, tr('less', '少')),
      ...[0, 1, 2, 3, 4].map((level) => h('i', { key: `sw-${level}`, className: `dsr-wallSwatch level-${level}` })),
      h('span', null, tr('legendMore', '多')),
    ),
  );
}

// ---------------------------------------------------------------- 单日提交
/** 点某天后读取并渲染当天提交；date 为空时提示。可选 repoFilter 只保留某个仓库。 */
function DayCommitsPanel(props) {
  const { date, repo, repoFilter, t } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const [page, setPage] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!date) {
      setPage(null);
      setError('');
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    setError('');
    setPage(null);
    const params = new URLSearchParams({ date });
    if (repo) params.set('repo', repo);
    api
      .get(`/reports/day-commits?${params.toString()}`)
      .then((data) => {
        if (alive) setPage(data || null);
      })
      .catch((requestError) => {
        if (alive) setError(saErrText(requestError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [date, repo]);

  if (!date) {
    return h('p', { className: 'dsr-dayNote' }, tr('dayPickHint', '点击贡献墙或日期行，查看当天的提交。'));
  }

  // 选中仓库时排除 merge / cherry-pick，与该仓库「不含合并和拣选」口径一致
  let commits = Array.isArray(page && page.commits) ? page.commits : [];
  if (repo) commits = commits.filter((commit) => !commit.merge && !commit.cherryPick);
  if (repoFilter) commits = commits.filter((commit) => stSplitRepo(commit && commit.repo).displayName === repoFilter);

  const truncated = Boolean(page && page.truncated);
  const total = page && page.total !== undefined ? stNum(page.total) : commits.length;

  const head = h(
    'div',
    { className: 'dsr-dayHead' },
    h('span', { className: 'dsr-dayTitle' }, `${fmtDate(date)} · ${fmtInt(total)} ${tr('commits', '提交')}`),
    repo ? h(Badge, null, repo) : null,
    repoFilter ? h(Badge, null, repoFilter) : null,
    loading ? h(Spinner) : null,
  );

  let body;
  if (loading) {
    body = h('p', { className: 'dsr-dayNote' }, tr('loading', '加载中…'));
  } else if (error) {
    body = h('div', { className: 'dsr-errorBar', role: 'alert' }, `${tr('dayCommitsFailed', '这一天的提交没有读出来')}：${error}`);
  } else if (!commits.length) {
    body = h('p', { className: 'dsr-dayNote' }, repoFilter ? `这一天没有 ${repoFilter} 的提交。` : tr('dayNoCommits', '这一天没有查到提交。'));
  } else {
    body = h(
      'div',
      { className: 'dsr-dayList' },
      ...commits.map((commit, index) =>
        h(
          'div',
          { className: 'dsr-dayItem', key: `${date}-${index}-${commit.commitId || ''}` },
          h('span', { className: 'dsr-dayTime' }, commit.time || '—'),
          h('span', { className: 'dsr-dayId' }, String(commit.commitId || '').slice(0, 8) || '—'),
          h(
            'span',
            { className: 'dsr-daySubject', title: commit.title || '' },
            commit.merge ? h('span', { className: 'dsr-dayTag' }, tr('tagMerge', '合并')) : null,
            commit.cherryPick ? h('span', { className: 'dsr-dayTag' }, tr('tagCherry', '拣选')) : null,
            h('span', { className: 'dsr-daySubjectText' }, commit.title || tr('noTitle', '（没有标题）')),
          ),
          h(
            'span',
            { className: 'dsr-daySide' },
            commit.branch ? h('span', { className: 'dsr-dayBranch', title: commit.branch }, commit.branch) : null,
            !repo && commit.repo ? h('span', { className: 'dsr-dayBranch', title: commit.repo }, stSplitRepo(commit.repo).displayName) : null,
            h('span', { className: 'dsr-add' }, `+${fmtInt(commit.additions)}`),
            h('span', { className: 'dsr-del' }, `-${fmtInt(commit.deletions)}`),
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    { className: 'dsr-dayPanel' },
    head,
    body,
    truncated ? h('p', { className: 'dsr-dayNote' }, tr('dayTruncated', '这一天提交比较多，先显示前 200 条。')) : null,
  );
}

// ---------------------------------------------------------------- 左栏（aside）
/** 统计区左栏：搜索仓库 + 「全部仓库」+ 仓库目录树。props: { t, state, actions } */
function StatsAside(props) {
  const { t } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const stats = useStatsState();
  const derived = saStatsDerived(stats.analytics);
  const filtered = saFilterTree(derived.tree, stats.repoQuery);
  const hasData = Boolean(stats.analytics);

  return h(
    'div',
    { className: 'dsr-stt-aside' },
    h(Input, {
      value: stats.repoQuery,
      placeholder: tr('searchRepo', '搜索仓库'),
      onChange: (event) => saSet({ repoQuery: event.target.value }),
      spellCheck: false,
    }),
    h(
      'button',
      {
        type: 'button',
        className: `dsr-stt-allRepos${stats.repoKey ? '' : ' is-active'}`,
        'aria-pressed': !stats.repoKey,
        onClick: () => saSelectRepo(''),
      },
      h('span', null, tr('allRepos', '全部仓库')),
      h('span', { className: 'dsr-stt-count' }, fmtInt(stNum(derived.summary.totalCommits))),
    ),
    hasData
      ? derived.repos.length
        ? h(StatsRepoTree, {
            nodes: filtered,
            activeKey: stats.repoKey,
            onSelect: saSelectRepo,
            depth: 0,
            forceOpen: Boolean(stats.repoQuery.trim()),
            t,
          })
        : h('p', { className: 'dsr-stt-asideEmpty' }, tr('noRepos', '这段时间还没有仓库数据'))
      : h('p', { className: 'dsr-stt-asideEmpty' }, stats.loading ? tr('loading', '加载中…') : tr('repoTreeEmpty', '同步提交后这里会出现仓库')),
    hasData && stats.repoQuery.trim() && !filtered.length ? h('p', { className: 'dsr-stt-asideEmpty' }, tr('noRepoMatch', '没有匹配的仓库')) : null,
  );
}

// ---------------------------------------------------------------- 主区（main）
/** 提交记录里的一天：日期 + 次数 + 仓库 chip；展开后内嵌 DayCommitsPanel。 */
function saRenderDayRow(day, stats, t, tr, selectedRepo) {
  const open = stats.openDay === day.date;
  const allChips = open || stats.expandedChips[day.date] ? day.repos : day.repos.slice(0, 3);
  const hidden = Math.max(day.repos.length - allChips.length, 0);
  return h(
    'div',
    { className: `dsr-stt-day${open ? ' is-open' : ''}`, key: day.date },
    h(
      'div',
      { className: 'dsr-stt-dayRow' },
      h(
        'button',
        {
          type: 'button',
          className: 'dsr-stt-dayBtn',
          'aria-expanded': open,
          title: open ? tr('dayCollapse', '收起这一天的提交') : tr('dayExpand', '查看这一天的提交'),
          onClick: () => saToggleDay(day.date),
        },
        h('span', { className: 'dsr-stt-dayDate' }, saDayLabel(day.date)),
        h('span', { className: 'dsr-stt-dayCount' }, `${fmtInt(day.count)} 次`),
      ),
      day.repos.length
        ? h(
            'span',
            { className: 'dsr-stt-chips' },
            ...allChips.map((name) =>
              h(
                'button',
                {
                  key: name,
                  type: 'button',
                  className: `dsr-stt-chip${open && stats.dayRepo === name ? ' is-active' : ''}`,
                  'aria-pressed': open && stats.dayRepo === name,
                  title: open && stats.dayRepo === name ? `取消只看 ${name}` : `只看 ${name}`,
                  onClick: (event) => {
                    event.stopPropagation();
                    saPickDayRepo(day.date, name);
                  },
                },
                name,
              ),
            ),
            hidden > 0
              ? h(
                  'button',
                  {
                    key: 'more',
                    type: 'button',
                    className: 'dsr-stt-chip is-more',
                    title: day.repos.slice(allChips.length).join('、'),
                    onClick: (event) => {
                      event.stopPropagation();
                      saSet({ expandedChips: { ...stats.expandedChips, [day.date]: true } });
                    },
                  },
                  `+${hidden}`,
                )
              : null,
          )
        : null,
    ),
    open
      ? h(
          'div',
          { className: 'dsr-stt-dayDetail' },
          h(DayCommitsPanel, { date: day.date, repo: selectedRepo ? selectedRepo.repoKey : '', repoFilter: stats.dayRepo, t }),
        )
      : null,
  );
}

/** 统计区主区：整页统计（工具条 → 贡献墙 → 摘要 → 分支条 → 提交记录）+ 同步对话框。 */
function StatsMain(props) {
  const { t, state, actions } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const stats = useStatsState();
  const derived = saStatsDerived(stats.analytics);
  const selectedRepo = derived.repos.find((repo) => repo.repoKey === stats.repoKey) || null;

  // 首次进入拉一次（已有数据则不重复）
  React.useEffect(() => {
    if ((!saStats.analytics && !saStats.loading && !saStats.error) || saStats.staleAfterSync) saLoadAnalytics(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const days = selectedRepo ? selectedRepo.contributionDays : saAllDays(stats.analytics);
  const months = saActivityMonths(days, selectedRepo ? [] : saRepoDays(derived.cards));

  // 换范围/仓库后默认展开最近一个月（只执行一次，用户全收起后不再自动展开）
  const initKey = `${stats.appliedStart}|${stats.appliedEnd}|${stats.repoKey}|${months.length}`;
  React.useEffect(() => {
    if (stats.monthsInitFor === initKey) return;
    saSet({ openMonths: months.length ? { [months[0].key]: true } : {}, monthsInitFor: initKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey, months.length]);

  const pending = stats.draftStart !== stats.appliedStart || stats.draftEnd !== stats.appliedEnd;
  const summary = derived.summary;
  const numbers = selectedRepo
    ? { commits: selectedRepo.commitCount, repos: null, additions: selectedRepo.additions, deletions: selectedRepo.deletions }
    : { commits: stNum(summary.totalCommits), repos: stNum(summary.repoCount), additions: stNum(summary.additions), deletions: stNum(summary.deletions) };

  const earliest = saEarliestDay(days);
  const coverageHint = earliest && stats.appliedStart && stats.appliedStart < earliest
    ? `有些日子还没同步，这里只统计本地已有的提交（本地最早 ${fmtDate(earliest)}）。`
    : '';

  const branchRows = (() => {
    if (!selectedRepo) return [];
    const raw = Array.isArray(stats.analytics && stats.analytics.repoBranchStats) ? stats.analytics.repoBranchStats : [];
    const fromAnalytics = raw
      .filter((row) => stText(row && (row.repoKey || row.repo_key)) === selectedRepo.repoKey)
      .map((row) => ({
        branchName: stText(row && (row.branchName || row.branch_name)) || '未归属分支',
        commitCount: stNum(row && (row.commitCount !== undefined ? row.commitCount : row.commit_count)),
        additions: stNum(row && row.additions),
        deletions: stNum(row && row.deletions),
      }));
    const rows = fromAnalytics.length ? fromAnalytics : selectedRepo.branches.slice();
    rows.sort((left, right) => right.commitCount - left.commitCount);
    const top = rows.slice(0, 8);
    const max = Math.max(...top.map((row) => row.commitCount), 1);
    return top.map((row) => ({ ...row, width: Math.max(Math.round((row.commitCount / max) * 100), 2) }));
  })();

  const busiestMonth = Math.max(...months.map((month) => month.count), 1);

  const onGenerate = () => {
    const type = saInferReportType(stats.appliedStart, stats.appliedEnd);
    const preset = { type, startDate: stats.appliedStart, endDate: stats.appliedEnd };
    if (typeof actions.setArea === 'function') actions.setArea('reports');
    // ReportRail 挂载后再打开对话框（dialog host 在报告页）
    window.setTimeout(() => {
      if (typeof rpOpenGenerateDialog === 'function') rpOpenGenerateDialog(preset);
    }, 30);
  };

  const toolbar = h(
    'div',
    { className: 'dsr-stt-tools' },
    h(
      'div',
      { className: 'dsr-stt-ranges', role: 'group', 'aria-label': tr('range', '范围') },
      ...SA_QUICK_RANGES.map((item) =>
        h(
          'button',
          {
            key: item.kind,
            type: 'button',
            className: `dsr-stt-range${stats.appliedKind === item.kind ? ' is-active' : ''}`,
            'aria-pressed': stats.appliedKind === item.kind,
            onClick: () => saSetQuickRange(item.kind),
          },
          tr(`range_${item.kind}`, item.label),
        ),
      ),
    ),
    h(
      'div',
      { className: 'dsr-stt-dates' },
      h('input', {
        type: 'date',
        className: 'dsr-stt-date',
        value: stats.draftStart,
        'aria-label': tr('startDate', '开始日期'),
        onChange: (event) => saSetDraft('start', event.target.value),
      }),
      h('span', { className: 'dsr-stt-dateSep' }, '→'),
      h('input', {
        type: 'date',
        className: 'dsr-stt-date',
        value: stats.draftEnd,
        'aria-label': tr('endDate', '结束日期'),
        onChange: (event) => saSetDraft('end', event.target.value),
      }),
    ),
    h(Button, { variant: pending ? 'primary' : 'default', onClick: saApplyRange, disabled: !stats.draftStart || !stats.draftEnd }, stats.loading ? tr('loading', '加载中…') : tr('query', '查询')),
    h(Button, { onClick: () => saSet({ syncOpen: true }) }, tr('syncData', '同步数据')),
    h(
      'span',
      { className: 'dsr-stt-genWrap', title: pending ? tr('genHintPending', '先点「查询」应用当前范围') : '' },
      h(Button, { variant: 'primary', onClick: onGenerate, disabled: pending || !stats.appliedStart }, tr('generate', '生成报告')),
    ),
  );

  const titleBlock = h(
    'div',
    { className: 'dsr-stt-title' },
    h(
      'div',
      { className: 'dsr-stt-titleCopy' },
      h('h1', { className: 'dsr-stt-name' }, selectedRepo ? selectedRepo.displayName : tr('allRepos', '全部仓库')),
      selectedRepo && selectedRepo.namespace ? h('p', { className: 'dsr-stt-path' }, selectedRepo.namespace) : null,
      h('p', { className: 'dsr-stt-rule' }, tr('ruleExcludeMerge', '不含合并和拣选')),
    ),
    toolbar,
  );

  const wallBlock = h(
    'div',
    { className: 'dsr-stt-wall' },
    h(ContributionWall, { months, activeDay: stats.openDay, onSelectDay: saToggleDay, t, startDate: stats.appliedStart, endDate: stats.appliedEnd }),
    coverageHint ? h('p', { className: 'dsr-stt-note' }, coverageHint) : null,
  );

  const summaryBlock = h(
    'div',
    { className: 'dsr-stt-summary', 'aria-label': tr('summary', '摘要') },
    h(
      'p',
      { className: 'dsr-stt-figure' },
      h('strong', null, fmtInt(numbers.commits)),
      h('span', null, stats.appliedKind === 'last12' ? tr('thisYearCommits', '这一年提交') : tr('commits', '提交')),
    ),
    numbers.repos === null
      ? null
      : h('p', { className: 'dsr-stt-figure' }, h('strong', null, fmtInt(numbers.repos)), h('span', null, tr('reposCount', '个仓库'))),
    h(
      'p',
      { className: 'dsr-stt-figure' },
      h('span', { className: 'dsr-stt-add' }, `+${fmtInt(numbers.additions)}`),
      h('span', { className: 'dsr-stt-del' }, `-${fmtInt(numbers.deletions)}`),
    ),
  );

  const branchBlock = branchRows.length
    ? h(
        'div',
        { className: 'dsr-stt-branches', 'aria-label': tr('branches', '分支') },
        ...branchRows.map((row) =>
          h(
            'div',
            { className: 'dsr-stt-branch', key: row.branchName },
            h('span', { className: 'dsr-stt-branchName', title: row.branchName }, row.branchName),
            h('span', { className: 'dsr-stt-branchTrack' }, h('span', { className: 'dsr-stt-branchFill', style: { width: `${row.width}%` } })),
            h('span', { className: 'dsr-stt-branchMeta' }, `${fmtInt(row.commitCount)} 次 · +${fmtInt(row.additions)} / -${fmtInt(row.deletions)}`),
          ),
        ),
      )
    : null;

  const activityBlock = months.length
    ? h(
        'section',
        { className: 'dsr-stt-activity', 'aria-label': tr('commitLog', '提交记录') },
        h('h2', { className: 'dsr-stt-activityTitle' }, tr('commitLog', '提交记录')),
        ...months.map((month) => {
          const open = Boolean(stats.openMonths[month.key]);
          return h(
            'article',
            { className: 'dsr-stt-month', key: month.key },
            h(
              'button',
              { type: 'button', className: 'dsr-stt-monthRow', 'aria-expanded': open, onClick: () => saToggleMonth(month.key) },
              h(
                'span',
                { className: 'dsr-stt-monthChevron' },
                h('span', { style: { display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(ChevronGlyph, { size: 11 })),
              ),
              h('span', { className: 'dsr-stt-monthLabel' }, month.label),
              h('span', { className: 'dsr-stt-monthBar' }, h('span', { className: 'dsr-stt-monthBarFill', style: { width: `${Math.max(Math.round((month.count / busiestMonth) * 100), 2)}%` } })),
              h('span', { className: 'dsr-stt-monthCount' }, `${fmtInt(month.count)} 次`),
            ),
            open ? h('div', { className: 'dsr-stt-days' }, ...month.days.map((day) => saRenderDayRow(day, stats, t, tr, selectedRepo))) : null,
          );
        }),
      )
    : null;

  const syncDialog = stats.syncOpen
    ? h(
        Dialog,
        {
          title: tr('syncTitle', '同步 GitLab 数据'),
          width: '900px',
          onClose: () => saSet({ syncOpen: false }),
          footer: h('div', { className: 'dsr-btnRow' }, h(Button, { onClick: () => saSet({ syncOpen: false }) }, tr('close', '关闭'))),
        },
        h(
          'div',
          { className: 'dsr-stt-syncBody' },
          h('p', { className: 'dsr-stt-note' }, tr('syncDialogHint', '窗口默认等于当前统计范围；仓库范围在 设置 → 报告与统计 → 同步仓库范围 维护。')),
          typeof SyncPage === 'function'
            ? h(SyncPage, {
                t,
                state,
                actions,
                embedded: true,
                initialStartDate: stats.appliedStart,
                initialEndDate: stats.appliedEnd,
              })
            : h(EmptyState, { title: tr('syncPageMissing', '同步页面未加载') }),
        ),
      )
    : null;

  let statusBlock = null;
  if (stats.error) {
    statusBlock = h(
      'div',
      { className: 'dsr-stt-error', role: 'alert' },
      h('span', null, stats.error),
      h('div', { className: 'dsr-btnRow' }, h(Button, { onClick: () => saLoadAnalytics(true) }, tr('retry', '重试'))),
    );
  } else if (stats.loading && !stats.analytics) {
    statusBlock = h('div', { className: 'dsr-empty' }, h(Spinner), h('div', null, tr('loading', '加载中…')));
  } else if (stats.analytics && numbers.commits <= 0 && !selectedRepo) {
    statusBlock = h(
      'div',
      { className: 'dsr-stt-empty' },
      h(EmptyState, { title: tr('emptyRange', '该范围内没有本地提交'), hint: tr('emptyRangeHint', '先去同步数据，或换一个范围') }),
      h('div', { className: 'dsr-btnRow' }, h(Button, { variant: 'primary', onClick: () => saSet({ syncOpen: true }) }, tr('syncData', '同步数据'))),
    );
  }

  return h(
    'div',
    { className: 'dsr-stt-main' },
    h(
      'div',
      { className: 'dsr-stt-page' },
      titleBlock,
      statusBlock || h('div', { style: { display: 'contents' } }, wallBlock, summaryBlock, branchBlock, activityBlock),
    ),
    syncDialog,
  );
}

// ---------------------------------------------------------------- 复用组件样式（仓库树 / 贡献墙 / 单日提交）
// 说明：这些类沿用上一版命名（非本轮新增），因此放在文件的第二个 addClientCSS 里回溯补齐；
// 贡献墙按 UI-PLAN §2 保留 GitHub 数据色（图表允许自有色），暗色下用深色变体。
addClientCSS(`
.dsr-repoTree { min-width: 0; }
.dsr-repoTreeRow {
  display: flex; align-items: center; gap: 6px; box-sizing: border-box; width: 100%; height: 30px;
  padding-right: 8px; border: 0; border-radius: 8px; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.dsr-repoTreeRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-repoTreeRow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsr-repoTreeRepo.is-active {
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary);
}
.dsr-repoTreeChevron { display: inline-grid; place-items: center; width: 12px; flex: none; color: var(--dsw-alias-label-secondary); }
.dsr-repoTreeName { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsr-repoTreeFolder .dsr-repoTreeName { font-weight: 600; }
.dsr-repoTreeCount { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.dsr-wall { display: flex; flex-direction: column; gap: 10px; }
.dsr-wallMonths { display: grid; grid-template-columns: repeat(auto-fill, minmax(122px, 1fr)); gap: 10px; }
.dsr-wallMonth { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsr-wallMonthHead { display: flex; align-items: baseline; gap: 5px; font-size: 11px; }
.dsr-wallMonthLabel { color: var(--dsw-alias-label-secondary); }
.dsr-wallMonthCount { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsr-wallGrid { display: grid; gap: 2px; justify-content: start; }
.dsr-wallCell {
  width: var(--dsr-wall-cell, 12px); height: var(--dsr-wall-cell, 12px); padding: 0;
  border: 0; border-radius: 2px; cursor: pointer;
  background: color-mix(in srgb, #ebedf0 60%, transparent);
}
.dsr-wallCell:hover { outline: 1px solid var(--dsw-alias-label-secondary); outline-offset: 1px; }
.dsr-wallCell:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-wallCell.level-1 { background: #9be9a8; }
.dsr-wallCell.level-2 { background: #40c463; }
.dsr-wallCell.level-3 { background: #30a14e; }
.dsr-wallCell.level-4 { background: #216e39; }
.dsr-wallCell.is-active { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 1px; }
.dsr-wallLegend { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dsr-wallSwatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: color-mix(in srgb, #ebedf0 60%, transparent); }
.dsr-wallSwatch.level-1 { background: #9be9a8; }
.dsr-wallSwatch.level-2 { background: #40c463; }
.dsr-wallSwatch.level-3 { background: #30a14e; }
.dsr-wallSwatch.level-4 { background: #216e39; }
@media (prefers-color-scheme: dark) {
  .dsr-wallCell, .dsr-wallSwatch { background: #21262d; }
  .dsr-wallCell.level-1, .dsr-wallSwatch.level-1 { background: #0e4429; }
  .dsr-wallCell.level-2, .dsr-wallSwatch.level-2 { background: #006d32; }
  .dsr-wallCell.level-3, .dsr-wallSwatch.level-3 { background: #26a641; }
  .dsr-wallCell.level-4, .dsr-wallSwatch.level-4 { background: #39d353; }
}

.dsr-dayPanel { display: flex; flex-direction: column; gap: 8px; }
.dsr-dayHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-dayTitle { font-size: 12.5px; font-weight: 600; }
.dsr-dayList { display: flex; flex-direction: column; }
.dsr-dayItem {
  display: grid; grid-template-columns: 46px 66px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px;
}
.dsr-dayItem:last-child { border-bottom: 0; }
.dsr-dayTime { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-size: 11.5px; }
.dsr-dayId { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsr-daySubject { min-width: 0; display: flex; align-items: center; gap: 6px; }
.dsr-daySubjectText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-dayTag {
  flex: none; padding: 0 5px; height: 16px; line-height: 16px; border-radius: 4px; font-size: 10px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
}
.dsr-daySide { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; white-space: nowrap; }
.dsr-dayBranch { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.dsr-dayNote { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.6; margin: 0; }
`);
