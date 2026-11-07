// ---------------------------------------------------------------- 报告左栏：新建 / 搜索 / 类型分段 / 报告树 + 生成对话框
// 对齐 workbench 最新样式（ReportsView aside：新建主按钮 + 搜索 + el-segmented + 报告树）。
// 壳层（99-apply）负责 aside chrome 与「报告 / 统计 / 设置」区导航，本文件只渲染 aside 内容。

addClientCSS(`
.dsr-rpt-rail { display: flex; flex-direction: column; gap: 10px; min-height: 100%; }
.dsr-rpt-rail button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsr-rpt-rail input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsr-rpt-top { display: flex; align-items: center; gap: 8px; }
.dsr-rpt-create {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex: 1; height: 34px; padding: 0 12px; border: 0; border-radius: 8px;
  background: var(--dsw-alias-brand-primary); color: #fff;
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);
}
.dsr-rpt-create:hover { filter: brightness(1.06); }
.dsr-rpt-create:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsr-rpt-filters { display: flex; flex-direction: column; gap: 8px; }
.dsr-rpt-search { position: relative; display: flex; align-items: center; }
.dsr-rpt-search .dsr-input { height: 30px; padding-left: 29px; }
.dsr-rpt-searchIcon {
  position: absolute; left: 9px; display: inline-flex; pointer-events: none;
  color: var(--dsw-alias-label-secondary);
}
.dsr-rpt-seg {
  display: flex; gap: 2px; padding: 2px; border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-2));
}
.dsr-rpt-segBtn {
  flex: 1; min-width: 0; height: 24px; padding: 0 6px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap;
}
.dsr-rpt-segBtn:hover { color: var(--dsw-alias-label-primary); }
.dsr-rpt-segBtn.active { background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
.dsr-rpt-segBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-rpt-gen {
  display: flex; align-items: center; gap: 9px; padding: 9px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsr-rpt-genText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsr-rpt-genTitle { font-size: 12px; font-weight: 600; }
.dsr-rpt-genRange {
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsr-rpt-tree { display: flex; flex-direction: column; gap: 1px; }
.dsr-rpt-group { display: flex; flex-direction: column; }
.dsr-rpt-groupHead {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 27px; padding: 0 6px;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.dsr-rpt-groupHead:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsr-rpt-groupHead:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsr-rpt-chev { display: inline-flex; flex: none; transition: transform .12s ease; }
.dsr-rpt-chev.open { transform: rotate(90deg); }
.dsr-rpt-groupLabel {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
}
.dsr-rpt-monthHead { padding-left: 12px; }
.dsr-rpt-monthHead .dsr-rpt-groupLabel { font-weight: 500; }
.dsr-rpt-groupCount { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsr-rpt-children { display: flex; flex-direction: column; gap: 1px; }
.dsr-rpt-item {
  display: flex; align-items: center; gap: 7px; width: 100%; height: 27px; padding: 0 6px 0 22px;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.dsr-rpt-item.monthLevel { padding-left: 32px; }
.dsr-rpt-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-rpt-item.active { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-brand-primary); }
.dsr-rpt-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsr-rpt-itemPeriod { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dsr-rpt-chip {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 16px; padding: 0 4px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 10.5px; font-weight: 650;
}
.dsr-rpt-chip[data-type='week'] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dsr-rpt-chip[data-type='month'] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dsr-rpt-chip[data-type='quarter'] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.dsr-rpt-chip[data-type='year'] { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dsr-rpt-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-border-l2); }
.dsr-rpt-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dsr-rpt-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.dsr-rpt-dot.bad { background: var(--dsw-alias-state-error-primary); }
.dsr-rpt-state {
  display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center;
}
.dsr-rpt-stateActions { display: flex; gap: 6px; }
/* 生成对话框（挂载在 primitives Dialog 内） */
.dsr-rpt-quick { display: flex; flex-wrap: wrap; gap: 6px; }
.dsr-rpt-quickBtn {
  height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.dsr-rpt-quickBtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsr-rpt-quickBtn.active {
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); font-weight: 600;
}
.dsr-rpt-quickBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsr-rpt-dialogRow { display: flex; gap: 10px; }
.dsr-rpt-dialogRow .dsr-field { flex: 1; min-width: 0; }
.dsr-rpt-dialogError { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
`);

// ---------------------------------------------------------------- 纯函数（rp 前缀，避免与其他文件的顶层标识符冲突）

const rpReportTypes = ['week', 'month', 'quarter', 'year'];
const rpDateRe = /^\d{4}-\d{2}-\d{2}$/;

function rpPad2(value) {
  return String(value).padStart(2, '0');
}

function rpFormatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${rpPad2(date.getMonth() + 1)}-${rpPad2(date.getDate())}`;
}

function rpIsDate(value) {
  const text = String(value || '');
  if (!rpDateRe.test(text)) return false;
  return !Number.isNaN(new Date(`${text}T00:00:00`).getTime());
}

function rpIsValidRange(startDate, endDate) {
  return rpIsDate(startDate) && rpIsDate(endDate) && startDate <= endDate;
}

function rpMakeRange(start, end) {
  return { startDate: rpFormatDate(start), endDate: rpFormatDate(end) };
}

/** 按类型给出“当前”周期（本地时区，周一为周首日）。 */
function rpRangeForType(type, now) {
  const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const year = base.getFullYear();
  const month = base.getMonth();
  if (type === 'month') return rpMakeRange(new Date(year, month, 1), new Date(year, month + 1, 0));
  if (type === 'quarter') {
    const quarter = Math.floor(month / 3);
    return rpMakeRange(new Date(year, quarter * 3, 1), new Date(year, quarter * 3 + 3, 0));
  }
  if (type === 'year') return rpMakeRange(new Date(year, 0, 1), new Date(year, 11, 31));
  const monday = new Date(year, month, base.getDate() - ((base.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return rpMakeRange(monday, sunday);
}

/** 快捷范围（对齐 SyncView 的 6 个快捷选项）。 */
function rpQuickRanges(now) {
  const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const daysAgo = (count) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - count);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  return [
    { key: 'last7', labelKey: 'range7', fallback: '近 7 天', ...rpMakeRange(daysAgo(6), today) },
    { key: 'last30', labelKey: 'range30', fallback: '近 30 天', ...rpMakeRange(daysAgo(29), today) },
    { key: 'week', labelKey: 'rangeWeek', fallback: '本周', ...rpRangeForType('week', today) },
    { key: 'month', labelKey: 'rangeMonth', fallback: '当月', ...rpRangeForType('month', today) },
    { key: 'lastMonth', labelKey: 'rangeLastMonth', fallback: '上个月', ...rpMakeRange(lastMonthStart, lastMonthEnd) },
    { key: 'last12', labelKey: 'range12', fallback: '近 12 个月', ...rpMakeRange(daysAgo(364), today) },
  ];
}

/** 周期跨度推断类型（快捷范围选完后同步类型，避免“周报 + 12 个月”这种错配）。 */
function rpInferType(startDate, endDate) {
  if (!rpIsDate(startDate) || !rpIsDate(endDate)) return 'week';
  const start = new Date(`${startDate}T00:00:00`).getTime();
  const end = new Date(`${endDate}T00:00:00`).getTime();
  const days = Math.round((end - start) / 86400000) + 1;
  if (days <= 8) return 'week';
  if (days <= 35) return 'month';
  if (days <= 100) return 'quarter';
  return 'year';
}

/** 报告类型归一：API 正常返回 week|month|quarter|year，也容忍中文标签。 */
function rpReportType(item) {
  const raw = String((item && item.type) || '').toLowerCase();
  if (rpReportTypes.includes(raw)) return raw;
  const text = String((item && item.type) || '');
  if (text.includes('周')) return 'week';
  if (text.includes('月')) return 'month';
  if (text.includes('季')) return 'quarter';
  if (text.includes('年')) return 'year';
  return raw || 'week';
}

function rpTypeLabel(t, type) {
  const fallbacks = { week: '周报', month: '月报', quarter: '季报', year: '年报' };
  const keys = { week: 'typeWeek', month: 'typeMonth', quarter: 'typeQuarter', year: 'typeYear' };
  const fallback = fallbacks[type];
  if (!fallback) return String(type || '');
  return tx(t, keys[type], fallback);
}

function rpStatusText(t, status) {
  const key = String(status || '').toLowerCase();
  if (key === 'pending') return tx(t, 'statusPending', '待生成');
  if (key === 'generating') return tx(t, 'statusGenerating', '生成中');
  if (key === 'completed' || key === 'generated' || key === 'ready') return tx(t, 'statusCompleted', '已完成');
  if (key === 'failed' || key === 'error') return tx(t, 'statusFailed', '失败');
  if (key === 'empty') return tx(t, 'statusEmpty', '空报告');
  return String(status || '');
}

function rpStatusTone(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'completed' || key === 'generated' || key === 'ready') return 'ok';
  if (key === 'pending' || key === 'generating' || key === 'empty') return 'warn';
  if (key === 'failed' || key === 'error') return 'bad';
  return '';
}

function rpPeriodText(item) {
  const start = String((item && item.periodStart) || '');
  const end = String((item && item.periodEnd) || '');
  if (start && end) return `${fmtDate(start)} ~ ${fmtDate(end)}`;
  return fmtDate(start || end || '');
}

function rpTypeRank(type) {
  const ranks = { year: 0, quarter: 1, month: 2, week: 3 };
  return type in ranks ? ranks[type] : 9;
}

function rpFilterReports(reports, query, typeFilter, t) {
  const needle = String(query || '').trim().toLowerCase();
  return (Array.isArray(reports) ? reports : []).filter((item) => {
    if (typeFilter && typeFilter !== 'all' && rpReportType(item) !== typeFilter) return false;
    if (!needle) return true;
    const haystack = [rpPeriodText(item), rpTypeLabel(t, rpReportType(item)), String((item && item.id) || '')]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** 分组（复刻 upstream）：年 →（季报/年报挂年节点，周报/月报挂到起始月份节点）。 */
function rpGroupReports(reports, t) {
  const years = new Map();
  for (const item of Array.isArray(reports) ? reports : []) {
    const start = String((item && item.periodStart) || '');
    const year = /^\d{4}/.test(start) ? start.slice(0, 4) : tx(t, 'uncategorized', '未分类');
    if (!years.has(year)) years.set(year, { summaries: [], months: new Map() });
    const bucket = years.get(year);
    const type = rpReportType(item);
    if (type === 'year' || type === 'quarter') {
      bucket.summaries.push(item);
      continue;
    }
    const monthKey = /^\d{4}-\d{2}/.test(start) ? start.slice(0, 7) : tx(t, 'uncategorized', '未分类');
    if (!bucket.months.has(monthKey)) bucket.months.set(monthKey, []);
    bucket.months.get(monthKey).push(item);
  }
  const byPeriod = (left, right) => {
    const rank = rpTypeRank(rpReportType(left)) - rpTypeRank(rpReportType(right));
    if (rank) return rank;
    return String((right && right.periodStart) || '').localeCompare(String((left && left.periodStart) || ''));
  };
  return Array.from(years.entries())
    .sort(([left], [right]) => String(right).localeCompare(String(left)))
    .map(([year, bucket]) => {
      const months = Array.from(bucket.months.entries())
        .sort(([left], [right]) => String(right).localeCompare(String(left)))
        .map(([key, items]) => ({
          key: `${year}:${key}`,
          label: /^\d{4}-\d{2}$/.test(key) ? `${Number(key.slice(5, 7))} ${tx(t, 'monthSuffix', '月')}` : key,
          items: [...items].sort(byPeriod),
        }));
      const summaries = [...bucket.summaries].sort(byPeriod);
      return {
        key: `year:${year}`,
        label: year,
        count: summaries.length + months.reduce((total, month) => total + month.items.length, 0),
        summaries,
        months,
      };
    });
}

// ---------------------------------------------------------------- 生成对话框的跨组件开关
// 壳层同时在 aside 渲染 ReportRail、在 main 渲染 ReportMain；对话框只由 ReportRail 挂载一次，
// 主区「重生成」通过 rpOpenGenerateDialog(preset) 请求打开。

let rpGenerateDialog = { open: false, preset: null };
const rpGenerateDialogListeners = new Set();

function rpDialogSnapshot() {
  return { open: rpGenerateDialog.open, preset: rpGenerateDialog.preset };
}

function rpSetGenerateDialog(patch) {
  rpGenerateDialog = { ...rpGenerateDialog, ...patch };
  const snapshot = rpDialogSnapshot();
  for (const listener of Array.from(rpGenerateDialogListeners)) {
    try {
      listener(snapshot);
    } catch {
      /* 单个订阅者异常不影响其它 */
    }
  }
}

function rpOpenGenerateDialog(preset) {
  rpSetGenerateDialog({ open: true, preset: preset || null });
}

function rpCloseGenerateDialog() {
  rpSetGenerateDialog({ open: false, preset: null });
}

function rpSubscribeDialog(listener) {
  rpGenerateDialogListeners.add(listener);
  try {
    listener(rpDialogSnapshot());
  } catch {
    /* ignore */
  }
  return () => rpGenerateDialogListeners.delete(listener);
}

function rpTypeOptions(t) {
  return [
    { value: 'week', label: tx(t, 'typeWeek', '周报') },
    { value: 'month', label: tx(t, 'typeMonth', '月报') },
    { value: 'quarter', label: tx(t, 'typeQuarter', '季报') },
    { value: 'year', label: tx(t, 'typeYear', '年报') },
  ];
}

// ---------------------------------------------------------------- 新建 / 重生成对话框（对齐 upstream：类型 + 区间 + 快捷范围 + 提交）

function ReportGenerateDialog({ t, state, actions, onClose, preset }) {
  const now = new Date();
  const presetType = preset && preset.type ? rpReportType({ type: preset.type }) : '';
  const initialType = presetType || rpReportType({ type: (state.config && state.config.defaultReportType) || 'week' });
  const initialRange = preset && preset.startDate && preset.endDate
    ? { startDate: String(preset.startDate), endDate: String(preset.endDate) }
    : rpRangeForType(initialType, now);

  const [type, setType] = React.useState(initialType);
  const [startDate, setStartDate] = React.useState(initialRange.startDate);
  const [endDate, setEndDate] = React.useState(initialRange.endDate);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  const quickRanges = rpQuickRanges(now);
  const activeQuick = quickRanges.find((item) => item.startDate === startDate && item.endDate === endDate);
  const valid = rpIsValidRange(startDate, endDate);

  function changeType(nextType) {
    setType(nextType);
    const range = rpRangeForType(nextType, now);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setError(null);
  }

  function applyQuick(item) {
    setStartDate(item.startDate);
    setEndDate(item.endDate);
    setType(rpInferType(item.startDate, item.endDate));
    setError(null);
  }

  async function submit() {
    if (submitting || !valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await actions.generateReport({ type, startDate, endDate });
      setSubmitting(false);
      if (typeof onClose === 'function') onClose();
    } catch (failure) {
      setSubmitting(false);
      setError(String((failure && failure.message) || failure || tx(t, 'failed', '加载失败')));
    }
  }

  const footer = h(
    'div',
    { style: { display: 'flex', gap: '8px' } },
    h(Button, { onClick: onClose, disabled: submitting }, tx(t, 'cancel', '取消')),
    h(
      Button,
      { variant: 'primary', onClick: submit, disabled: submitting || !valid },
      submitting ? tx(t, 'generating', '生成中…') : tx(t, 'generate', '开始生成'),
    ),
  );

  return h(
    Dialog,
    {
      title: preset ? tx(t, 'regenerate', '重生成') : tx(t, 'generateTitle', '新建报告'),
      footer,
      onClose: () => {
        if (!submitting && typeof onClose === 'function') onClose();
      },
    },
    h(
      Field,
      { label: tx(t, 'reportType', '报告类型') },
      h(Select, {
        options: rpTypeOptions(t),
        value: type,
        onChange: changeType,
        disabled: submitting,
      }),
    ),
    h(
      Field,
      {
        label: tx(t, 'quickRange', '快捷范围'),
        hint: tx(t, 'quickRangeHint', '选择快捷范围会自动带出起止日期，并据跨度推断报告类型。'),
      },
      h(
        'div',
        { className: 'dsr-rpt-quick', role: 'group' },
        ...quickRanges.map((item) =>
          h(
            'button',
            {
              key: item.key,
              type: 'button',
              className: `dsr-rpt-quickBtn${activeQuick && activeQuick.key === item.key ? ' active' : ''}`,
              'aria-pressed': activeQuick && activeQuick.key === item.key ? 'true' : 'false',
              disabled: submitting,
              onClick: () => applyQuick(item),
            },
            tx(t, item.labelKey, item.fallback),
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'dsr-rpt-dialogRow' },
      h(
        Field,
        { label: tx(t, 'startDate', '开始日期'), hint: tx(t, 'dateHint', 'YYYY-MM-DD'), invalid: !rpIsDate(startDate) },
        h(Input, {
          type: 'date',
          value: startDate,
          disabled: submitting,
          'aria-label': tx(t, 'startDate', '开始日期'),
          onChange: (event) => setStartDate(event.target.value),
        }),
      ),
      h(
        Field,
        { label: tx(t, 'endDate', '结束日期'), hint: tx(t, 'dateHint', 'YYYY-MM-DD'), invalid: !rpIsDate(endDate) },
        h(Input, {
          type: 'date',
          value: endDate,
          disabled: submitting,
          'aria-label': tx(t, 'endDate', '结束日期'),
          onChange: (event) => setEndDate(event.target.value),
        }),
      ),
    ),
    !valid
      ? h(
          'div',
          { className: 'dsr-rpt-dialogError' },
          tx(t, 'invalidRange', '请选择有效的起止日期（YYYY-MM-DD，且开始日期不晚于结束日期）。'),
        )
      : null,
    error ? h('div', { className: 'dsr-rpt-dialogError', role: 'alert' }, error) : null,
  );
}

// ---------------------------------------------------------------- 报告树节点

function rpTreeItemNode(item, ctx, monthLevel) {
  const type = rpReportType(item);
  const statusText = rpStatusText(ctx.t, item.status);
  const tone = rpStatusTone(item.status);
  const active = ctx.selectedId === item.id;
  return h(
    'button',
    {
      key: String(item.id || `${type}:${item.periodStart || ''}`),
      type: 'button',
      className: `dsr-rpt-item${monthLevel ? ' monthLevel' : ''}${active ? ' active' : ''}`,
      title: [rpPeriodText(item), statusText].filter(Boolean).join(' · '),
      'aria-pressed': active ? 'true' : 'false',
      onClick: () => ctx.onSelect(item.id),
    },
    h(DocGlyph, { size: 13 }),
    h('span', { className: 'dsr-rpt-chip', 'data-type': type }, rpTypeLabel(ctx.t, type)),
    h('span', { className: 'dsr-rpt-itemPeriod' }, rpPeriodText(item)),
    h('span', {
      className: `dsr-rpt-dot${tone ? ` ${tone}` : ''}`,
      title: statusText,
      'aria-label': statusText,
    }),
  );
}

function rpMonthNode(month, ctx) {
  const open = !ctx.collapsed[month.key];
  return h(
    'div',
    { className: 'dsr-rpt-group', key: month.key },
    h(
      'button',
      {
        type: 'button',
        className: 'dsr-rpt-groupHead dsr-rpt-monthHead',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => ctx.onToggle(month.key),
      },
      h('span', { className: `dsr-rpt-chev${open ? ' open' : ''}` }, h(ChevronGlyph, { size: 12 })),
      h(FolderGlyph, { size: 13 }),
      h('span', { className: 'dsr-rpt-groupLabel' }, month.label),
      h('span', { className: 'dsr-rpt-groupCount' }, String(month.items.length)),
    ),
    open
      ? h('div', { className: 'dsr-rpt-children' }, ...month.items.map((item) => rpTreeItemNode(item, ctx, true)))
      : null,
  );
}

function rpYearNode(group, ctx) {
  const open = !ctx.collapsed[group.key];
  return h(
    'div',
    { className: 'dsr-rpt-group', key: group.key },
    h(
      'button',
      {
        type: 'button',
        className: 'dsr-rpt-groupHead',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => ctx.onToggle(group.key),
      },
      h('span', { className: `dsr-rpt-chev${open ? ' open' : ''}` }, h(ChevronGlyph, { size: 12 })),
      h(FolderGlyph, { size: 13 }),
      h('span', { className: 'dsr-rpt-groupLabel' }, group.label),
      h('span', { className: 'dsr-rpt-groupCount' }, String(group.count)),
    ),
    open
      ? h(
          'div',
          { className: 'dsr-rpt-children' },
          ...group.summaries.map((item) => rpTreeItemNode(item, ctx, false)),
          ...group.months.map((month) => rpMonthNode(month, ctx)),
        )
      : null,
  );
}

// ---------------------------------------------------------------- 左栏

function ReportRail({ t, state, actions }) {
  const [dialog, setDialog] = React.useState(rpDialogSnapshot());
  const [collapsed, setCollapsed] = React.useState({});

  React.useEffect(() => rpSubscribeDialog(setDialog), []);

  const filtered = React.useMemo(
    () => rpFilterReports(state.reports, state.q, state.typeFilter, t),
    [state.reports, state.q, state.typeFilter, t],
  );
  const groups = React.useMemo(() => rpGroupReports(filtered, t), [filtered, t]);

  function toggleGroup(key) {
    setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }));
  }

  const ctx = {
    t,
    collapsed,
    selectedId: state.selectedId,
    onToggle: toggleGroup,
    onSelect: (id) => actions.selectReport(id),
  };

  const generating = state.generating
    ? h(
        'div',
        { className: 'dsr-rpt-gen', role: 'status', 'aria-live': 'polite' },
        h(Spinner, null),
        h(
          'div',
          { className: 'dsr-rpt-genText' },
          h(
            'div',
            { className: 'dsr-rpt-genTitle' },
            `${tx(t, 'generatingPrefix', '正在生成')} ${rpTypeLabel(t, rpReportType(state.generating))}`,
          ),
          h(
            'div',
            { className: 'dsr-rpt-genRange' },
            `${String(state.generating.startDate || '')} ~ ${String(state.generating.endDate || '')}`,
          ),
        ),
      )
    : null;

  const segmentOptions = [{ value: 'all', label: tx(t, 'filterAll', '全部类型') }, ...rpTypeOptions(t)];
  const segment = h(
    'div',
    { className: 'dsr-rpt-seg', role: 'group', 'aria-label': tx(t, 'reportType', '报告类型') },
    ...segmentOptions.map((option) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          className: `dsr-rpt-segBtn${(state.typeFilter || 'all') === option.value ? ' active' : ''}`,
          'aria-pressed': (state.typeFilter || 'all') === option.value ? 'true' : 'false',
          onClick: () => actions.setTypeFilter(option.value),
        },
        option.label,
      ),
    ),
  );

  const reports = Array.isArray(state.reports) ? state.reports : [];
  let listNodes = [];
  if (state.reportsLoading && !reports.length) {
    listNodes = [
      h('div', { className: 'dsr-rpt-state', key: 'loading' }, h(Spinner, null), h('div', null, tx(t, 'loading', '加载中…'))),
    ];
  } else if (state.reportsError) {
    listNodes = [
      h(
        'div',
        { className: 'dsr-rpt-state', key: 'error' },
        h('div', { className: 'dsr-error' }, String(state.reportsError)),
        h(
          Button,
          { size: 'sm', onClick: () => actions.refreshReports() },
          tx(t, 'retry', '重试'),
        ),
      ),
    ];
  } else if (!reports.length) {
    listNodes = [
      h(EmptyState, {
        key: 'empty',
        title: tx(t, 'asideEmpty', '暂无报告'),
        hint: tx(t, 'emptyHint', '生成本地报告，或先去同步提交。'),
        action: h(
          Button,
          { variant: 'primary', size: 'sm', onClick: () => rpOpenGenerateDialog(null) },
          h(PlusGlyph, { size: 13 }),
          tx(t, 'newReport', '新建报告'),
        ),
      }),
    ];
  } else if (!filtered.length) {
    listNodes = [
      h(EmptyState, {
        key: 'emptyFiltered',
        title: tx(t, 'asideNoMatch', '没有匹配的报告'),
        hint: tx(t, 'asideNoMatchHint', '换个关键词或类型试试。'),
      }),
    ];
  } else {
    listNodes = groups.map((group) => rpYearNode(group, ctx));
  }

  return h(
    'div',
    { className: 'dsr-rpt-rail' },
    h(
      'div',
      { className: 'dsr-rpt-top' },
      h(
        'button',
        { type: 'button', className: 'dsr-rpt-create', onClick: () => rpOpenGenerateDialog(null) },
        h(PlusGlyph, { size: 14 }),
        tx(t, 'newReport', '新建报告'),
      ),
      h(
        IconButton,
        { onClick: () => actions.refreshReports(), title: tx(t, 'refresh', '刷新') },
        h(RefreshGlyph, { size: 14 }),
      ),
    ),
    generating,
    h(
      'div',
      { className: 'dsr-rpt-filters' },
      h(
        'div',
        { className: 'dsr-rpt-search' },
        h('span', { className: 'dsr-rpt-searchIcon' }, h(SearchGlyph, { size: 13 })),
        h(Input, {
          value: state.q,
          placeholder: tx(t, 'searchReport', '搜索报告…'),
          'aria-label': tx(t, 'searchReport', '搜索报告…'),
          onChange: (event) => actions.setQuery(event.target.value),
        }),
      ),
      segment,
    ),
    h('div', { className: 'dsr-rpt-tree' }, ...listNodes),
    dialog.open
      ? h(ReportGenerateDialog, {
          t,
          state,
          actions,
          preset: dialog.preset,
          onClose: rpCloseGenerateDialog,
        })
      : null,
  );
}
