// ---------------------------------------------------------------- 报告主区：tab strip + 详情头（重生成 / 更多）+ 正文/统计 tab
// 对齐 workbench 最新 ReportsView：顶部 38px tab strip、一行 meta + 操作、正文 3 KPI + 错误 alert + Markdown、
// 统计 tab（scope header / 6 KPI / 三张摘要卡 / topics / repo breakdown / 趋势柱状）。

addClientCSS(`
.dsr-rpt-main { display: flex; flex-direction: column; min-height: 100%; box-sizing: border-box; }
.dsr-rpt-main button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsr-rpt-tabStrip {
  position: sticky; top: 0; z-index: 6; flex: none;
  display: flex; align-items: stretch; height: 38px; padding: 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dsr-rpt-tab {
  display: inline-flex; align-items: center; gap: 8px; height: 100%; max-width: 340px;
  padding: 0 8px 0 12px; color: var(--dsw-alias-label-primary); font-size: 12.5px;
}
.dsr-rpt-tab.active { box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); font-weight: 600; }
.dsr-rpt-tabPeriod {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary);
}
.dsr-rpt-tabClose {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsr-rpt-tabClose:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsr-rpt-tabClose:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-rpt-content {
  flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px;
  padding: 16px 22px 40px; box-sizing: border-box;
}
.dsr-rpt-empty { flex: 1; display: grid; place-items: center; padding: 40px; box-sizing: border-box; }
.dsr-rpt-emptyActions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.dsr-rpt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.dsr-rpt-meta {
  margin: 0; padding-top: 5px; max-width: 720px;
  color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.6;
  font-variant-numeric: tabular-nums;
}
.dsr-rpt-headActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-rpt-moreWrap { position: relative; display: inline-flex; }
.dsr-rpt-menuMask { position: fixed; inset: 0; z-index: 20; }
.dsr-rpt-menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 21; min-width: 172px;
  padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 12px 32px rgba(0, 0, 0, .24);
}
.dsr-rpt-menuItem {
  display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
}
.dsr-rpt-menuItem:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-rpt-menuItem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsr-rpt-menuItem.danger { color: var(--dsw-alias-state-error-primary); }
.dsr-rpt-menuSep { height: 1px; margin: 4px 0; background: var(--dsw-alias-border-l1); }
.dsr-rpt-tabs { margin: 0; }
.dsr-rpt-pane { display: flex; flex-direction: column; gap: 14px; }
.dsr-rpt-kpiRow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dsr-rpt-kpiGrid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 1100px) { .dsr-rpt-kpiGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .dsr-rpt-kpiGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dsr-rpt-kpiRow { grid-template-columns: minmax(0, 1fr); }
}
.dsr-rpt-kpi {
  min-width: 0; min-height: 72px; padding: 12px 14px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1); border-top: 2px solid var(--dsw-alias-border-l2);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
}
.dsr-rpt-kpi.accent { border-top-color: var(--dsw-alias-brand-primary); }
.dsr-rpt-kpiLabel {
  display: flex; align-items: center; gap: 5px;
  color: var(--dsw-alias-label-secondary); font-size: 11.5px;
}
.dsr-rpt-kpiValue {
  margin-top: 6px; color: var(--dsw-alias-label-primary);
  font-size: 22px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums;
}
.dsr-rpt-alert {
  margin: 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; line-height: 1.55;
  color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, var(--dsw-alias-bg-layer-1));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1));
  border-left: 3px solid var(--dsw-alias-state-error-primary);
}
.dsr-rpt-md { max-width: 820px; }
.dsr-rpt-md .dsr-md h1:first-child { display: none; }
.dsr-rpt-stats { display: flex; flex-direction: column; gap: 16px; }
.dsr-rpt-scope { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.dsr-rpt-scopeActions { display: flex; align-items: center; gap: 8px; }
.dsr-rpt-scopeRange {
  margin: 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.dsr-rpt-scopeMeta {
  margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 6px 12px;
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.dsr-rpt-summaryGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.dsr-rpt-card {
  min-width: 0; padding: 14px 16px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
}
.dsr-rpt-cardTitle { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.dsr-rpt-metricList { display: flex; flex-direction: column; gap: 8px; }
.dsr-rpt-metricRow { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsr-rpt-metricRow strong { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsr-rpt-section { display: flex; flex-direction: column; gap: 10px; }
.dsr-rpt-sectionTitle { margin: 0; font-size: 15px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.dsr-rpt-sectionHead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsr-rpt-sectionHint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.dsr-rpt-topics { display: flex; flex-direction: column; gap: 10px; }
.dsr-rpt-topic {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1);
}
.dsr-rpt-topicHead {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600;
}
.dsr-rpt-topicSummary {
  margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.dsr-rpt-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dsr-rpt-table th, .dsr-rpt-table td {
  padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  text-align: left; vertical-align: middle;
}
.dsr-rpt-table thead th { color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 11.5px; }
.dsr-rpt-num { text-align: right !important; font-variant-numeric: tabular-nums; }
.dsr-rpt-add { color: var(--dsw-alias-state-success-primary); }
.dsr-rpt-del { color: var(--dsw-alias-state-error-primary); }
.dsr-rpt-repoBtn {
  display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left;
}
.dsr-rpt-repoBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsr-rpt-repoNs { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsr-rpt-chev { display: inline-flex; flex: none; transition: transform .12s ease; }
.dsr-rpt-chev.open { transform: rotate(90deg); }
.dsr-rpt-branchRow td {
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent);
}
.dsr-rpt-branchCell { padding-left: 26px !important; }
.dsr-rpt-trendWrap {
  padding: 12px 14px 6px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
}
.dsr-rpt-trendSvg { display: block; width: 100%; height: auto; }
.dsr-rpt-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 60px 20px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; text-align: center;
}
.dsr-rpt-error { color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
`);

// ---------------------------------------------------------------- 数据提取（兼容 camelCase / snake_case，优先 detail 快照）

function rpPick(row, keys) {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function rpNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rpIncludeMerge(row) {
  return Boolean(row && (row.includeMerge === true || row.includeMerge === 1 || row.include_merge === true || row.include_merge === 1));
}

function rpLineRows(stats) {
  const rows = Array.isArray(stats && stats.lineStats) ? stats.lineStats : [];
  return rows.map((row) => ({
    includeMerge: rpIncludeMerge(row),
    additions: rpNum(rpPick(row, ['additions'])),
    deletions: rpNum(rpPick(row, ['deletions'])),
    total: rpNum(rpPick(row, ['total'])),
    pureAdditions: rpNum(rpPick(row, ['pureAdditions', 'pure_additions'])),
  }));
}

function rpPreferredLine(stats, detail) {
  const rows = rpLineRows(stats);
  const preferred = rows.find((row) => !row.includeMerge) || rows[0] || null;
  if (preferred) return { ...preferred, net: preferred.additions - preferred.deletions, source: 'lineStats' };
  const additions = rpNum(rpPick(detail, ['totalAdditions', 'total_additions']));
  const deletions = rpNum(rpPick(detail, ['totalDeletions', 'total_deletions']));
  const explicitNet = rpPick(detail, ['totalLines', 'total_lines']);
  return {
    includeMerge: false,
    additions,
    deletions,
    total: additions + deletions,
    pureAdditions: 0,
    net: explicitNet === undefined ? additions - deletions : rpNum(explicitNet),
    source: 'detail',
  };
}

function rpSplitRepo(repoKey) {
  const path = String(repoKey || '').trim();
  const index = path.lastIndexOf('/');
  if (index <= 0) return { displayName: path || '未归属仓库', namespace: '' };
  return { displayName: path.slice(index + 1), namespace: path.slice(0, index) };
}

function rpRepoRows(stats) {
  const raw = Array.isArray(stats && stats.repoBranchStats) ? stats.repoBranchStats : [];
  const groups = new Map();
  for (const row of raw) {
    if (!row || rpIncludeMerge(row)) continue;
    const commits = rpNum(rpPick(row, ['commitCount', 'commit_count']));
    if (commits <= 0) continue;
    const repoKey = String(rpPick(row, ['repoKey', 'repo_key']) || '未归属仓库');
    const branchName = String(rpPick(row, ['branchName', 'branch_name']) || '未归属 refs');
    const additions = rpNum(rpPick(row, ['additions']));
    const deletions = rpNum(rpPick(row, ['deletions']));
    const total = rpNum(rpPick(row, ['total']));
    let group = groups.get(repoKey);
    if (!group) {
      const names = rpSplitRepo(repoKey);
      group = {
        repoKey,
        displayName: names.displayName,
        namespace: names.namespace,
        commitCount: 0,
        additions: 0,
        deletions: 0,
        total: 0,
        branches: [],
      };
      groups.set(repoKey, group);
    }
    group.commitCount += commits;
    group.additions += additions;
    group.deletions += deletions;
    group.total += total;
    group.branches.push({
      branchName,
      commitCount: commits,
      additions,
      deletions,
      total,
      net: additions - deletions,
    });
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      net: group.additions - group.deletions,
      branches: [...group.branches].sort((left, right) => right.total - left.total || right.commitCount - left.commitCount),
    }))
    .sort((left, right) => right.total - left.total || right.commitCount - left.commitCount);
}

function rpBranchCount(stats, detail, repoRows) {
  const count = repoRows.reduce((total, row) => total + row.branches.length, 0);
  if (count) return count;
  return Array.isArray(detail && detail.branchDistribution) ? detail.branchDistribution.length : 0;
}

function rpDomainRows(source) {
  const items = Array.isArray(source && source.domainDistribution) ? source.domainDistribution : [];
  const rows = items.map((item, index) => {
    const row = item || {};
    return {
      key: `${index}-${String(row.name || '')}`,
      name: String(row.name || '未分类'),
      count: rpNum(row.count),
    };
  });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.map((row) => ({ ...row, share: total ? Math.round((row.count / total) * 100) : 0 }));
}

function rpTopicRows(detail) {
  const list = Array.isArray(detail && detail.topics) ? detail.topics : [];
  return list
    .map((item, index) => {
      const row = item || {};
      const domain = String(rpPick(row, ['domain']) || '');
      const title = String(rpPick(row, ['topicTitle', 'topic_title', 'title']) || '');
      return {
        key: `${index}-${domain}-${title}`,
        domain,
        title: title || domain || String(index + 1),
        summary: String(rpPick(row, ['summary']) || ''),
      };
    })
    .filter((row) => row.title || row.summary);
}

function rpTrendBars(detail) {
  const items = Array.isArray(detail && detail.dateDistribution) ? detail.dateDistribution : [];
  return items
    .map((item) => {
      const row = item || {};
      return { date: String(row.date || '').slice(0, 10), count: rpNum(row.count) };
    })
    .filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(bar.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function rpTotals(detail, stats) {
  const snapshot = (stats && stats.stats) || {};
  const merged = detail || snapshot || {};
  const line = rpPreferredLine(stats, merged);
  const repoRows = rpRepoRows(stats);
  const domainRows = rpDomainRows(merged);
  return {
    commits: rpNum(rpPick(merged, ['totalCommits', 'total_commits'])),
    repos: rpNum(rpPick(merged, ['repoCount', 'repo_count'])),
    branches: rpBranchCount(stats, merged, repoRows),
    merge: rpNum(rpPick(merged, ['mergeCommitCount', 'merge_commit_count'])),
    cherry: rpNum(rpPick(merged, ['cherryPickCommitCount', 'cherry_pick_commit_count'])),
    net: rpNum(rpPick(merged, ['totalLines', 'total_lines'])),
    line,
    repoRows,
    domainRows,
  };
}

// ---------------------------------------------------------------- 展示小件

function rpKpiCard(t, label, value, accent) {
  return h(
    'div',
    { className: `dsr-rpt-kpi${accent ? ' accent' : ''}` },
    h('div', { className: 'dsr-rpt-kpiLabel' }, label),
    h('div', { className: 'dsr-rpt-kpiValue' }, value),
  );
}

function rpMetricRow(label, value) {
  return h(
    'div',
    { className: 'dsr-rpt-metricRow' },
    h('span', null, label),
    h('strong', null, value),
  );
}

function rpSummaryCard(t, title, children) {
  return h(
    'section',
    { className: 'dsr-rpt-card' },
    h('h3', { className: 'dsr-rpt-cardTitle' }, title),
    children,
  );
}

function rpTrendChart(t, bars) {
  const width = 900;
  const height = 200;
  const left = 40;
  const right = 12;
  const top = 16;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  const gap = plotWidth / bars.length;
  const barWidth = Math.max(2, Math.min(24, gap * 0.62));
  const yTicks = [0, 1, 2, 3].map((index) => ({
    key: `y-${index}`,
    y: top + (index * plotHeight) / 3,
    label: String(Math.round(max - (max * index) / 3)),
  }));
  const xCount = Math.min(6, bars.length);
  const xTicks = Array.from({ length: xCount }, (_, index) => {
    const position = Math.round((index * (bars.length - 1)) / Math.max(xCount - 1, 1));
    return { key: `x-${position}`, x: left + gap * position + gap / 2, label: bars[position].date.slice(5) };
  });
  return h(
    'div',
    { className: 'dsr-rpt-trendWrap' },
    h(
      'svg',
      {
        className: 'dsr-rpt-trendSvg',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': tx(t, 'trendTitle', '趋势'),
      },
      ...yTicks.map((tick) =>
        h(
          'g',
          { key: tick.key },
          h('line', {
            x1: left,
            x2: width - right,
            y1: tick.y,
            y2: tick.y,
            stroke: 'currentColor',
            strokeOpacity: 0.12,
            strokeWidth: 1,
          }),
          h(
            'text',
            { x: left - 8, y: tick.y + 4, textAnchor: 'end', fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 },
            tick.label,
          ),
        ),
      ),
      ...bars.map((bar, index) => {
        const barHeight = Math.max(1, (bar.count / max) * plotHeight);
        return h(
          'rect',
          {
            key: `bar-${bar.date}-${index}`,
            x: left + gap * index + (gap - barWidth) / 2,
            y: top + plotHeight - barHeight,
            width: barWidth,
            height: barHeight,
            rx: 2,
            style: { fill: 'var(--dsw-alias-brand-primary)', opacity: 0.62 },
          },
          h('title', null, `${bar.date} · ${fmtInt(bar.count)} ${tx(t, 'commits', '提交')}`),
        );
      }),
      h('line', {
        x1: left,
        x2: width - right,
        y1: top + plotHeight,
        y2: top + plotHeight,
        stroke: 'currentColor',
        strokeOpacity: 0.28,
        strokeWidth: 1,
      }),
      ...xTicks.map((tick) =>
        h(
          'text',
          { key: tick.key, x: tick.x, y: top + plotHeight + 15, textAnchor: 'middle', fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 },
          tick.label,
        ),
      ),
    ),
  );
}

function rpRepoTable(t, rows, open, onToggle) {
  const header = h(
    'tr',
    null,
    h('th', null, tx(t, 'repos', '仓库')),
    h('th', { className: 'dsr-rpt-num' }, tx(t, 'commits', '提交')),
    h('th', { className: 'dsr-rpt-num' }, tx(t, 'additions', '新增')),
    h('th', { className: 'dsr-rpt-num' }, tx(t, 'deletions', '删除')),
    h('th', { className: 'dsr-rpt-num' }, tx(t, 'totalChange', '总变更')),
    h('th', { className: 'dsr-rpt-num' }, tx(t, 'netLines', '净变更')),
  );
  return h(
    'table',
    { className: 'dsr-rpt-table' },
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
                {
                  type: 'button',
                  className: 'dsr-rpt-repoBtn',
                  'aria-expanded': isOpen ? 'true' : 'false',
                  onClick: () => onToggle(row.repoKey),
                },
                h('span', { className: `dsr-rpt-chev${isOpen ? ' open' : ''}` }, h(ChevronGlyph, { size: 11 })),
                h('span', null, row.displayName),
                row.namespace ? h('span', { className: 'dsr-rpt-repoNs' }, row.namespace) : null,
                h(Badge, null, String(row.branches.length)),
              ),
            ),
            h('td', { className: 'dsr-rpt-num' }, fmtInt(row.commitCount)),
            h('td', { className: 'dsr-rpt-num dsr-rpt-add' }, `+${fmtInt(row.additions)}`),
            h('td', { className: 'dsr-rpt-num dsr-rpt-del' }, `-${fmtInt(row.deletions)}`),
            h('td', { className: 'dsr-rpt-num' }, fmtInt(row.total)),
            h('td', { className: 'dsr-rpt-num' }, fmtInt(row.net)),
          ),
        ];
        if (isOpen) {
          for (const branch of row.branches) {
            nodes.push(
              h(
                'tr',
                { key: `${row.repoKey}::${branch.branchName}`, className: 'dsr-rpt-branchRow' },
                h('td', { className: 'dsr-rpt-branchCell' }, branch.branchName),
                h('td', { className: 'dsr-rpt-num' }, fmtInt(branch.commitCount)),
                h('td', { className: 'dsr-rpt-num dsr-rpt-add' }, `+${fmtInt(branch.additions)}`),
                h('td', { className: 'dsr-rpt-num dsr-rpt-del' }, `-${fmtInt(branch.deletions)}`),
                h('td', { className: 'dsr-rpt-num' }, fmtInt(branch.total)),
                h('td', { className: 'dsr-rpt-num' }, fmtInt(branch.net)),
              ),
            );
          }
        }
        return nodes;
      }),
    ),
  );
}

// ---------------------------------------------------------------- 编辑模板对话框
/** 报告详情「更多 → 编辑模板」：直接读写 /templates，不再跳到设置页。 */
function TemplateEditDialog({ t, type, onClose }) {
  const [tab, setTab] = React.useState(type || 'week');
  const [data, setData] = React.useState(null);
  const [draft, setDraft] = React.useState({ template: '', guidance: '' });
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    api
      .get('/templates')
      .then((res) => {
        if (alive) setData(res || {});
      })
      .catch((failure) => {
        if (alive) setError(String((failure && failure.message) || failure));
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    const templates = (data && data.templates) || {};
    const guidance = (data && data.guidance) || {};
    setDraft({ template: templates[tab] || '', guidance: guidance[tab] || '' });
  }, [tab, data]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await api.put('/templates', {
        templates: { [tab]: draft.template },
        guidance: { [tab]: draft.guidance },
      });
      if (typeof actions.loadTemplates === 'function') await actions.loadTemplates();
      showToast('ok', tx(t, 'saved', '已保存'));
      onClose();
    } catch (failure) {
      setError(String((failure && failure.message) || failure));
    } finally {
      setSaving(false);
    }
  }

  const tabs = ['week', 'month', 'quarter', 'year'].map((value) => ({ value, label: reportTypeLabel(value, t) }));
  return h(
    Dialog,
    {
      title: tx(t, 'templateEdit', '编辑模板'),
      onClose,
      width: 760,
      footer: h(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        h(Button, { onClick: onClose, disabled: saving }, tx(t, 'cancel', '取消')),
        h(Button, { variant: 'primary', onClick: save, disabled: saving }, saving ? tx(t, 'saving', '保存中…') : tx(t, 'save', '保存')),
      ),
    },
    h(Tabs, { items: tabs, value: tab, onChange: setTab }),
    h(
      'label',
      { className: 'dsr-field' },
      h('span', { className: 'dsr-fieldLabel' }, `${reportTypeLabel(tab, t)} ${tx(t, 'template', '模板')}`),
      h(Textarea, {
        value: draft.template,
        rows: 8,
        onChange: (event) => setDraft((current) => ({ ...current, template: event.target.value })),
      }),
    ),
    h(
      'label',
      { className: 'dsr-field' },
      h('span', { className: 'dsr-fieldLabel' }, `${reportTypeLabel(tab, t)} ${tx(t, 'guidance', '写作指引')}`),
      h(Textarea, {
        value: draft.guidance,
        rows: 6,
        onChange: (event) => setDraft((current) => ({ ...current, guidance: event.target.value })),
      }),
      h('span', { className: 'dsr-fieldHint' }, tx(t, 'templatesNote', '留空即清除覆盖、回退内置默认。')),
    ),
    error ? h('div', { className: 'dsr-rpt-dialogError', role: 'alert' }, error) : null,
  );
}

// ---------------------------------------------------------------- 主区

function ReportMain({ t, state, actions }) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [repoOpen, setRepoOpen] = React.useState({});
  const [templateOpen, setTemplateOpen] = React.useState(false);

  const detail = state.detail;
  const selectedId = state.selectedId;
  const detailId = detail && (detail.id || selectedId);

  function closeMore() {
    setMoreOpen(false);
  }

  function onMore(command) {
    setMoreOpen(false);
    if (!detail) return;
    if (command === 'template') {
      setTemplateOpen(true);
      return;
    }
    if (command === 'export') {
      actions.exportReport(detailId);
      return;
    }
    if (command === 'delete') setConfirmOpen(true);
  }

  function openRegenerateDialog() {
    if (!detail) return;
    rpOpenGenerateDialog({
      type: rpReportType(detail),
      startDate: detail.periodStart || '',
      endDate: detail.periodEnd || '',
    });
  }

  function toggleRepo(repoKey) {
    setRepoOpen((current) => ({ ...current, [repoKey]: !current[repoKey] }));
  }

  async function removeReport() {
    if (deleting || !detail) return;
    setDeleting(true);
    try {
      await actions.removeReport(detailId);
      setConfirmOpen(false);
    } catch (failure) {
      const message = String((failure && failure.message) || failure || tx(t, 'deleteFailed', '删除失败'));
      showToast('error', message);
    } finally {
      setDeleting(false);
    }
  }

  // 未选中：按「有无报告」区分双按钮空态 / 选择提示
  if (!selectedId) {
    const reports = Array.isArray(state.reports) ? state.reports : [];
    return h(
      'section',
      { className: 'dsr-rpt-main', 'aria-label': tx(t, 'title', '报告与统计') },
      h(
        'div',
        { className: 'dsr-rpt-empty' },
        h(EmptyState, {
          title: reports.length ? tx(t, 'selectTitle', '选择一份报告') : tx(t, 'emptyTitle', '还没有报告'),
          hint: reports.length
            ? tx(t, 'selectHint', '从左侧打开报告查看正文和统计。')
            : tx(t, 'emptyHint', '生成本地报告，或先去同步提交。'),
          action: reports.length
            ? null
            : h(
                'div',
                { className: 'dsr-rpt-emptyActions' },
                h(
                  Button,
                  { variant: 'primary', onClick: () => rpOpenGenerateDialog(null) },
                  tx(t, 'generateReport', '生成报告'),
                ),
                h(
                  Button,
                  { onClick: () => actions.setArea('sync') },
                  tx(t, 'goSync', '先去同步提交'),
                ),
              ),
        }),
      ),
    );
  }

  // 选中但详情尚未到达 / 失败
  if (!detail) {
    if (state.detailError) {
      return h(
        'section',
        { className: 'dsr-rpt-main' },
        h(
          'div',
          { className: 'dsr-rpt-state' },
          h('div', { className: 'dsr-rpt-error' }, String(state.detailError)),
          h(
            Button,
            { size: 'sm', onClick: () => actions.refreshDetail() },
            h(RefreshGlyph, { size: 13 }),
            tx(t, 'retry', '重试'),
          ),
        ),
      );
    }
    return h(
      'section',
      { className: 'dsr-rpt-main' },
      h(
        'div',
        { className: 'dsr-rpt-state' },
        h(Spinner, null),
        h('div', null, tx(t, 'loading', '加载中…')),
      ),
    );
  }

  const type = rpReportType(detail);
  const periodText = rpPeriodText(detail);
  const totals = rpTotals(detail, state.stats);
  const tab = state.tab === 'stats' ? 'stats' : 'report';
  const topics = rpTopicRows(detail);
  const trend = rpTrendBars(detail);

  const tabStrip = h(
    'div',
    { className: 'dsr-rpt-tabStrip', role: 'tablist', 'aria-label': tx(t, 'nav', '报告') },
    h(
      'div',
      { className: 'dsr-rpt-tab active', role: 'tab', 'aria-selected': 'true', title: `${rpTypeLabel(t, type)} ${periodText}` },
      h('span', { className: 'dsr-rpt-chip', 'data-type': type }, rpTypeLabel(t, type)),
      h('span', { className: 'dsr-rpt-tabPeriod' }, periodText || String(detailId || '')),
      h(
        'button',
        {
          type: 'button',
          className: 'dsr-rpt-tabClose',
          title: tx(t, 'close', '关闭'),
          'aria-label': tx(t, 'close', '关闭'),
          onClick: () => actions.selectReport(null),
        },
        h(CloseGlyph, { size: 11 }),
      ),
    ),
  );

  const head = h(
    'div',
    { className: 'dsr-rpt-head' },
    h(
      'p',
      { className: 'dsr-rpt-meta' },
      [rpTypeLabel(t, type), periodText, rpStatusText(t, detail.status), fmtDateTime(detail.generatedAt)]
        .filter(Boolean)
        .join(' · '),
    ),
    h(
      'div',
      { className: 'dsr-rpt-headActions' },
      h(
        Button,
        {
          variant: 'primary',
          size: 'sm',
          onClick: openRegenerateDialog,
          disabled: Boolean(state.generating),
          title: tx(t, 'regenerate', '重生成'),
        },
        h(RefreshGlyph, { size: 13 }),
        tx(t, 'regenerate', '重生成'),
      ),
      h(
        'span',
        { className: 'dsr-rpt-moreWrap' },
        h(
          Button,
          {
            size: 'sm',
            onClick: () => setMoreOpen((value) => !value),
            'aria-haspopup': 'menu',
            'aria-expanded': moreOpen ? 'true' : 'false',
          },
          tx(t, 'more', '更多'),
          h(ChevronGlyph, { size: 12 }),
        ),
        moreOpen ? h('div', { className: 'dsr-rpt-menuMask', onClick: closeMore }) : null,
        moreOpen
          ? h(
              'div',
              { className: 'dsr-rpt-menu', role: 'menu' },
              h(
                'button',
                { type: 'button', role: 'menuitem', className: 'dsr-rpt-menuItem', onClick: () => onMore('template') },
                tx(t, 'templateEdit', '编辑模板'),
              ),
              h(
                'button',
                { type: 'button', role: 'menuitem', className: 'dsr-rpt-menuItem', onClick: () => onMore('export') },
                tx(t, 'exportMarkdown', '导出 Markdown'),
              ),
              h('div', { className: 'dsr-rpt-menuSep' }),
              h(
                'button',
                { type: 'button', role: 'menuitem', className: 'dsr-rpt-menuItem danger', onClick: () => onMore('delete') },
                tx(t, 'delete', '删除'),
              ),
            )
          : null,
      ),
    ),
  );

  const tabs = h(Tabs, {
    items: [
      { value: 'report', label: tx(t, 'reportTab', '正文') },
      { value: 'stats', label: tx(t, 'statsTab', '统计') },
    ],
    value: tab,
    onChange: (next) => actions.setTab(next),
  });

  const reportPane = h(
    'div',
    { className: 'dsr-rpt-pane', role: 'tabpanel' },
    h(
      'div',
      { className: 'dsr-rpt-kpiRow' },
      rpKpiCard(t, tx(t, 'commits', '提交'), fmtInt(totals.commits)),
      rpKpiCard(t, tx(t, 'repos', '仓库'), fmtInt(totals.repos)),
      rpKpiCard(t, tx(t, 'totalLines', '行变更'), fmtInt(totals.net), true),
    ),
    detail.errorMessage
      ? h('div', { className: 'dsr-rpt-alert', role: 'alert' }, String(detail.errorMessage))
      : null,
    h(
      'div',
      { className: 'dsr-rpt-md' },
      h(Markdown, { text: detail.content ? String(detail.content) : tx(t, 'noContent', '（无正文）') }),
    ),
  );

  const openStatsPage = () => {
    const start = detail && detail.periodStart;
    const end = detail && detail.periodEnd;
    if (!start || !end) return;
    if (typeof saSet === 'function') {
      saSet({
        draftStart: start,
        draftEnd: end,
        appliedStart: start,
        appliedEnd: end,
        kind: '',
        openMonths: {},
        monthsInitFor: '',
        openDay: '',
        dayRepo: '',
      });
      if (typeof saLoadAnalytics === 'function') saLoadAnalytics(true);
    }
    if (actions && typeof actions.setArea === 'function') actions.setArea('sync');
  };

  const scopeHeader = h(
    'section',
    { className: 'dsr-rpt-scope' },
    h(
      'div',
      null,
      h('p', { className: 'dsr-rpt-scopeRange' }, periodText || '—'),
      h(
        'p',
        { className: 'dsr-rpt-scopeMeta' },
        h('span', null, tx(t, 'snapshot', '报告快照')),
        h('span', null, `${tx(t, 'generatedAt', '生成时间')} ${fmtDateTime(detail.generatedAt)}`),
        h('span', null, tx(t, 'ruleText', '排除 Merge 与 Cherry-pick')),
      ),
    ),
    h(
      'div',
      { className: 'dsr-rpt-scopeActions' },
      h(Button, { size: 'sm', onClick: openStatsPage, disabled: !detail || !detail.periodStart }, tx(t, 'openInStats', '在统计页查看')),
      state.detailLoading ? h(Spinner, null) : null,
    ),
  );

  const statsPane = h(
    'div',
    { className: 'dsr-rpt-stats', role: 'tabpanel' },
    scopeHeader,
    h(
      'div',
      { className: 'dsr-rpt-kpiGrid' },
      rpKpiCard(t, tx(t, 'commits', '提交'), fmtInt(totals.commits)),
      rpKpiCard(t, tx(t, 'repos', '仓库'), fmtInt(totals.repos)),
      rpKpiCard(t, tx(t, 'branches', '分支'), fmtInt(totals.branches)),
      rpKpiCard(t, tx(t, 'mergeCommits', '合并提交'), fmtInt(totals.merge)),
      rpKpiCard(t, tx(t, 'cherryPicks', '拣选提交'), fmtInt(totals.cherry)),
      rpKpiCard(t, tx(t, 'netLines', '净行'), fmtInt(totals.net), true),
    ),
    h(
      'div',
      { className: 'dsr-rpt-summaryGrid' },
      rpSummaryCard(
        t,
        tx(t, 'codeVolume', '代码体量'),
        h(
          'div',
          { className: 'dsr-rpt-metricList' },
          rpMetricRow(tx(t, 'additions', '新增'), `+${fmtInt(totals.line.additions)}`),
          rpMetricRow(tx(t, 'deletions', '删除'), `-${fmtInt(totals.line.deletions)}`),
          rpMetricRow(tx(t, 'totalChange', '总变更'), fmtInt(totals.line.total)),
          rpMetricRow(tx(t, 'netChange', '净变更'), fmtInt(totals.line.net)),
        ),
      ),
      rpSummaryCard(
        t,
        tx(t, 'domains', '业务域'),
        totals.domainRows.length
          ? h(
              'div',
              { className: 'dsr-rpt-metricList' },
              ...totals.domainRows.map((row) =>
                h(
                  'div',
                  { className: 'dsr-rpt-metricRow', key: row.key },
                  h('span', null, row.name),
                  h('strong', null, `${fmtInt(row.count)} · ${row.share}%`),
                ),
              ),
            )
          : h('p', { className: 'dsr-rpt-sectionHint' }, tx(t, 'noDomains', '当前没有业务域分布。')),
      ),
      rpSummaryCard(
        t,
        tx(t, 'distribution', '分布摘要'),
        h(
          'div',
          { className: 'dsr-rpt-metricList' },
          rpMetricRow(tx(t, 'repoBranch', '仓库+分支'), fmtInt(totals.branches)),
          rpMetricRow(tx(t, 'mergeCommits', 'Merge 提交'), fmtInt(totals.merge)),
          rpMetricRow(
            tx(t, 'topDomain', 'Top 业务域'),
            totals.domainRows[0] ? `${totals.domainRows[0].name} (${fmtInt(totals.domainRows[0].count)})` : '—',
          ),
        ),
      ),
    ),
    h(
      'section',
      { className: 'dsr-rpt-section' },
      h('h3', { className: 'dsr-rpt-sectionTitle' }, tx(t, 'topicsTitle', '主题概览')),
      topics.length
        ? h(
            'div',
            { className: 'dsr-rpt-topics' },
            ...topics.map((row) =>
              h(
                'article',
                { className: 'dsr-rpt-topic', key: row.key },
                h(
                  'div',
                  { className: 'dsr-rpt-topicHead' },
                  row.domain ? h(Badge, null, row.domain) : null,
                  h('span', null, row.title),
                ),
                row.summary ? h('p', { className: 'dsr-rpt-topicSummary' }, row.summary) : null,
              ),
            ),
          )
        : h('p', { className: 'dsr-rpt-sectionHint' }, tx(t, 'noTopics', '当前没有主题摘要。')),
    ),
    h(
      'section',
      { className: 'dsr-rpt-section' },
      h(
        'div',
        { className: 'dsr-rpt-sectionHead' },
        h('h3', { className: 'dsr-rpt-sectionTitle' }, tx(t, 'repoBreakdown', '仓库')),
        h('p', { className: 'dsr-rpt-sectionHint' }, tx(t, 'repoBreakdownHint', '报告生成时的仓库快照，展开后查看分支明细。')),
      ),
      totals.repoRows.length
        ? rpRepoTable(t, totals.repoRows, repoOpen, toggleRepo)
        : h('p', { className: 'dsr-rpt-sectionHint' }, tx(t, 'noRepoCommits', '当前统计范围内没有仓库提交。')),
    ),
    h(
      'section',
      { className: 'dsr-rpt-section' },
      h(
        'div',
        { className: 'dsr-rpt-sectionHead' },
        h('h3', { className: 'dsr-rpt-sectionTitle' }, tx(t, 'trendTitle', '趋势')),
        h(
          'p',
          { className: 'dsr-rpt-sectionHint' },
          `${trend.length} ${tx(t, 'days', '天')} · ${fmtInt(trend.reduce((sum, bar) => sum + bar.count, 0))} ${tx(t, 'commits', '提交')}`,
        ),
      ),
      trend.length
        ? rpTrendChart(t, trend)
        : h('p', { className: 'dsr-rpt-sectionHint' }, tx(t, 'noTrend', '当前统计范围内没有可展示的趋势数据。')),
    ),
  );

  const confirmDialog = confirmOpen
    ? h(
        Dialog,
        {
          title: tx(t, 'delete', '删除'),
          onClose: () => {
            if (!deleting) setConfirmOpen(false);
          },
          footer: h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h(
              Button,
              { onClick: () => setConfirmOpen(false), disabled: deleting },
              tx(t, 'cancel', '取消'),
            ),
            h(
              Button,
              { variant: 'danger', onClick: removeReport, disabled: deleting },
              deleting ? tx(t, 'deleting', '删除中…') : tx(t, 'delete', '删除'),
            ),
          ),
        },
        h('div', null, tx(t, 'deleteConfirm', '确认删除这份报告？')),
      )
    : null;

  return h(
    'section',
    { className: 'dsr-rpt-main', 'aria-label': tx(t, 'title', '报告与统计') },
    tabStrip,
    h(
      'div',
      { className: 'dsr-rpt-content' },
      head,
      h('div', { className: 'dsr-rpt-tabs' }, tabs),
      tab === 'report' ? reportPane : statsPane,
      confirmDialog,
      templateOpen
        ? h(TemplateEditDialog, {
            t,
            type: rpReportType(detail),
            onClose: () => setTemplateOpen(false),
          })
        : null,
    ),
  );
}
