/* 由 scripts/build-client.mjs 生成，勿手改；源文件在 client-src/ */

/* ==== client-src/00-header.js ==== */
window.__ModuleLoader__.load({
  // 官方约定：factory id 必须等于 package.json 的包名。
  id: 'dsh-report',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshReport';
    const inject = ['slots', 'locale'];
    const API = '/plugins/dsh-report/api';

    /** 各 client-src 文件可通过 addClientCSS 追加样式，由 99-apply 统一注入。 */
    const CLIENT_CSS = [];
    function addClientCSS(css) {
      CLIENT_CSS.push(css);
    }

    // ==== 组件契约（各文件必须按此导出顶层函数名） ====
    // 50-tree.js   : function ReportRail(props)          左栏：区域切换/新建/搜索/类型筛选/报告树
    //                function ReportGenerateDialog(props) 新建报告对话框
    // 60-report.js : function ReportMain(props)           主区：详情头 + 正文/统计 tab + 空态
    // 70-stats.js  : function StatsPanel(props)           统计 tab 内容（KPI/趋势/仓库/业务域/topic）
    // 80-sync.js   : function SyncPage(props)             统计区域：连接/范围/同步/覆盖度
    //                function SettingsPage(props)         设置：GitLab 连接 / 模板
    // 30-primitives.js : Button/IconButton/Input/Select/Checkbox/Tabs/Dialog/Spinner/EmptyState/Toast/Field/Badge
    // 40-markdown.js   : function Markdown({ text }) 与 renderMarkdown(text)
    // props 约定：{ t, state, actions }


/* ==== client-src/10-store.js ==== */
// ---------------------------------------------------------------- 状态与数据层
// 模块级 store：侧栏入口 / 浮层 / 各页面共享。极简实现，不引入第三方状态库。

const initialState = {
  open: false,
  // 区域：reports（报告）| sync（统计/同步）| settings（设置）
  area: 'reports',
  // 报告详情 tab：report（正文）| stats（统计）
  tab: 'report',
  q: '',
  typeFilter: 'all',
  reports: [],
  reportsLoading: false,
  reportsError: null,
  selectedId: null,
  detail: null,
  stats: null,
  detailLoading: false,
  detailError: null,
  config: null,
  templates: null,
  generating: null, // { type, startDate, endDate, sessionId, startedAt }
  toast: null, // { kind: 'ok'|'error', text }
};

let state = { ...initialState };
const listeners = new Set();

function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function useStore() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const fn = () => force((value) => value + 1);
    return subscribe(fn);
  }, []);
  return state;
}

function useOpen() {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const fn = () => force((value) => value + 1);
    return subscribe(fn);
  }, []);
  return state.open;
}

function showToast(kind, text) {
  setState({ toast: { kind, text, at: Date.now() } });
  window.setTimeout(() => {
    if (state.toast && state.toast.text === text) setState({ toast: null });
  }, 3200);
}

// ---------------------------------------------------------------- HTTP 客户端
async function request(method, pathname, body) {
  const init = {
    method,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API}${pathname}`, init);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = contentType.includes('application/json') ? await response.json() : null;
      if (errorBody) message = errorBody.message || errorBody.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

const api = {
  get: (pathname) => request('GET', pathname),
  post: (pathname, body) => request('POST', pathname, body ?? {}),
  put: (pathname, body) => request('PUT', pathname, body ?? {}),
  del: (pathname) => request('DELETE', pathname),
};

// ---------------------------------------------------------------- 展示格式化
function fmtInt(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('zh-CN');
}

function fmtDate(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replace(/-/g, '/');
  return text || '—';
}

function fmtDateTime(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(text)) return text.replace('T', ' ').slice(0, 16).replace(/-/g, '/');
  return text || '—';
}

function reportTypeLabel(type, t) {
  const labels = {
    week: t ? t('typeWeek') : '周报',
    month: t ? t('typeMonth') : '月报',
    quarter: t ? t('typeQuarter') : '季报',
    year: t ? t('typeYear') : '年报',
  };
  return labels[type] || String(type || '');
}

function statusLabel(status, t) {
  const labels = {
    pending: t ? t('statusPending') : '待生成',
    generating: t ? t('statusGenerating') : '生成中',
    generated: t ? t('statusCompleted') : '已完成',
    completed: t ? t('statusCompleted') : '已完成',
    failed: t ? t('statusFailed') : '失败',
  };
  return labels[status] || String(status || '');
}

// ---------------------------------------------------------------- 数据动作
const GENERATE_POLL_MS = 4000;
const GENERATE_MAX_MS = 15 * 60 * 1000;
let generateTimer = null;

const actions = {
  setOpen(value) {
    setState({ open: Boolean(value) });
  },
  setArea(area) {
    setState({ area });
    if (area === 'reports' && !state.reports.length && !state.reportsLoading) actions.refreshReports();
    if (area === 'sync' && !state.config) actions.loadConfig();
  },
  setTab(tab) {
    setState({ tab });
    if (tab === 'stats' && state.selectedId && !state.stats) actions.refreshStats();
  },
  setQuery(q) {
    setState({ q: String(q || '') });
  },
  setTypeFilter(typeFilter) {
    setState({ typeFilter: typeFilter || 'all' });
  },

  async refreshReports() {
    setState({ reportsLoading: true, reportsError: null });
    try {
      const data = await api.get('/reports');
      setState({ reports: data.reports || [], reportsLoading: false });
      if (state.selectedId && !(data.reports || []).some((item) => item.id === state.selectedId)) {
        setState({ selectedId: null, detail: null, stats: null });
      }
    } catch (error) {
      setState({ reportsLoading: false, reportsError: String(error.message || error) });
    }
  },

  async selectReport(id) {
    if (!id) {
      setState({ selectedId: null, detail: null, stats: null });
      return;
    }
    setState({ selectedId: id, area: 'reports', detailLoading: true, detailError: null, stats: null });
    try {
      const detail = await api.get(`/reports/${encodeURIComponent(id)}`);
      if (state.selectedId !== id) return;
      setState({ detail, detailLoading: false });
      actions.refreshStats();
    } catch (error) {
      if (state.selectedId !== id) return;
      setState({ detailLoading: false, detailError: String(error.message || error) });
    }
  },

  async refreshDetail() {
    if (state.selectedId) await actions.selectReport(state.selectedId);
  },

  async refreshStats() {
    const id = state.selectedId;
    if (!id) return;
    try {
      const stats = await api.get(`/reports/${encodeURIComponent(id)}/stats`);
      if (state.selectedId === id) setState({ stats });
    } catch {
      if (state.selectedId === id) setState({ stats: null });
    }
  },

  async removeReport(id) {
    await api.del(`/reports/${encodeURIComponent(id)}`);
    showToast('ok', '报告已删除');
    if (state.selectedId === id) setState({ selectedId: null, detail: null, stats: null });
    await actions.refreshReports();
  },

  exportReport(id) {
    window.open(`${API}/reports/${encodeURIComponent(id)}/export?format=markdown`, '_blank');
  },

  async loadConfig() {
    try {
      const config = await api.get('/config');
      setState({ config });
      return config;
    } catch {
      return null;
    }
  },

  async saveConfig(patch) {
    const config = await api.put('/config', patch);
    setState({ config });
    showToast('ok', '配置已保存');
    return config;
  },

  async loadTemplates() {
    const templates = await api.get('/templates');
    setState({ templates });
    return templates;
  },

  async saveTemplates(patch) {
    await api.put('/templates', patch);
    showToast('ok', '模板已保存');
    return actions.loadTemplates();
  },

  /**
   * 触发报告生成：Host 侧会新建一个「报告助手」会话并把任务交给模型；
   * 页面通过轮询 /reports 等待 report_update 落库。
   */
  async generateReport({ type, startDate, endDate, guidance }) {
    if (state.generating) throw new Error('已有报告正在生成');
    const result = await api.post('/reports/generate', { type, startDate, endDate, guidance });
    const reportId = result.reportId || `${type}:${startDate}:${endDate}`;
    setState({ generating: { type, startDate, endDate, reportId, sessionId: result.sessionId, startedAt: Date.now() } });
    showToast('ok', '已创建生成任务，完成后会自动刷新');
    const startedAt = Date.now();
    window.clearInterval(generateTimer);
    generateTimer = window.setInterval(async () => {
      if (!state.generating) {
        window.clearInterval(generateTimer);
        return;
      }
      await actions.refreshReports();
      const done = state.reports.some((item) => item.id === reportId && item.status && item.status !== 'pending' && item.status !== 'generating');
      const timeout = Date.now() - startedAt > GENERATE_MAX_MS;
      if (done || timeout) {
        window.clearInterval(generateTimer);
        setState({ generating: null });
        if (done) {
          showToast('ok', '报告生成完成');
          await actions.selectReport(reportId);
        } else {
          showToast('error', '生成超时，请到会话里查看进度');
        }
      }
    }, GENERATE_POLL_MS);
    return result;
  },
};

// 打开时预热列表与配置
let bootstrapped = false;
function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  actions.refreshReports();
  actions.loadConfig();
}


/* ==== client-src/20-icons.js ==== */
// ---------------------------------------------------------------- 图标（内联 SVG，随主题 currentColor）

function Icon({ path, size = 16, fill = 'none', viewBox = '0 0 24 24', strokeWidth = 1.7 }) {
  return h(
    'svg',
    { width: size, height: size, viewBox, fill, 'aria-hidden': true, focusable: 'false' },
    ...(Array.isArray(path) ? path : [path]).map((d, index) =>
      typeof d === 'string'
        ? h('path', { key: index, d, stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' })
        : h('path', { key: index, ...d, stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ),
  );
}

function ReportGlyph(props) {
  return h(Icon, {
    ...props,
    path: [
      'M7 3.75h7.2L18 7.55v12.7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z',
      'M14 4v4h4',
      'M9 12.2h6M9 15.2h6M9 18.2h3.6',
    ],
  });
}

function StatsGlyph(props) {
  return h(Icon, {
    ...props,
    path: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  });
}

function SyncGlyph(props) {
  return h(Icon, {
    ...props,
    path: ['M20 12a8 8 0 0 1-13.6 5.7', 'M4 12a8 8 0 0 1 13.6-5.7', 'M17 3v4h-4', 'M7 21v-4h4'],
  });
}

function PlusGlyph(props) {
  return h(Icon, { ...props, path: ['M12 5v14', 'M5 12h14'] });
}

function SearchGlyph(props) {
  return h(Icon, { ...props, path: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M21 21l-4.35-4.35'] });
}

function TrashGlyph(props) {
  return h(Icon, { ...props, path: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 13h10l1-13', 'M10 11v6M14 11v6'] });
}

function DownloadGlyph(props) {
  return h(Icon, { ...props, path: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'] });
}

function RefreshGlyph(props) {
  return h(Icon, { ...props, path: ['M20 11a8 8 0 1 0-2.3 6.3', 'M20 4v7h-7'] });
}

function CloseGlyph(props) {
  return h(Icon, { ...props, path: ['M5 5l14 14', 'M19 5L5 19'] });
}

function ChevronGlyph(props) {
  return h(Icon, { ...props, path: ['M9 6l6 6-6 6'] });
}

function SettingsGlyph(props) {
  return h(Icon, {
    ...props,
    path: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.1.37.32.72.6 1 .32.27.71.4 1.1.4H21a2 2 0 1 1 0 4h-.09c-.39 0-.78.13-1.1.4-.28.28-.5.63-.6 1Z'],
  });
}

function CheckGlyph(props) {
  return h(Icon, { ...props, path: ['M5 12.5l4.5 4.5L19 7'] });
}

function FolderGlyph(props) {
  return h(Icon, { ...props, path: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'] });
}

function DocGlyph(props) {
  return h(Icon, { ...props, path: ['M7 3.75h7.2L18 7.55v12.7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z', 'M14 4v4h4'] });
}


/* ==== client-src/30-primitives.js ==== */
// ---------------------------------------------------------------- 基础组件

addClientCSS(`
.dsr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.dsr-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-btn:disabled { opacity: .5; cursor: default; }
.dsr-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.dsr-btn.primary:hover { filter: brightness(1.06); }
.dsr-btn.ghost { border-color: transparent; background: transparent; }
.dsr-btn.ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-btn.danger { color: var(--dsw-alias-state-error-primary); }
.dsr-btn.sm { height: 26px; padding: 0 9px; font-size: 12px; }

.dsr-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: 0; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsr-iconbtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsr-iconbtn.sm { width: 22px; height: 22px; border-radius: 6px; }

.dsr-input, .dsr-select, .dsr-textarea {
  width: 100%; box-sizing: border-box; padding: 7px 10px; font: inherit; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
}
.dsr-input:focus, .dsr-select:focus, .dsr-textarea:focus {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px;
}
.dsr-textarea { min-height: 120px; resize: vertical; line-height: 1.6; }
.dsr-field { display: flex; flex-direction: column; gap: 5px; }
.dsr-fieldLabel { font-size: 12px; font-weight: 600; }
.dsr-fieldHint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }

.dsr-tabs { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsr-tab {
  position: relative; height: 34px; padding: 0 12px; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px; cursor: pointer;
}
.dsr-tab:hover { color: var(--dsw-alias-label-primary); }
.dsr-tab.active { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsr-tab.active::after {
  content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px;
  border-radius: 2px; background: var(--dsw-alias-brand-primary);
}

.dsr-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px;
  border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsr-badge.ok { color: var(--dsw-alias-state-success-primary); }
.dsr-badge.warn { color: var(--dsw-alias-state-warn-primary); }
.dsr-badge.bad { color: var(--dsw-alias-state-error-primary); }

.dsr-dialogMask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .28); z-index: 10;
}
.dsr-dialog {
  width: min(560px, calc(100% - 48px)); max-height: calc(100% - 64px); overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: 0 18px 60px rgba(0, 0, 0, .3);
  display: flex; flex-direction: column;
}
.dsr-dialogHead {
  display: flex; align-items: center; gap: 8px; padding: 14px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsr-dialogTitle { font-size: 13px; font-weight: 600; flex: 1; }
.dsr-dialogBody { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsr-dialogFoot {
  display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.dsr-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
  animation: dsr-spin .8s linear infinite;
}
@keyframes dsr-spin { to { transform: rotate(360deg); } }

.dsr-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 40px 16px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; text-align: center;
}
.dsr-empty .title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }

.dsr-toast {
  position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%);
  padding: 9px 14px; border-radius: 10px; font-size: 12.5px; z-index: 30;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
}
.dsr-toast.ok { border-color: var(--dsw-alias-state-success-primary); }
.dsr-toast.error { border-color: var(--dsw-alias-state-error-primary); }

.dsr-section { display: flex; flex-direction: column; gap: 10px; }
.dsr-sectionHead { display: flex; align-items: center; gap: 8px; }
.dsr-sectionTitle { font-size: 12.5px; font-weight: 600; }
.dsr-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.6; margin: 0; }
.dsr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dsr-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
`);

function Button({ children, variant = 'default', size, onClick, disabled, title, type = 'button' }) {
  const className = ['dsr-btn', variant !== 'default' ? variant : '', size === 'sm' ? 'sm' : ''].filter(Boolean).join(' ');
  return h('button', { type, className, onClick, disabled, title }, children);
}

function IconButton({ children, onClick, title, disabled, size }) {
  return h('button', { type: 'button', className: `dsr-iconbtn${size === 'sm' ? ' sm' : ''}`, onClick, title, disabled, 'aria-label': title }, children);
}

function Input(props) {
  return h('input', { ...props, className: `dsr-input${props.className ? ` ${props.className}` : ''}` });
}

function Textarea(props) {
  return h('textarea', { ...props, className: `dsr-textarea${props.className ? ` ${props.className}` : ''}` });
}

function Select({ options, value, onChange, disabled, id }) {
  return h(
    'select',
    { id, className: 'dsr-select', value, onChange: (event) => onChange?.(event.target.value), disabled },
    ...options.map((option) =>
      h('option', { key: option.value, value: option.value }, option.label ?? option.value),
    ),
  );
}

function Field({ label, hint, children, invalid }) {
  return h(
    'label',
    { className: 'dsr-field' },
    label ? h('span', { className: 'dsr-fieldLabel' }, label) : null,
    children,
    hint ? h('span', { className: `dsr-fieldHint${invalid ? ' dsr-error' : ''}` }, hint) : null,
  );
}

function Tabs({ items, value, onChange }) {
  return h(
    'div',
    { className: 'dsr-tabs', role: 'tablist' },
    ...items.map((item) =>
      h(
        'button',
        {
          key: item.value,
          type: 'button',
          role: 'tab',
          'aria-selected': item.value === value,
          className: `dsr-tab${item.value === value ? ' active' : ''}`,
          onClick: () => onChange?.(item.value),
        },
        item.label,
      ),
    ),
  );
}

function Badge({ children, tone }) {
  return h('span', { className: `dsr-badge${tone ? ` ${tone}` : ''}` }, children);
}

function Spinner() {
  return h('span', { className: 'dsr-spinner', role: 'status', 'aria-label': 'loading' });
}

function EmptyState({ title, hint, action }) {
  return h('div', { className: 'dsr-empty' }, title ? h('div', { className: 'title' }, title) : null, hint ? h('div', null, hint) : null, action || null);
}

function Dialog({ title, children, footer, onClose, width }) {
  return h(
    'div',
    { className: 'dsr-dialogMask', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.(); } },
    h(
      'div',
      { className: 'dsr-dialog', role: 'dialog', 'aria-modal': 'true', style: width ? { width } : undefined },
      h('div', { className: 'dsr-dialogHead' }, h('div', { className: 'dsr-dialogTitle' }, title), h(IconButton, { onClick: onClose, title: '关闭' }, h(CloseGlyph, { size: 14 }))),
      h('div', { className: 'dsr-dialogBody' }, children),
      footer ? h('div', { className: 'dsr-dialogFoot' }, footer) : null,
    ),
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return h('div', { className: `dsr-toast ${toast.kind === 'error' ? 'error' : 'ok'}`, role: 'status' }, toast.text);
}


/* ==== client-src/40-markdown.js ==== */
// ---------------------------------------------------------------- 轻量 Markdown 渲染
// 只依赖 React 元素构造，不注入 HTML（XSS 安全）。支持：
// 标题、段落、列表、引用、围栏代码块、表格、水平线、行内加粗/斜体/代码/链接。

addClientCSS(`
.dsr-md { font-size: 13px; line-height: 1.75; color: var(--dsw-alias-label-primary); word-break: break-word; }
.dsr-md h1, .dsr-md h2, .dsr-md h3, .dsr-md h4 { margin: 18px 0 8px; line-height: 1.4; }
.dsr-md h1 { font-size: 20px; }
.dsr-md h2 { font-size: 17px; }
.dsr-md h3 { font-size: 15px; }
.dsr-md h4 { font-size: 13.5px; }
.dsr-md p { margin: 8px 0; }
.dsr-md ul, .dsr-md ol { margin: 8px 0; padding-left: 22px; }
.dsr-md li { margin: 3px 0; }
.dsr-md blockquote {
  margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 0 8px 8px 0;
}
.dsr-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2); border-radius: 5px; padding: 1px 5px;
}
.dsr-md pre {
  margin: 10px 0; padding: 12px 14px; overflow: auto; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.dsr-md pre code { background: transparent; padding: 0; font-size: 12px; line-height: 1.6; }
.dsr-md table { border-collapse: collapse; margin: 10px 0; font-size: 12.5px; }
.dsr-md th, .dsr-md td { border: 1px solid var(--dsw-alias-border-l2); padding: 6px 10px; text-align: left; }
.dsr-md th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.dsr-md hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 16px 0; }
.dsr-md a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsr-md a:hover { text-decoration: underline; }
.dsr-md .dsr-codeLang {
  display: block; margin-bottom: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary);
}
`);

/** 行内解析：**bold** / *italic* / `code` / [text](url) */
function renderInline(text, keyPrefix) {
  const nodes = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\((?:[^)]+)\))/g;
  let lastIndex = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(h('strong', { key: `${keyPrefix}-b${index}` }, token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      nodes.push(h('code', { key: `${keyPrefix}-c${index}` }, token.slice(1, -1)));
    } else if (token.startsWith('*')) {
      nodes.push(h('em', { key: `${keyPrefix}-i${index}` }, token.slice(1, -1)));
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          h('a', { key: `${keyPrefix}-a${index}`, href: linkMatch[2], target: '_blank', rel: 'noreferrer noopener' }, linkMatch[1]),
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
    index += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** 多行文本内的换行处理 */
function renderInlineBlock(lines, keyPrefix) {
  const nodes = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) nodes.push(h('br', { key: `${keyPrefix}-br${lineIndex}` }));
    nodes.push(...renderInline(line, `${keyPrefix}-l${lineIndex}`));
  });
  return nodes;
}

function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    // 围栏代码块
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过结束围栏
      blocks.push(
        h(
          'pre',
          { key: `pre-${key++}` },
          language ? h('span', { className: 'dsr-codeLang' }, language) : null,
          h('code', null, codeLines.join('\n')),
        ),
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      blocks.push(h(`h${level}`, { key: `h-${key++}` }, ...renderInline(heading[2], `h${key}`)));
      index += 1;
      continue;
    }

    // 水平线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(h('hr', { key: `hr-${key++}` }));
      index += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(h('blockquote', { key: `q-${key++}` }, renderInlineBlock(quoteLines, `q${key}`)));
      continue;
    }

    // 表格
    if (/^\|.*\|$/.test(trimmed) && index + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[index + 1].trim())) {
      const headerCells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
      index += 2;
      const rows = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        rows.push(lines[index].trim().slice(1, -1).split('|').map((cell) => cell.trim()));
        index += 1;
      }
      blocks.push(
        h(
          'table',
          { key: `t-${key++}` },
          h('thead', null, h('tr', null, ...headerCells.map((cell, cellIndex) => h('th', { key: cellIndex }, ...renderInline(cell, `th${cellIndex}`))))),
          h('tbody', null, ...rows.map((row, rowIndex) =>
            h('tr', { key: rowIndex }, ...row.map((cell, cellIndex) => h('td', { key: cellIndex }, ...renderInline(cell, `td${rowIndex}-${cellIndex}`)))),
          )),
        ),
      );
      continue;
    }

    // 列表
    if (/^([-*+]\s+|\d+[.)]\s+)/.test(trimmed)) {
      const ordered = /^\d+[.)]\s+/.test(trimmed);
      const items = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = /^([-*+]\s+|\d+[.)]\s+)(.*)$/.exec(current);
        if (!match) break;
        items.push(match[2]);
        index += 1;
      }
      const listChildren = items.map((item, itemIndex) =>
        h('li', { key: itemIndex }, ...renderInline(item, `li${key}-${itemIndex}`)),
      );
      blocks.push(ordered ? h('ol', { key: `ol-${key++}` }, ...listChildren) : h('ul', { key: `ul-${key++}` }, ...listChildren));
      continue;
    }

    // 段落（合并连续非空行）
    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6}\s|>|```|\||[-*+]\s+|\d+[.)]\s+|(-{3,}|\*{3,}|_{3,})$)/.test(lines[index].trim())
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length) {
      blocks.push(h('p', { key: `p-${key++}` }, renderInlineBlock(paragraphLines, `p${key}`)));
    }
  }

  return blocks;
}

function Markdown({ text }) {
  return h('div', { className: 'dsr-md' }, ...renderMarkdown(text));
}


/* ==== client-src/50-tree.js ==== */
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


/* ==== client-src/60-report.js ==== */
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
      { className: 'dsr-rpt-main', 'aria-label': tx(t, 'title', '工作报告') },
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
    { className: 'dsr-rpt-main', 'aria-label': tx(t, 'title', '工作报告') },
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


/* ==== client-src/70-stats.js ==== */
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
          h('p', { className: 'dsr-stt-note' }, tr('syncDialogHint', '窗口默认等于当前统计范围；仓库范围在 设置 → 工作报告 → 同步仓库范围 维护。')),
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


/* ==== client-src/80-sync.js ==== */
// ---------------------------------------------------------------- 统计/同步页 + 设置页
//
// 组件契约（CONTRACTS.md §7.1）：
//   SyncPage({ t, state, actions })      工作台「统计」区域整页。
//   SettingsPage({ t, state, actions })  工作台「设置」区域整页。
//     t       : ctx.locale.bind('dshReport')；缺 key 用 tx(t, key, '中文兜底') 回退。
//     state   : 10-store 的共享状态（本文件只读 state.config 作为初值，其余自管）。
//     actions : 10-store 的 actions；用 loadConfig/saveConfig/loadTemplates/saveTemplates
//               （缺失时回退到直接 api.get/put）。
//
// 数据面（同源 /plugins/dsh-report/api，经 10-store 的 api；失败抛 Error）：
//   GET  /config                        → { dataDir, timezone, defaultReportType, gitlab:{ baseUrl, tokenRef, hasToken } }
//   PUT  /config                        ← { gitlab?:{ baseUrl, token? }, timezone?, defaultReportType? }
//   GET  /gitlab/connections            → { connections:[{ id, baseUrl, displayName, username, hasToken }] }
//   POST /gitlab/connections            ← { baseUrl, token }  （幂等 upsert + 校验；仅在有新 token 时调用）
//   GET  /gitlab/projects?connectionId&q&refresh → { projects:[{ id, pathWithNamespace, name }] }
//   GET  /gitlab/selection?connectionId → { projects:[{ id, pathWithNamespace, name, enabled }] }
//   PUT  /gitlab/selection              ← { connectionId, projects:[{ id, pathWithNamespace, name }] }
//   GET  /sync/coverage?connectionId&startDate&endDate → { summary:{commits,additions,deletions,days,repos}, repos:[], dateDistribution:[] }
//   GET  /sync/jobs?limit               → { jobs:[{ jobId, connectionId, startDate, endDate, status, startedAt, finishedAt, progress:{projectsDone,projectsTotal,commitsSynced,currentProject}, error }] }
//   POST /sync/start                    ← { connectionId, startDate, endDate, projectIds? } → { jobId }
//   POST /sync/cancel                   ← { jobId } → { cancelled }
//   GET  /templates                     → { templates:{week,month,quarter,year}, guidance:{...} }
//   PUT  /templates                     ← 同上（部分更新：空串=清除覆盖回退默认，省略键=不动）
//
// 行为边界：每区块独立加载/独立错误条（连接、仓库范围、窗口+覆盖度、任务历史互不阻塞）；
// 同步启动后每 2s 轮询 /sync/jobs，最长 30 分钟；Token 不回显、只显示 hasToken。
// 字段同时兼容 camelCase / snake_case；任务窗口缺失时回退 connectionId。
//
// 依赖（同 factory 作用域，勿在本文件重复声明）：h/React（00-header）、api/showToast/
// fmtInt/fmtDate/fmtDateTime/reportTypeLabel（10-store）、SyncGlyph/ReportGlyph/StatsGlyph/
// SettingsGlyph（20-icons）、Button/Input/Textarea/Select/Field/Tabs/Badge/EmptyState（30-primitives）、
// tx（99-apply）。

addClientCSS(`
.dsr-connList { display: flex; flex-direction: column; gap: 6px; }
.dsr-scopeConns { display: flex; flex-wrap: wrap; gap: 6px; }
.dsr-scopeConn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; }
.dsr-scopeConn.is-on { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsr-scopeConnDot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-border-l2); }
.dsr-scopeConn.is-on .dsr-scopeConnDot { background: var(--dsw-alias-status-success, #22c55e); }
.dsr-scopeConnWarn { font-size: 10px; color: var(--dsw-alias-status-warning, #d97706); }
.dsr-connRow {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-3);
}
.dsr-connMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dsr-connName { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsr-connUrl { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-connUser { font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dsr-connActions { display: flex; gap: 6px; margin-left: auto; }
.dsr-connForm { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l4); }
.dsr-syncScopeBar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l4);
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.dsr-syncScopeText { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsr-syncScopeBarWarn .dsr-syncScopeText { color: var(--dsw-alias-status-warning, var(--dsw-alias-label-primary)); }
.dsr-syncScopeHint { color: var(--dsw-alias-label-secondary); }
.dsr-syncScopeActions { margin-left: auto; display: flex; gap: 6px; }
.dsr-syncSectionHead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.dsr-syncSectionTitle { font-size: 13px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.dsr-sync, .dsr-settings { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 22px; max-width: 1080px; }
.dsr-pageIntro { display: flex; flex-direction: column; gap: 3px; }
.dsr-pageTitle { font-size: 14px; font-weight: 600; }
.dsr-pageHint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.6; margin: 0; }

.dsr-syncCard {
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3); overflow: hidden;
}
.dsr-syncCardHead { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsr-syncCardTitle { display: inline-flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 600; line-height: 1.4; }
.dsr-syncCardBody { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsr-formGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; align-items: start; }
.dsr-formGrid .dsr-field { min-width: 0; }
.dsr-btnRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-inlineMeta { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.dsr-errorBar {
  display: flex; align-items: flex-start; gap: 7px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  font-size: 11.5px; line-height: 1.55; word-break: break-word;
}
.dsr-noticeBar {
  display: flex; align-items: center; gap: 7px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); font-size: 11.5px;
}

.dsr-checkList {
  max-height: 260px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; background: var(--dsw-alias-bg-base);
}
.dsr-checkRow { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.dsr-checkRow:last-child { border-bottom: 0; }
.dsr-checkRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dsr-check { width: 13px; height: 13px; margin: 0; accent-color: var(--dsw-alias-brand-primary); flex: none; }
.dsr-checkName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-checkNs { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dsr-progressRow { display: flex; flex-direction: column; gap: 6px; }
.dsr-progressHead { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsr-progressTrack { height: 8px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
.dsr-progressFill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
.dsr-progressFill.done { background: var(--dsw-alias-state-success-primary); }
.dsr-progressFill.bad { background: var(--dsw-alias-state-error-primary); }
.dsr-kvGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
.dsr-kv { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dsr-kvLabel { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsr-kvValue { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

.dsr-tplTabs { display: flex; flex-wrap: wrap; gap: 6px; }
.dsr-tplGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.dsr-tplNote { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.55; }
.dsr-rowBetween { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
`);

// ---------------------------------------------------------------- 小工具（本文件私有，sy* 前缀避免与其它文件重名）
function syErrText(error) {
  if (!error) return '';
  const text = String((error && error.message) || error);
  return text || '未知错误';
}

function syPad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地日期 → 'YYYY-MM-DD'（不使用 toISOString，避免 UTC 偏移）。 */
function syDateString(date) {
  return `${date.getFullYear()}-${syPad2(date.getMonth() + 1)}-${syPad2(date.getDate())}`;
}

/** 本周（周一 → 周日）。 */
function syThisWeek() {
  const now = new Date();
  const weekday = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { startDate: syDateString(monday), endDate: syDateString(sunday) };
}

function syJobStatusLabel(status, t) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const map = {
    running: tr('jobRunning', '运行中'),
    completed: tr('jobCompleted', '已完成'),
    failed: tr('jobFailed', '失败'),
    cancelled: tr('jobCancelled', '已取消'),
    pending: tr('jobPending', '排队中'),
  };
  return map[status] || String(status || '—');
}

function syJobTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'running') return 'warn';
  return undefined;
}

function syProjectId(project) {
  if (!project) return '';
  const value = project.id !== undefined && project.id !== null ? project.id : project.projectId;
  return value === undefined || value === null ? '' : String(value);
}

function syProjectName(project) {
  if (!project) return '';
  return String(project.pathWithNamespace || project.path_with_namespace || project.name || '');
}

/**
 * 任务窗口：`startDate`/`endDate`（兼容 snake_case `start_date`/`end_date`）→ `YYYY/MM/DD → YYYY/MM/DD`。
 * 缺失（旧任务或缺字段）返回空串，由调用方回退到 connectionId。
 */
function syJobWindow(job) {
  if (!job) return '';
  const start = String(job.startDate || job.start_date || '').trim();
  const end = String(job.endDate || job.end_date || '').trim();
  if (start && end) return `${fmtDate(start)} → ${fmtDate(end)}`;
  if (start || end) return fmtDate(start || end);
  return '';
}

/** 区块统一外壳。 */
/**
 * 把 pathWithNamespace 构建成「命名空间树」：根节点（group）→ 子命名空间 → 仓库。
 * 与 workbench GitLabProjectPicker 的分组口径一致（按 / 分段）。
 */
function syBuildProjectTree(projects) {
  const root = { key: '', label: '', projects: [], children: new Map() };
  for (const project of projects) {
    const path = syProjectName(project);
    const parts = path.split('/').filter(Boolean);
    const namespaces = parts.length > 1 ? parts.slice(0, -1) : [];
    let node = root;
    for (const part of namespaces) {
      if (!node.children.has(part)) {
        node.children.set(part, { key: node.key ? `${node.key}/${part}` : part, label: part, projects: [], children: new Map() });
      }
      node = node.children.get(part);
    }
    node.projects.push(project);
  }
  const materialize = (node) => ({
    key: node.key,
    label: node.label,
    projects: node.projects,
    children: [...node.children.values()].map(materialize),
  });
  return [...root.children.values()].map(materialize);
}

function syProjectConnectionId(project) {
  if (!project) return '';
  return String(project.connectionId || project.connection_id || '');
}

/** 跨连接唯一 key：connectionId:projectId。 */
function syProjectKey(project) {
  const id = syProjectId(project);
  if (!id) return '';
  const connectionId = syProjectConnectionId(project);
  return connectionId ? `${connectionId}:${id}` : id;
}

function syPrefixTreeKeys(nodes, prefix) {
  for (const node of nodes) {
    node.key = prefix ? `${prefix}:${node.key}` : node.key;
    syPrefixTreeKeys(node.children, prefix);
  }
  return nodes;
}

/** 多连接树：连接 → 命名空间 → 仓库（与 workbench 的 connection 根一致）。 */
function syBuildConnectionTree(projects, connections) {
  const byConnection = new Map();
  for (const project of projects) {
    const connectionId = syProjectConnectionId(project);
    if (!byConnection.has(connectionId)) byConnection.set(connectionId, []);
    byConnection.get(connectionId).push(project);
  }
  const labelOf = (connectionId) => {
    const found = (connections || []).find((item) => String(item.id) === String(connectionId));
    return (found && (found.displayName || found.username || found.baseUrl)) || connectionId || '未命名连接';
  };
  return Array.from(byConnection.entries())
    .sort(([left], [right]) => labelOf(left).localeCompare(labelOf(right), 'zh-CN'))
    .map(([connectionId, items]) => {
      const children = syPrefixTreeKeys(syBuildProjectTree(items), connectionId);
      return {
        type: 'connection',
        connectionId,
        key: `conn:${connectionId}`,
        label: labelOf(connectionId),
        projects: [],
        children,
      };
    });
}

function syCollectProjects(node) {
  const out = [...node.projects];
  for (const child of node.children) out.push(...syCollectProjects(child));
  return out;
}

function ProjectTriCheckbox({ checked, indeterminate, onChange, label, count }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return h(
    'label',
    { className: 'dsr-repoCheck' },
    h('input', { ref, type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
    h('span', { className: 'dsr-repoLabel' }, label),
    count !== undefined ? h('span', { className: 'dsr-repoCount' }, count) : null,
  );
}

function ProjectTree({ t, nodes, selected, collapsed, onToggleGroup, onToggleProject }) {
  return nodes.map((node) =>
    h(ProjectTreeNode, { key: node.key, t, node, selected, collapsed, onToggleGroup, onToggleProject }),
  );
}

function ProjectTreeNode({ t, node, selected, collapsed, onToggleGroup, onToggleProject }) {
  const all = syCollectProjects(node);
  const selectedCount = all.filter((project) => selected[syProjectKey(project)]).length;
  const checked = all.length > 0 && selectedCount === all.length;
  const indeterminate = selectedCount > 0 && !checked;
  const open = !collapsed[node.key];
  return h(
    'div',
    { className: 'dsr-repoGroup' },
    h(
      'div',
      { className: 'dsr-repoGroupHead' },
      h(
        'button',
        { type: 'button', className: 'dsr-repoToggle', 'aria-expanded': open, onClick: () => onToggleGroup(node.key) },
        h('span', { style: { display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(ChevronGlyph, { size: 13 })),
      ),
      h('span', { className: 'dsr-repoFolder' }, h(FolderGlyph, { size: 13 })),
      h(ProjectTriCheckbox, {
        checked,
        indeterminate,
        label: node.label,
        count: `${selectedCount}/${all.length}`,
        onChange: (value) => onToggleGroup(node.key, value),
      }),
    ),
    open
      ? h(
          'div',
          { className: 'dsr-repoChildren' },
          ...node.projects.map((project) => {
            const id = syProjectKey(project);
            const path = syProjectName(project);
            return h(
              'label',
              { className: 'dsr-repoRow', key: id || path },
              h(SyncCheckbox, {
                checked: Boolean(selected[id]),
                onChange: () => onToggleProject(project),
                label: '',
              }),
              h('span', { className: 'dsr-repoName' }, path.split('/').pop() || path || id),
              h('span', { className: 'dsr-repoPath' }, path),
            );
          }),
          ...node.children.map((child) =>
            h(ProjectTreeNode, { key: child.key, t, node: child, selected, collapsed, onToggleGroup, onToggleProject }),
          ),
        )
      : null,
  );
}

function SyncCard({ title, icon, aside, children, hint }) {
  return h(
    'section',
    { className: 'dsr-syncCard' },
    h(
      'div',
      { className: 'dsr-syncCardHead' },
      h('div', { className: 'dsr-syncCardTitle' }, icon ? h(icon, { size: 15 }) : null, title),
      h('div', { className: 'dsr-spacer' }),
      aside || null,
    ),
    h('div', { className: 'dsr-syncCardBody' }, hint ? h('p', { className: 'dsr-pageHint' }, hint) : null, children),
  );
}

function SyncErrorBar({ children }) {
  if (!children) return null;
  return h('div', { className: 'dsr-errorBar', role: 'alert' }, children);
}

function SyncNoticeBar({ children }) {
  if (!children) return null;
  return h('div', { className: 'dsr-noticeBar', role: 'status' }, children);
}

function SyncCheckbox({ checked, onChange, label }) {
  return h('input', { type: 'checkbox', className: 'dsr-check', checked: Boolean(checked), onChange, 'aria-label': label });
}

// ---------------------------------------------------------------- 连接区块（同步页 / 设置页共用）
/**
 * GitLab 连接：回填 baseUrl、保存到 PUT /config，并尽量验证 token。
 * 契约：PUT /config { gitlab: { baseUrl, token } }；POST /gitlab/connections 为可选的验证/注册。
 */
function SyncConnectionCard(props) {
  const { t, actions } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);

  const [connections, setConnections] = React.useState([]);
  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [confirmId, setConfirmId] = React.useState('');
  const [alias, setAlias] = React.useState('');
  const [renameId, setRenameId] = React.useState('');
  const [renameDraft, setRenameDraft] = React.useState('');

  const notifyChanged = () => {
    try {
      window.dispatchEvent(new CustomEvent('dsh-report:connections-changed'));
    } catch {
      /* 忽略 */
    }
  };

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [listData, cfg] = await Promise.all([
        api.get('/gitlab/connections'),
        actions && typeof actions.loadConfig === 'function' ? actions.loadConfig() : api.get('/config'),
      ]);
      const list = Array.isArray(listData && listData.connections) ? listData.connections : [];
      setConnections(list);
      setConfig(cfg || null);
      if (!list.length) setFormOpen(true);
    } catch (loadError) {
      setError(syErrText(loadError));
    } finally {
      setLoading(false);
    }
  }, [actions]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const openAdd = () => {
    setEditingId('');
    setBaseUrl('');
    setToken('');
    setAlias('');
    setFormOpen(true);
    setError('');
    setNotice('');
    setConfirmId('');
    setRenameId('');
  };

  const openToken = (connection) => {
    setEditingId(String(connection.id || ''));
    setBaseUrl(String(connection.baseUrl || ''));
    setToken('');
    setFormOpen(true);
    setError('');
    setNotice('');
    setConfirmId('');
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId('');
    setBaseUrl('');
    setToken('');
    setAlias('');
  };

  const save = async () => {
    const nextBaseUrl = baseUrl.trim();
    const nextToken = token.trim();
    if (!nextBaseUrl) {
      setError(tr('baseUrlRequired', '请填写 GitLab 地址'));
      return;
    }
    if (!nextToken && !editingId) {
      setError(tr('tokenRequired', '新连接需要填写 Access Token'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = { baseUrl: nextBaseUrl };
      const nextAlias = alias.trim();
      if (nextAlias) payload.name = nextAlias;
      if (nextToken) payload.token = nextToken;
      const result = await api.post('/gitlab/connections', payload);
      const connection = (result && result.connection) || {};
      setNotice(
        nextToken
          ? `${tr('connectionSaved', '连接已保存')} · ${connection.username || connection.baseUrl || nextBaseUrl}`
          : tr('connectionExists', '连接已存在；要更新 Token 请填写新 Token'),
      );
      setToken('');
      closeForm();
      await reload();
      notifyChanged();
      if (typeof props.onSaved === 'function') props.onSaved();
      if (nextToken) showToast('ok', tr('saved', '已保存'));
    } catch (saveError) {
      setError(syErrText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (connection) => {
    const id = String(connection.id || '');
    if (!id) return;
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.del(`/gitlab/connections/${encodeURIComponent(id)}`);
      setConfirmId('');
      setNotice(tr('connectionRemoved', '连接已删除（本地已同步的提交仍保留）'));
      await reload();
      notifyChanged();
      if (typeof props.onSaved === 'function') props.onSaved();
      showToast('ok', tr('deleted', '已删除'));
    } catch (removeError) {
      setError(syErrText(removeError));
    } finally {
      setBusy(false);
    }
  };

  const startRename = (connection) => {
    setRenameId(String(connection.id || ''));
    setRenameDraft(String(connection.displayName || connection.username || ''));
    setError('');
    setNotice('');
  };

  const saveRename = async (connection) => {
    const id = String(connection.id || '');
    const name = renameDraft.trim();
    if (!id) return;
    if (!name) {
      setError(tr('aliasRequired', '连接名称不能为空'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/gitlab/connections/${encodeURIComponent(id)}`, { name });
      setRenameId('');
      setRenameDraft('');
      setNotice(tr('aliasSaved', '连接名称已更新'));
      await reload();
      notifyChanged();
      if (typeof props.onSaved === 'function') props.onSaved();
      showToast('ok', tr('saved', '已保存'));
    } catch (renameError) {
      setError(syErrText(renameError));
    } finally {
      setBusy(false);
    }
  };

  const hasAnyToken = connections.some((item) => item.hasToken);

  return h(
    SyncCard,
    {
      title: tr('gitlabConnections', 'GitLab 连接'),
      icon: SyncGlyph,
      aside: h(
        'span',
        { className: 'dsr-inlineMeta' },
        h(Badge, { tone: connections.length ? 'ok' : 'warn' }, `${tr('connectionCount', '连接')} ${connections.length}`),
        h(Badge, { tone: hasAnyToken ? 'ok' : 'warn' }, hasAnyToken ? tr('tokenSaved', 'Token 已保存') : tr('tokenMissing', '未保存 Token')),
      ),
      hint: tr('connectionsHint', '可添加多个 GitLab 实例/账号；每个连接各自保存 Token，Token 存本机凭据库，不写明文配置。'),
    },
    loading ? h('p', { className: 'dsr-hint' }, tr('loading', '加载中…')) : null,
    connections.length
      ? h(
          'div',
          { className: 'dsr-connList' },
          ...connections.map((connection) =>
            h(
              'div',
              { className: 'dsr-connRow', key: String(connection.id || connection.baseUrl) },
              h(
                'div',
                { className: 'dsr-connMain' },
                renameId === String(connection.id)
                  ? h(Input, {
                      value: renameDraft,
                      placeholder: tr('aliasPlaceholder', '连接名称，例如：公司主账号'),
                      onChange: (event) => setRenameDraft(event.target.value),
                      spellCheck: false,
                    })
                  : h('span', { className: 'dsr-connName' }, connection.displayName || connection.username || connection.baseUrl || connection.id),
                h('span', { className: 'dsr-connUrl' }, connection.baseUrl || '—'),
                connection.username ? h('span', { className: 'dsr-connUser' }, `@${connection.username}`) : null,
              ),
              h(Badge, { tone: connection.hasToken ? 'ok' : 'warn' }, connection.hasToken ? tr('tokenSaved', 'Token 已保存') : tr('tokenMissing', '未保存 Token')),
              h(
                'span',
                { className: 'dsr-connActions' },
                renameId === String(connection.id)
                  ? h(Button, { size: 'sm', variant: 'primary', onClick: () => saveRename(connection), disabled: busy }, tr('save', '保存'))
                  : h(Button, { size: 'sm', onClick: () => startRename(connection), disabled: busy }, tr('renameConnection', '改名')),
                renameId === String(connection.id)
                  ? h(Button, { size: 'sm', onClick: () => setRenameId(''), disabled: busy }, tr('cancel', '取消'))
                  : h(Button, { size: 'sm', onClick: () => openToken(connection), disabled: busy }, tr('updateToken', '更新 Token')),
                renameId === String(connection.id)
                  ? null
                  : h(
                      Button,
                      { size: 'sm', variant: confirmId === String(connection.id) ? 'danger' : undefined, onClick: () => remove(connection), disabled: busy },
                      confirmId === String(connection.id) ? tr('confirmRemove', '确认删除') : tr('removeConnection', '删除'),
                    ),
              ),
            ),
          ),
        )
      : h('p', { className: 'dsr-hint' }, tr('noConnections', '还没有 GitLab 连接；填写地址与 Token 后保存。')),

    error ? h(SyncErrorBar, null, error) : null,
    notice ? h(SyncNoticeBar, null, notice) : null,

    formOpen
      ? h(
          'div',
          { className: 'dsr-connForm' },
          h(
            'div',
            { className: 'dsr-formGrid' },
            h(Field, { label: tr('baseUrl', 'GitLab 地址'), hint: editingId ? tr('baseUrlLocked', '已有连接的地址不可改；换地址请新增连接') : undefined }, h(Input, {
              value: baseUrl,
              placeholder: 'https://gitlab.example.com',
              disabled: Boolean(editingId),
              onChange: (event) => setBaseUrl(event.target.value),
              spellCheck: false,
            })),
            h(Field, {
              label: tr('token', 'Access Token'),
              hint: editingId ? tr('tokenUpdateHint', '填写新 Token 覆盖该连接已保存的 Token') : tr('tokenNewHint', '需要 read_api 权限'),
            }, h(Input, {
              value: token,
              type: 'password',
              placeholder: editingId ? tr('tokenKeepPlaceholder', '输入新 Token') : 'glpat-…',
              onChange: (event) => setToken(event.target.value),
              autoComplete: 'off',
              spellCheck: false,
            })),
          ),
          h(
            'div',
            { className: 'dsr-btnRow' },
            h(Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? tr('saving', '保存中…') : tr('saveConnection', '保存连接')),
            h(Button, { onClick: closeForm, disabled: busy }, tr('cancel', '取消')),
          ),
        )
      : h(
          'div',
          { className: 'dsr-btnRow' },
          h(Button, { variant: 'primary', onClick: openAdd, disabled: busy }, tr('addConnection', '添加连接')),
          h(Button, { onClick: () => reload(), disabled: loading || busy }, loading ? tr('loading', '加载中…') : tr('refresh', '刷新')),
        ),

    config && config.dataDir ? h('div', { className: 'dsr-hint' }, `${tr('dataDir', '数据目录')}：${config.dataDir}`) : null,
  );
}

// ---------------------------------------------------------------- 同步仓库范围（设置页）
/** 仓库范围卡：连接选择 + 命名空间树 + 保存；同步对话框只读取已保存范围。 */
function SyncScopeCard(props) {
  const { t, actions } = props || {};
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);

  const [connections, setConnections] = React.useState([]);
  const [checked, setChecked] = React.useState({});
  const [projects, setProjects] = React.useState([]);
  const [selected, setSelected] = React.useState({});
  const [query, setQuery] = React.useState('');
  const [collapsed, setCollapsed] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  const load = React.useCallback(async (refresh) => {
    setLoading(true);
    setError('');
    try {
      const [connData] = await Promise.all([
        api.get('/gitlab/connections'),
        actions && typeof actions.loadConfig === 'function' ? actions.loadConfig() : api.get('/config').catch(() => null),
      ]);
      const list = Array.isArray(connData && connData.connections) ? connData.connections : [];
      setConnections(list);
      setChecked((current) => {
        const next = {};
        for (const connection of list) next[String(connection.id)] = current[String(connection.id)] !== false;
        return next;
      });

      const loadedProjects = [];
      const nextSelected = {};
      await Promise.all(
        list.map(async (connection) => {
          const connectionId = String(connection.id || '');
          if (!connectionId) return;
          try {
            const params = new URLSearchParams({ connectionId });
            if (refresh) params.set('refresh', '1');
            const [projectData, selectionData] = await Promise.all([
              api.get(`/gitlab/projects?${params.toString()}`),
              api.get(`/gitlab/selection?connectionId=${encodeURIComponent(connectionId)}`),
            ]);
            const rows = Array.isArray(projectData && projectData.projects) ? projectData.projects : [];
            for (const row of rows) loadedProjects.push({ ...row, connectionId });
            const selectedRows = Array.isArray(selectionData && selectionData.projects) ? selectionData.projects : [];
            for (const row of selectedRows) {
              const key = `${connectionId}:${syProjectId(row)}`;
              if (key !== ':') nextSelected[key] = true;
            }
          } catch (loadError) {
            setError(syErrText(loadError));
          }
        }),
      );
      setProjects(loadedProjects);
      setSelected(nextSelected);
    } catch (loadError) {
      setError(syErrText(loadError));
    } finally {
      setLoading(false);
    }
  }, [actions]);

  React.useEffect(() => {
    load(false);
  }, [load]);

  const shownConnections = connections.filter((connection) => checked[String(connection.id)] !== false);
  const shownConnectionIds = new Set(shownConnections.map((connection) => String(connection.id)));
  const shownProjects = projects.filter((project) => shownConnectionIds.has(syProjectConnectionId(project)));
  const filteredProjects = shownProjects.filter((project) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${syProjectName(project)} ${syProjectId(project)}`.toLowerCase().includes(needle);
  });
  const tree = syBuildConnectionTree(filteredProjects, connections);
  const selectedCount = shownProjects.filter((project) => selected[syProjectKey(project)]).length;

  const toggleConnection = (connectionId) => {
    setChecked((current) => ({ ...current, [String(connectionId)]: current[String(connectionId)] === false }));
  };
  const toggleProject = (project) => {
    const key = syProjectKey(project);
    if (!key) return;
    setSelected((current) => ({ ...current, [key]: !current[key] }));
  };
  const toggleGroup = (node, value) => {
    const items = syCollectProjects(node);
    setSelected((current) => {
      const next = { ...current };
      for (const project of items) {
        const key = syProjectKey(project);
        if (key) next[key] = Boolean(value);
      }
      return next;
    });
  };
  const toggleCollapsed = (key) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const saveSelection = React.useCallback(async () => {
    if (!shownConnections.length) {
      setError(tr('noConnectionSelected', '请至少选择一个 GitLab 连接'));
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const groups = new Map();
      for (const connection of shownConnections) groups.set(String(connection.id), []);
      for (const project of shownProjects) {
        const connectionId = syProjectConnectionId(project);
        if (!groups.has(connectionId)) continue;
        if (!selected[syProjectKey(project)]) continue;
        groups.get(connectionId).push({
          id: syProjectId(project),
          pathWithNamespace: syProjectName(project),
          name: project.name || '',
        });
      }
      const results = await Promise.all(
        Array.from(groups.entries()).map(([connectionId, rows]) =>
          api.put('/gitlab/selection', { connectionId, projects: rows }),
        ),
      );
      const total = Array.from(groups.values()).reduce((sum, rows) => sum + rows.length, 0);
      setNotice(`${tr('saved', '已保存')} · ${total} ${tr('repos', '仓库')}（${groups.size} ${tr('connections', '个连接')}）`);
      showToast('ok', tr('saved', '已保存'));
      if (typeof props.onSaved === 'function') props.onSaved();
    } catch (saveError) {
      setError(syErrText(saveError));
    } finally {
      setSaving(false);
    }
  }, [props, selected, shownConnections, shownProjects, t]);

  return h(
    SyncCard,
    {
      title: tr('syncScope', '同步仓库范围'),
      icon: ReportGlyph,
      aside: h(
        'span',
        { className: 'dsr-inlineMeta' },
        h(Badge, null, `${tr('selected', '已选')} ${selectedCount}`),
        h(Badge, null, `${tr('connections', '连接')} ${shownConnections.length}/${connections.length}`),
        h(Badge, null, `${tr('available', '可选')} ${filteredProjects.length}`),
      ),
      hint: tr('syncScopeHint', '勾选要纳入同步的 GitLab 连接，可跨连接一起选仓库；保存后同步/生成会覆盖所有已选连接。'),
    },
    connections.length
      ? h(
          'div',
          { className: 'dsr-scopeConns' },
          ...connections.map((connection) => {
            const id = String(connection.id);
            const active = checked[id] !== false;
            return h(
              'button',
              {
                key: id,
                type: 'button',
                className: `dsr-scopeConn${active ? ' is-on' : ''}`,
                'aria-pressed': active,
                onClick: () => toggleConnection(id),
              },
              h('span', { className: 'dsr-scopeConnDot' }),
              String(connection.displayName || connection.username || connection.baseUrl || id),
              connection.hasToken ? null : h('span', { className: 'dsr-scopeConnWarn' }, tr('tokenMissing', '未保存 Token')),
            );
          }),
        )
      : h('p', { className: 'dsr-hint' }, tr('noConnections', '还没有 GitLab 连接；请先在上方「GitLab 连接」里添加。')),
    h(
      'div',
      { className: 'dsr-btnRow' },
      h(Input, {
        value: query,
        placeholder: tr('projectQuery', '搜索仓库'),
        onChange: (event) => setQuery(event.target.value),
        spellCheck: false,
        style: { maxWidth: '260px' },
      }),
      h(Button, { onClick: () => load(true), disabled: loading }, loading ? tr('loading', '加载中…') : tr('refreshProjects', '刷新仓库')),
      h(Button, { onClick: () => { const next = {}; for (const project of filteredProjects) next[syProjectKey(project)] = true; setSelected((current) => ({ ...current, ...next })); } }, tr('selectAll', '全选')),
      h(Button, { onClick: () => { const next = {}; for (const project of filteredProjects) next[syProjectKey(project)] = false; setSelected((current) => ({ ...current, ...next })); } }, tr('clearAll', '清空')),
      h(Button, { variant: 'primary', onClick: saveSelection, disabled: saving || loading || !shownConnections.length }, saving ? tr('saving', '保存中…') : tr('saveSelection', '保存仓库范围')),
    ),
    error ? h(SyncErrorBar, null, error) : null,
    notice ? h(SyncNoticeBar, null, notice) : null,
    h(
      'div',
      { className: 'dsr-repoTreePicker' },
      filteredProjects.length
        ? h(ProjectTree, {
            t,
            nodes: tree,
            selected,
            collapsed,
            onToggleGroup: (key, value) => {
              const findNode = (nodes) => {
                for (const item of nodes) {
                  if (item.key === key) return item;
                  const nested = findNode(item.children);
                  if (nested) return nested;
                }
                return null;
              };
              const node = findNode(tree);
              if (!node) return;
              if (value === undefined) toggleCollapsed(key);
              else toggleGroup(node, value);
            },
            onToggleProject: toggleProject,
          })
        : h(EmptyState, {
            title: loading ? tr('loading', '加载中…') : tr('noProjects', '没有可选仓库'),
            hint: connections.length ? tr('noProjectsHint', '点击「刷新仓库」从 GitLab 拉取成员项目') : tr('noConnections', '请先添加 GitLab 连接'),
          }),
    ),
  );
}

// ---------------------------------------------------------------- 同步页
function SyncPage({ t, state, actions, embedded, initialStartDate, initialEndDate }) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);
  const week = React.useMemo(() => syThisWeek(), []);

  const [connectionId, setConnectionId] = React.useState('');
  const [connections, setConnections] = React.useState([]);
  const [connError, setConnError] = React.useState('');
  const [connLoading, setConnLoading] = React.useState(false);

  const [scope, setScope] = React.useState({ total: 0, connections: [], names: [] });

  const initialRange = (() => {
    const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    if (isDate(initialStartDate) && isDate(initialEndDate)) {
      return { startDate: String(initialStartDate), endDate: String(initialEndDate) };
    }
    return week;
  })();
  const [startDate, setStartDate] = React.useState(initialRange.startDate);
  const [endDate, setEndDate] = React.useState(initialRange.endDate);
  const [coverage, setCoverage] = React.useState(null);
  const [coverageLoading, setCoverageLoading] = React.useState(false);
  const [coverageError, setCoverageError] = React.useState('');

  const [job, setJob] = React.useState(null);
  const [jobs, setJobs] = React.useState([]);
  const [syncError, setSyncError] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [polling, setPolling] = React.useState(false);
  const startedAtRef = React.useRef(0);

  const loadConnections = React.useCallback(async () => {
    setConnLoading(true);
    setConnError('');
    try {
      const data = await api.get('/gitlab/connections');
      const list = Array.isArray(data && data.connections) ? data.connections : [];
      setConnections(list);
      setConnectionId((current) => {
        if (current && list.some((item) => String(item.id) === String(current))) return current;
        return list.length ? String(list[0].id) : current;
      });
    } catch (error) {
      setConnError(syErrText(error));
    } finally {
      setConnLoading(false);
    }
  }, []);

  const loadJobs = React.useCallback(async () => {
    try {
      const data = await api.get('/sync/jobs?limit=20');
      const list = Array.isArray(data && data.jobs) ? data.jobs : [];
      setJobs(list);
      return list;
    } catch (error) {
      setSyncError(syErrText(error));
      return [];
    }
  }, []);

  /** 读取所有连接的已保存范围（多连接同步时一起用）。 */
  const loadScopes = React.useCallback(async () => {
    try {
      const data = await api.get('/gitlab/connections');
      const list = Array.isArray(data && data.connections) ? data.connections : [];
      const rows = await Promise.all(
        list.map(async (connection) => {
          const id = String(connection.id || '');
          try {
            const selectionData = await api.get(`/gitlab/selection?connectionId=${encodeURIComponent(id)}`);
            const projects = Array.isArray(selectionData && selectionData.projects) ? selectionData.projects : [];
            return {
              id,
              name: String(connection.displayName || connection.username || connection.baseUrl || id),
              count: projects.length,
              names: projects.map((item) => syProjectName(item)).filter(Boolean),
            };
          } catch {
            return { id, name: String(connection.displayName || connection.baseUrl || id), count: 0, names: [] };
          }
        }),
      );
      const active = rows.filter((row) => row.count > 0);
      setScope({
        total: active.reduce((sum, row) => sum + row.count, 0),
        connections: active,
        names: active.flatMap((row) => row.names),
      });
    } catch (error) {
      setSyncError(syErrText(error));
    }
  }, []);

  const loadCoverage = React.useCallback(async () => {
    if (!connections.length || !startDate || !endDate) return;
    setCoverageLoading(true);
    setCoverageError('');
    try {
      const params = new URLSearchParams({ startDate, endDate });
      const data = await api.get(`/sync/coverage?${params.toString()}`);
      setCoverage(data || null);
    } catch (error) {
      setCoverageError(syErrText(error));
    } finally {
      setCoverageLoading(false);
    }
  }, [connections, endDate, startDate]);

  // 首屏：连接列表 + 任务历史
  React.useEffect(() => {
    loadConnections();
    loadJobs();
  }, [loadConnections, loadJobs]);

  // 连接变化：读取所有连接已保存的仓库范围
  React.useEffect(() => {
    if (!connections.length) return;
    loadScopes();
  }, [connections, loadScopes]);

  // 轮询运行中的同步任务（2s，最多 30 分钟）
  // 依赖只保留 polling + 稳定的 loader，job 通过 ref 读取，避免每次渲染重置计时器。
  const jobRef = React.useRef(null);
  jobRef.current = job;
  React.useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(async () => {
      const list = await loadJobs();
      const currentId = jobRef.current && jobRef.current.jobId;
      const current = list.find((item) => String(item.jobId) === String(currentId)) || list[0] || null;
      if (current) setJob(current);
      const status = current && current.status;
      const elapsed = Date.now() - startedAtRef.current;
      if (!current || status === 'completed' || status === 'failed' || status === 'cancelled' || elapsed > 30 * 60 * 1000) {
        setPolling(false);
        if (status === 'completed' || status === 'failed') {
          if (typeof saSet === 'function') saSet({ staleAfterSync: true });
          if (typeof saLoadAnalytics === 'function') saLoadAnalytics(true);
        }
        if (elapsed > 30 * 60 * 1000 && status === 'running') {
          setSyncError(typeof t === 'function' ? tx(t, 'syncTimeout', '同步超时（超过 30 分钟），请稍后在任务历史中查看结果') : '同步超时（超过 30 分钟），请稍后在任务历史中查看结果');
        }
        loadCoverage();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loadCoverage, loadJobs, polling, t]);

  // 连接/窗口变化时预览覆盖度（只读本地库，代价低）
  React.useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  const applyWindow = (nextStart, nextEnd) => {
    if (nextStart) setStartDate(nextStart);
    if (nextEnd) setEndDate(nextEnd);
  };
  const updateStartDate = (value) => {
    setStartDate(value);
    if (value && endDate && value > endDate) setEndDate(value);
  };
  const updateEndDate = (value) => {
    setEndDate(value);
    if (value && startDate && value < startDate) setStartDate(value);
  };
  const applyRangeKind = (kind) => {
    const range = typeof saRangeForKind === 'function' ? saRangeForKind(kind) : syThisWeek();
    if (Array.isArray(range) && range.length === 2) applyWindow(range[0], range[1]);
    else if (range && range.startDate && range.endDate) applyWindow(range.startDate, range.endDate);
  };

  const startSync = React.useCallback(async () => {
    if (!connectionId) {
      setSyncError(tr('connectionRequired', '请先保存并选择 GitLab 连接'));
      return;
    }
    if (!scope.total) {
      setSyncError(tr('noScopeNotice', '还没有保存同步仓库范围，请先到 设置 → 工作报告 → 同步仓库范围 选择仓库。'));
      return;
    }
    if (!startDate || !endDate) {
      setSyncError(tr('windowRequired', '请选择同步窗口'));
      return;
    }
    if (startDate > endDate) {
      setSyncError(tr('windowReversed', '开始日期不能晚于结束日期'));
      return;
    }
    setStarting(true);
    setSyncError('');
    try {
      const body = { connectionIds: scope.connections.map((row) => row.id), startDate, endDate };
      const data = await api.post('/sync/start', body);
      const jobId = data && (data.jobId || data.job_id);
      const nextJob = { jobId, connectionId: scope.connections[0] && scope.connections[0].id, status: 'running', progress: { projectsDone: 0, projectsTotal: scope.total, commitsSynced: 0 } };
      setJob(nextJob);
      startedAtRef.current = Date.now();
      setPolling(true);
      showToast('ok', tr('syncStarted', '同步已开始'));
      await loadJobs();
    } catch (error) {
      setSyncError(syErrText(error));
    } finally {
      setStarting(false);
    }
  }, [connectionId, endDate, loadJobs, scope, startDate, t]);

  const viewJobStats = React.useCallback(
    (item) => {
      const start = String((item && (item.startDate || item.start_date)) || '').slice(0, 10);
      const end = String((item && (item.endDate || item.end_date)) || '').slice(0, 10);
      if (!start || !end) return;
      if (typeof saSet !== 'function' || typeof saLoadAnalytics !== 'function') return;
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
        syncOpen: false,
      });
      saLoadAnalytics(true);
    },
    [t],
  );

  const cancelSync = React.useCallback(async () => {
    const jobId = job && job.jobId;
    if (!jobId) return;
    setSyncError('');
    try {
      await api.post('/sync/cancel', { jobId });
      showToast('ok', tr('cancelRequested', '已请求取消'));
      const list = await loadJobs();
      const current = list.find((item) => String(item.jobId) === String(jobId));
      if (current) setJob(current);
    } catch (error) {
      setSyncError(syErrText(error));
    }
  }, [job, loadJobs, t]);

  const connectionOptions = connections.map((item) => ({
    value: String(item.id),
    label: `${item.displayName || item.baseUrl || item.id}${item.hasToken ? '' : ` · ${tr('tokenMissing', '未保存 Token')}`}`,
  }));

  const selectedCount = scope.total;
  const progress = (job && job.progress) || {};
  const projectsTotal = Number(progress.projectsTotal || 0);
  const projectsDone = Number(progress.projectsDone || 0);
  const percent = projectsTotal > 0 ? Math.round((projectsDone / projectsTotal) * 100) : job && job.status === 'completed' ? 100 : 0;
  const jobStatus = job && job.status;
  const progressTone = jobStatus === 'completed' ? 'done' : jobStatus === 'failed' ? 'bad' : '';
  const coverageSummary = (coverage && coverage.summary) || {};
  const coverageRepos = Array.isArray(coverage && coverage.repos) ? coverage.repos : [];

  return h(
    'div',
    { className: `dsr-sync${embedded ? ' dsr-syncEmbedded' : ''}` },
    embedded
      ? null
      : h(
          'div',
          { className: 'dsr-pageIntro' },
          h('div', { className: 'dsr-pageTitle' }, tr('syncTitle', '提交同步')),
          h('p', { className: 'dsr-pageHint' }, tr('syncHint', '先保存 GitLab 连接并选择仓库，再同步指定窗口的提交。')),
        ),

    embedded ? null : h(SyncConnectionCard, { t, actions, onSaved: loadConnections }),

    embedded && !connLoading && connections.length === 0
      ? h(
          'div',
          { className: 'dsr-syncNotice', role: 'status' },
          h('strong', null, tr('noConnectionNotice', '还没有 GitLab 连接')),
          h('div', { className: 'dsr-hint' }, tr('noConnectionNoticeHint', '请先到 设置 → 工作报告 保存 GitLab 地址与 Token，再回来同步。')),
        )
      : null,

    // ---- 同步范围摘要（编辑入口在设置里，这里只做一行提示）
    h(
      'div',
      { className: `dsr-syncScopeBar${selectedCount ? '' : ' dsr-syncScopeBarWarn'}`, role: 'status' },
      h(
        'span',
        { className: 'dsr-syncScopeText' },
        connLoading
          ? tr('loading', '加载中…')
          : selectedCount
            ? `${tr('selected', '已选')} ${selectedCount} ${tr('repos', '仓库')} · ${scope.connections.length} ${tr('connections', '个连接')}`
            : tr('noScopeShort', '还没有选择同步仓库：请到 设置 → 工作报告 → 同步仓库范围 选择'),
      ),
      h('span', { className: 'dsr-syncScopeHint' }, tr('syncScopeSummaryHint', '仓库范围在 设置 → 工作报告 → 同步仓库范围 修改')),
      h(
        'span',
        { className: 'dsr-syncScopeActions' },
        h(Button, { size: 'sm', onClick: () => loadScopes(), disabled: !connections.length }, tr('reloadScope', '重新读取')),
        h(Button, { size: 'sm', onClick: () => loadConnections(), disabled: connLoading }, tr('refreshConnection', '刷新连接')),
      ),
    ),
    connError ? h(SyncErrorBar, null, connError) : null,

    // ---- 同步窗口与进度
    h(
      SyncCard,
      {
        title: tr('syncWindow', '同步窗口与进度'),
        icon: SyncGlyph,
        aside: jobStatus ? h(Badge, { tone: syJobTone(jobStatus) }, syJobStatusLabel(jobStatus, t)) : null,
        hint: tr('syncWindowHint', '窗口按本机时区取 00:00–23:59:59；同步中会每 2 秒刷新进度。'),
      },
      h(
        'div',
        { className: 'dsr-formGrid' },
        h(Field, { label: tr('startDate', '开始日期'), hint: tr('startDateHint', '不能晚于结束日期') }, h(Input, {
          type: 'date',
          value: startDate,
          max: endDate || undefined,
          onChange: (event) => updateStartDate(event.target.value),
        })),
        h(Field, { label: tr('endDate', '结束日期'), hint: tr('endDateHint', '不能早于开始日期') }, h(Input, {
          type: 'date',
          value: endDate,
          min: startDate || undefined,
          onChange: (event) => updateEndDate(event.target.value),
        })),
      ),
      h(
        'div',
        { className: 'dsr-btnRow' },
        h(Button, { onClick: () => applyRangeKind('last7') }, tr('last7', '近 7 天')),
        h(Button, { onClick: () => applyRangeKind('last30') }, tr('last30', '近 30 天')),
        h(Button, { onClick: () => applyRangeKind('week') }, tr('thisWeek', '本周')),
        h(Button, { onClick: () => applyRangeKind('month') }, tr('thisMonth', '本月')),
        h(Button, { onClick: () => applyRangeKind('last12') }, tr('last12', '近 12 个月')),
        h(Button, { onClick: loadCoverage, disabled: coverageLoading }, coverageLoading ? tr('loading', '加载中…') : tr('previewCoverage', '预览覆盖度')),
        h(Button, { variant: 'primary', onClick: startSync, disabled: starting || polling || !selectedCount }, starting ? tr('starting', '启动中…') : tr('startSync', '开始同步')),
        polling || (job && job.status === 'running') ? h(Button, { variant: 'danger', onClick: cancelSync }, tr('cancelSync', '取消同步')) : null,
      ),
      syncError ? h(SyncErrorBar, null, syncError) : null,
      job
        ? h(
            'div',
            { className: 'dsr-progressRow' },
            h(
              'div',
              { className: 'dsr-progressHead' },
              h('span', null, `${tr('repoProgress', '仓库进度')} ${projectsDone}/${projectsTotal || '—'}`),
              h('span', null, '·'),
              h('span', null, `${tr('commitsSynced', '已入库提交')} ${fmtInt(progress.commitsSynced)}`),
              progress.currentProject ? h('span', null, `· ${tr('currentProject', '当前仓库')} ${progress.currentProject}`) : null,
              h('span', null, '·'),
              h('span', null, syJobStatusLabel(job.status, t)),
            ),
            h('div', { className: 'dsr-progressTrack' }, h('div', { className: `dsr-progressFill ${progressTone}`, style: { width: `${Math.max(percent, 2)}%` } })),
            job.error ? h(SyncErrorBar, null, job.error) : null,
          )
        : h('div', { className: 'dsr-hint' }, tr('noActiveJob', '当前没有运行中的同步任务')),

      // 覆盖度
      coverageError ? h(SyncErrorBar, null, coverageError) : null,
      coverage
        ? h(
            'div',
            { className: 'dsr-section' },
            h(
              'div',
              { className: 'dsr-syncSectionHead' },
              h('strong', { className: 'dsr-syncSectionTitle' }, tr('coverageTitle', '本地已有数据（同步前预览）')),
              h(
                'span',
                { className: 'dsr-hint' },
                tr('coverageHint', '当前窗口内本地库已有的提交与行数，用来判断这个窗口是否已经同步过。'),
              ),
            ),
            h(
              'div',
              { className: 'dsr-kvGrid' },
              h('div', { className: 'dsr-kv' }, h('span', { className: 'dsr-kvLabel' }, tr('commits', '提交')), h('span', { className: 'dsr-kvValue' }, fmtInt(coverageSummary.commits))),
              h('div', { className: 'dsr-kv' }, h('span', { className: 'dsr-kvLabel' }, tr('additions', '新增行')), h('span', { className: 'dsr-kvValue dsr-add' }, `+${fmtInt(coverageSummary.additions)}`)),
              h('div', { className: 'dsr-kv' }, h('span', { className: 'dsr-kvLabel' }, tr('deletions', '删除行')), h('span', { className: 'dsr-kvValue dsr-del' }, `-${fmtInt(coverageSummary.deletions)}`)),
              h('div', { className: 'dsr-kv' }, h('span', { className: 'dsr-kvLabel' }, tr('activeDays', '活跃天')), h('span', { className: 'dsr-kvValue' }, fmtInt(coverageSummary.days))),
              h('div', { className: 'dsr-kv' }, h('span', { className: 'dsr-kvLabel' }, tr('repos', '仓库')), h('span', { className: 'dsr-kvValue' }, fmtInt(coverageSummary.repos))),
            ),
            coverageRepos.length
              ? h(
                  'table',
                  { className: 'dsr-table' },
                  h('thead', null, h('tr', null, h('th', null, tr('repos', '仓库')), h('th', { className: 'dsr-num' }, tr('commits', '提交')), h('th', { className: 'dsr-num' }, tr('additions', '新增行')), h('th', { className: 'dsr-num' }, tr('deletions', '删除行')))),
                  h(
                    'tbody',
                    null,
                    ...coverageRepos.slice(0, 20).map((repo) =>
                      h(
                        'tr',
                        { key: repo.repoKey || repo.repo_key },
                        h('td', { className: 'dsr-mono' }, repo.repoKey || repo.repo_key || '—'),
                        h('td', { className: 'dsr-num' }, fmtInt(repo.commitCount !== undefined ? repo.commitCount : repo.commit_count)),
                        h('td', { className: 'dsr-num dsr-add' }, `+${fmtInt(repo.additions)}`),
                        h('td', { className: 'dsr-num dsr-del' }, `-${fmtInt(repo.deletions)}`),
                      ),
                    ),
                  ),
                )
              : null,
          )
        : null,
    ),

    // ---- 任务历史
    h(
      SyncCard,
      {
        title: tr('jobs', '同步任务'),
        icon: StatsGlyph,
        aside: h(Button, { size: 'sm', onClick: () => loadJobs() }, tr('refresh', '刷新')),
      },
      jobs.length
        ? h(
            'table',
            { className: 'dsr-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, tr('status', '状态')),
                h('th', null, tr('syncWindow', '同步窗口')),
                h('th', { className: 'dsr-num' }, tr('repoProgress', '仓库进度')),
                h('th', { className: 'dsr-num' }, tr('commits', '提交')),
                h('th', null, tr('startedAt', '开始')),
                h('th', null, tr('finishedAt', '结束')),
                h('th', null, tr('error', '错误')),
                h('th', null, tr('actions', '操作')),
              ),
            ),
            h(
              'tbody',
              null,
              ...jobs.map((item) => {
                const itemProgress = item.progress || {};
                return h(
                  'tr',
                  { key: item.jobId },
                  h('td', null, h(Badge, { tone: syJobTone(item.status) }, syJobStatusLabel(item.status, t))),
                  h('td', { className: 'dsr-mono' }, syJobWindow(item) || String(item.connectionId || item.connection_id || '—')),
                  h('td', { className: 'dsr-num' }, `${fmtInt(itemProgress.projectsDone)}/${itemProgress.projectsTotal ? fmtInt(itemProgress.projectsTotal) : '—'}`),
                  h('td', { className: 'dsr-num' }, fmtInt(itemProgress.commitsSynced)),
                  h('td', null, fmtDateTime(item.startedAt)),
                  h('td', null, item.finishedAt ? fmtDateTime(item.finishedAt) : '—'),
                  h('td', { className: item.error ? 'dsr-error' : '' }, item.error ? String(item.error) : '—'),
                  h(
                    'td',
                    null,
                    h(
                      Button,
                      { size: 'sm', onClick: () => viewJobStats(item), disabled: !(item.startDate || item.start_date) || !(item.endDate || item.end_date) },
                      tr('viewStats', '查看统计'),
                    ),
                  ),
                );
              }),
            ),
          )
        : h(EmptyState, { title: tr('noJobs', '还没有同步任务'), hint: tr('noJobsHint', '选择窗口后点击「开始同步」') }),
    ),
  );
}

// ---------------------------------------------------------------- 设置页
const SY_REPORT_TYPES = ['week', 'month', 'quarter', 'year'];

function SettingsPage({ t, state, actions }) {
  const tr = (key, fallback) => (typeof t === 'function' ? tx(t, key, fallback) : fallback);

  const [config, setConfig] = React.useState((state && state.config) || null);
  const [timezone, setTimezone] = React.useState(((state && state.config) || {}).timezone || 'Asia/Shanghai');
  const [defaultType, setDefaultType] = React.useState(((state && state.config) || {}).defaultReportType || 'week');
  const [generalBusy, setGeneralBusy] = React.useState(false);
  const [generalError, setGeneralError] = React.useState('');

  const [templates, setTemplates] = React.useState(null);
  const [guidance, setGuidance] = React.useState(null);
  const [tplTab, setTplTab] = React.useState('week');
  const [tplBusy, setTplBusy] = React.useState(false);
  const [tplLoading, setTplLoading] = React.useState(false);
  const [tplError, setTplError] = React.useState('');
  const [tplNotice, setTplNotice] = React.useState('');

  const [aliases, setAliases] = React.useState('');
  const [aliasDirty, setAliasDirty] = React.useState(false);
  const [aliasLoading, setAliasLoading] = React.useState(false);
  const [aliasBusy, setAliasBusy] = React.useState(false);
  const [aliasSuggesting, setAliasSuggesting] = React.useState(false);
  const [aliasMsg, setAliasMsg] = React.useState(null);
  const [aliasCandidates, setAliasCandidates] = React.useState([]);

  const applyConfig = React.useCallback((next) => {
    setConfig(next || null);
    if (next && next.timezone) setTimezone(String(next.timezone));
    if (next && next.defaultReportType) setDefaultType(String(next.defaultReportType));
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = actions && typeof actions.loadConfig === 'function' ? await actions.loadConfig() : await api.get('/config');
        if (alive) applyConfig(loaded);
      } catch (error) {
        if (alive) setGeneralError(syErrText(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [actions, applyConfig]);

  const loadTemplates = React.useCallback(async () => {
    setTplLoading(true);
    setTplError('');
    try {
      const data = actions && typeof actions.loadTemplates === 'function' ? await actions.loadTemplates() : await api.get('/templates');
      setTemplates((data && data.templates) || {});
      setGuidance((data && data.guidance) || {});
    } catch (error) {
      setTplError(syErrText(error));
    } finally {
      setTplLoading(false);
    }
  }, [actions]);

  React.useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  React.useEffect(() => {
    let alive = true;
    setAliasLoading(true);
    api
      .get('/gitlab/author-aliases')
      .then((data) => {
        if (!alive) return;
        const list = Array.isArray(data && data.aliases) ? data.aliases : [];
        setAliases(list.join('\n'));
      })
      .catch(() => {
        /* 老版本 API 没有该端点时忽略 */
      })
      .finally(() => {
        if (alive) setAliasLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const saveGeneral = React.useCallback(async () => {
    setGeneralBusy(true);
    setGeneralError('');
    try {
      const saved = await api.put('/config', { timezone: timezone.trim() || 'Asia/Shanghai', defaultReportType: defaultType });
      applyConfig(saved);
      if (actions && typeof actions.loadConfig === 'function') await actions.loadConfig();
      showToast('ok', tr('saved', '已保存'));
    } catch (error) {
      setGeneralError(syErrText(error));
    } finally {
      setGeneralBusy(false);
    }
  }, [actions, applyConfig, defaultType, timezone, t]);

  const saveTemplates = React.useCallback(async () => {
    setTplBusy(true);
    setTplError('');
    setTplNotice('');
    try {
      if (actions && typeof actions.saveTemplates === 'function') {
        await actions.saveTemplates({ templates: templates || {}, guidance: guidance || {} });
      } else {
        await api.put('/templates', { templates: templates || {}, guidance: guidance || {} });
      }
      setTplNotice(tr('saved', '已保存'));
      showToast('ok', tr('saved', '已保存'));
    } catch (error) {
      setTplError(syErrText(error));
    } finally {
      setTplBusy(false);
    }
  }, [actions, guidance, t, templates]);

  const aliasLines = React.useCallback(
    () =>
      String(aliases || '')
        .split(/[\n,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    [aliases],
  );

  const saveAliases = React.useCallback(async () => {
    setAliasBusy(true);
    setAliasMsg(null);
    try {
      const data = await api.put('/gitlab/author-aliases', { aliases: aliasLines() });
      const list = Array.isArray(data && data.aliases) ? data.aliases : aliasLines();
      setAliases(list.join('\n'));
      setAliasDirty(false);
      setAliasMsg({ ok: true, text: tr('saved', '已保存') });
      showToast('ok', tr('saved', '已保存'));
    } catch (error) {
      setAliasMsg({ ok: false, text: syErrText(error) });
    } finally {
      setAliasBusy(false);
    }
  }, [aliasLines, t]);

  const suggestAliases = React.useCallback(async () => {
    setAliasSuggesting(true);
    setAliasMsg(null);
    setAliasCandidates([]);
    try {
      const data = await api.post('/gitlab/suggest-author-aliases', { existingAliases: aliasLines() });
      const merged = Array.isArray(data && data.mergedAliases) ? data.mergedAliases : [];
      const candidates = [];
      let failure = '';
      for (const connection of (data && data.connections) || []) {
        if (connection && connection.error) {
          failure = `${connection.connectionName || connection.connectionId || 'GitLab'}: ${connection.error}`;
        }
        for (const item of (connection && connection.candidates) || []) {
          if (!item || !item.value) continue;
          candidates.push({ value: String(item.value), kind: String(item.kind || ''), count: Number(item.count || 0) });
        }
      }
      setAliasCandidates(candidates);
      if (merged.length) {
        setAliases(merged.join('\n'));
        setAliasDirty(true);
      }
      const text = String((data && data.message) || (merged.length ? '已写入建议别名，请确认后保存' : '未发现可新增别名'));
      setAliasMsg({ ok: !failure, text: failure || text });
    } catch (error) {
      setAliasMsg({ ok: false, text: syErrText(error) });
    } finally {
      setAliasSuggesting(false);
    }
  }, [aliasLines, t]);

  const setTemplateText = (type, value) => setTemplates((current) => ({ ...(current || {}), [type]: value }));
  const setGuidanceText = (type, value) => setGuidance((current) => ({ ...(current || {}), [type]: value }));

  const typeOptions = SY_REPORT_TYPES.map((type) => ({ value: type, label: reportTypeLabel(type, t) }));
  const tplTabs = SY_REPORT_TYPES.map((type) => ({ value: type, label: reportTypeLabel(type, t) }));

  return h(
    'div',
    { className: 'dsr-settings' },
    h(
      'div',
      { className: 'dsr-pageIntro' },
      h('div', { className: 'dsr-pageTitle' }, tr('settingsTitle', '设置')),
      h('p', { className: 'dsr-pageHint' }, tr('settingsIntro', '连接、时区与写作模板都保存在本机 profile，不写入报告数据。')),
    ),

    h(SyncConnectionCard, { t, actions, onSaved: () => {} }),

    h(SyncScopeCard, { t, actions }),

    // ---- 提交作者别名（对齐 workbench「从 GitLab 推断」）
    h(
      SyncCard,
      {
        title: tr('authorAliases', '提交作者别名'),
        icon: SettingsGlyph,
        aside: aliasDirty ? h(Badge, null, tr('unsaved', '未保存')) : null,
        hint: tr('authorAliasesHint', '本地 git 作者与 GitLab 账号不一致时填写，每行一个邮箱或作者名。'),
      },
      h(
        Field,
        { label: tr('aliasList', '别名列表') },
        h(Textarea, {
          value: aliases,
          rows: 3,
          placeholder: tr('authorAliasesPlaceholder', '每行一个邮箱或作者名'),
          onChange: (event) => {
            setAliases(event.target.value);
            setAliasDirty(true);
          },
          spellCheck: false,
        }),
      ),
      h(
        'div',
        { className: 'dsr-btnRow' },
        h(Button, { onClick: suggestAliases, disabled: aliasSuggesting || aliasBusy || aliasLoading }, aliasSuggesting ? tr('suggesting', '推断中…') : tr('suggestFromGitLab', '从 GitLab 推断')),
        h(Button, { variant: 'primary', onClick: saveAliases, disabled: aliasBusy || aliasSuggesting }, aliasBusy ? tr('saving', '保存中…') : tr('saveAliases', '保存别名')),
      ),
      aliasMsg
        ? h('p', { className: `dsr-aliasMsg${aliasMsg.ok ? ' ok' : ' warn'}`, role: aliasMsg.ok ? undefined : 'alert' }, aliasMsg.text)
        : null,
      aliasCandidates.length
        ? h(
            'ul',
            { className: 'dsr-aliasList' },
            aliasCandidates.map((item) =>
              h(
                'li',
                { key: `${item.kind}:${item.value}` },
                h('code', null, item.value),
                h('span', null, `${item.kind === 'email' ? '邮箱' : '作者名'} · 近期 ${item.count} 次`),
              ),
            ),
          )
        : null,
    ),

    // ---- 常规
    h(
      SyncCard,
      { title: tr('general', '常规'), icon: SettingsGlyph, hint: config && config.dataDir ? `${tr('dataDir', '数据目录')}：${config.dataDir}` : undefined },
      h(
        'div',
        { className: 'dsr-formGrid' },
        h(Field, {
          label: tr('timezone', '时区'),
          hint: tr('timezoneHint', '只影响周期计算与显示，不改已存日期'),
        }, h(Input, { value: timezone, placeholder: 'Asia/Shanghai', onChange: (event) => setTimezone(event.target.value), spellCheck: false })),
        h(Field, { label: tr('defaultReportType', '默认报告类型') }, h(Select, { options: typeOptions, value: defaultType, onChange: setDefaultType })),
      ),
      generalError ? h(SyncErrorBar, null, generalError) : null,
      h(
        'div',
        { className: 'dsr-btnRow' },
        h(Button, { variant: 'primary', onClick: saveGeneral, disabled: generalBusy }, generalBusy ? tr('saving', '保存中…') : tr('save', '保存')),
      ),
    ),

    // ---- 模板与 guidance
    h(
      SyncCard,
      {
        title: tr('templates', '模板与写作指引'),
        icon: ReportGlyph,
        aside: h(Button, { size: 'sm', onClick: loadTemplates, disabled: tplLoading }, tplLoading ? tr('loading', '加载中…') : tr('reload', '重新加载')),
        hint: tr('templatesHint', '模板决定正文骨架，guidance 是追加写作约束；保存后新生成的报告立即生效。'),
      },
      h(
        'div',
        { className: 'dsr-tplTabs' },
        h(Tabs, { items: tplTabs, value: tplTab, onChange: setTplTab }),
      ),
      h(
        'div',
        { className: 'dsr-tplGrid' },
        h(
          Field,
          { label: `${reportTypeLabel(tplTab, t)} ${tr('template', '模板')}` },
          h(Textarea, {
            value: (templates && templates[tplTab]) || '',
            placeholder: tr('templatePlaceholder', 'Markdown 模板，含 YYYY-MM-DD 至 YYYY-MM-DD 占位'),
            style: { minHeight: 220 },
            onChange: (event) => setTemplateText(tplTab, event.target.value),
            spellCheck: false,
          }),
        ),
        h(
          Field,
          { label: `${reportTypeLabel(tplTab, t)} ${tr('guidance', '写作指引')}` },
          h(Textarea, {
            value: (guidance && guidance[tplTab]) || '',
            placeholder: tr('guidancePlaceholder', '追加的写作要求，例如主题数量、语气、禁用内容'),
            style: { minHeight: 220 },
            onChange: (event) => setGuidanceText(tplTab, event.target.value),
            spellCheck: false,
          }),
        ),
      ),
      tplError ? h(SyncErrorBar, null, tplError) : null,
      tplNotice ? h(SyncNoticeBar, null, tplNotice) : null,
      h(
        'div',
        { className: 'dsr-btnRow' },
        h(Button, { variant: 'primary', onClick: saveTemplates, disabled: tplBusy || tplLoading }, tplBusy ? tr('saving', '保存中…') : tr('saveTemplates', '保存模板')),
        h('span', { className: 'dsr-tplNote' }, tr('templatesNote', '恢复默认需要清空文本框后保存，或在配置文件里删除对应键。')),
      ),
    ),
  );
}


/* ==== client-src/99-apply.js ==== */
// ---------------------------------------------------------------- DSH 面板集成层（sidebar.panellist / main / settings.section）

addClientCSS(`

/* ===== 令牌（对齐 workbench --wl-* 的实际取值） ===== */
.dsr-root {
  --dsr-canvas: var(--dsw-alias-bg-base, #fbfcfc);
  --dsr-aside: var(--dsw-specific-sidebar-fill, #f3f6f7);
  --dsr-sunken: var(--dsw-alias-bg-layer-2, #eef2f2);
  --dsr-raised: var(--dsw-alias-bg-layer-1, #ffffff);
  --dsr-ink: var(--dsw-alias-label-primary, #252b2d);
  --dsr-muted: var(--dsw-alias-label-secondary, #687276);
  --dsr-faint: color-mix(in srgb, var(--dsw-alias-label-secondary, #687276) 72%, transparent);
  --dsr-line: var(--dsw-alias-border-l1, rgba(39, 49, 52, 0.09));
  --dsr-line-strong: var(--dsw-alias-border-l2, rgba(39, 49, 52, 0.11));
  --dsr-hover: color-mix(in srgb, var(--dsw-alias-label-primary, #252b2d) 6%, transparent);
  --dsr-selected: color-mix(in srgb, var(--dsw-alias-label-primary, #252b2d) 10%, transparent);
  --dsr-primary: var(--dsw-alias-brand-primary, #3b6dd8);
  --dsr-primary-dark: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6dd8) 86%, black);
  --dsr-violet: #8a6db5;
  --dsr-green: var(--dsw-alias-state-success-primary, #1f6f2c);
  --dsr-red: var(--dsw-alias-state-error-primary, #b42324);
  --dsr-shadow-card: 0 2px 8px rgba(25, 31, 32, 0.08), 0 1px 2px rgba(25, 31, 32, 0.04);
  --dsr-shadow-float: 0 12px 32px rgba(25, 31, 32, 0.18);
  --dsr-ring: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
}


/* ===== 页面骨架（DSH main 面板内） ===== */
.dsr-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base, var(--dsr-canvas));
  color: var(--dsw-alias-label-primary, var(--dsr-ink));
  font-family: "SF Pro Text", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.dsr-pageHead {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 14px 18px 10px;
}
.dsr-pageTitle { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.dsr-pageSub { font-size: 11.5px; color: var(--dsr-muted); }
.dsr-pageTabs {
  display: flex; gap: 2px; flex: none;
  padding: 0 18px; border-bottom: 1px solid var(--dsr-line);
}
.dsr-pageTab {
  height: 34px; padding: 0 12px; border: 0; background: transparent;
  color: var(--dsr-muted); font: inherit; font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.dsr-pageTab:hover { color: var(--dsr-ink); }
.dsr-pageTab.active { color: var(--dsr-ink); font-weight: 600; border-bottom-color: var(--dsr-primary); }
.dsr-pageTab:focus-visible { outline: none; box-shadow: var(--dsr-ring); border-radius: 6px 6px 0 0; }
.dsr-split { flex: 1; min-height: 0; display: flex; }
.dsr-listPane {
  width: 300px; flex: none; min-height: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--dsr-line);
  background: var(--dsw-specific-sidebar-fill, var(--dsr-aside));
}
.dsr-contentPane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dsr-settingsSection { padding: 2px 0 8px; }

/* ===== 基础控件 ===== */
.dsr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--dsr-line-strong); background: var(--dsr-raised);
  color: var(--dsr-ink); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
  white-space: nowrap;
}
.dsr-btn:hover { background: var(--dsr-sunken); }
.dsr-btn:disabled { opacity: 0.5; cursor: default; }
.dsr-btn.primary {
  background: var(--dsr-primary); border-color: var(--dsr-primary); color: #fff; font-weight: 600;
  box-shadow: 0 2px 6px rgba(59, 109, 216, 0.24);
}
.dsr-btn.primary:hover { background: var(--dsr-primary-dark); }
.dsr-btn.danger { color: var(--dsr-red); border-color: rgba(180, 35, 24, 0.28); background: #fff; }
.dsr-btn.sm, .dsr-btn--sm { height: 28px; padding: 0 10px; font-size: 12px; }
.dsr-btn:focus-visible { outline: none; box-shadow: var(--dsr-ring); }
.dsr-iconbtn {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 7px; background: transparent; color: var(--dsr-muted); cursor: pointer; flex: none;
}
.dsr-iconbtn:hover { background: var(--dsr-hover); color: var(--dsr-ink); }
.dsr-iconbtn.sm { width: 22px; height: 22px; }
.dsr-iconbtn:focus-visible { outline: none; box-shadow: var(--dsr-ring); }
.dsr-input, .dsr-textarea, .dsr-select {
  width: 100%; min-width: 0; box-sizing: border-box;
  height: 34px; padding: 0 10px; border: 0; border-radius: 8px;
  background: var(--dsr-canvas); color: var(--dsr-ink);
  font: inherit; font-size: 13px;
  box-shadow: inset 0 0 0 1px var(--dsr-line);
}
.dsr-textarea { height: auto; min-height: 96px; padding: 8px 10px; line-height: 1.6; resize: vertical; }
.dsr-input::placeholder, .dsr-textarea::placeholder { color: var(--dsr-faint); }
.dsr-input:focus, .dsr-textarea:focus, .dsr-select:focus { outline: none; box-shadow: inset 0 0 0 1px var(--dsr-primary), 0 0 0 2px rgba(59, 109, 216, 0.16); }
.dsr-field { display: flex; flex-direction: column; gap: 6px; }
.dsr-fieldLabel { font-size: 12px; font-weight: 600; color: var(--dsr-muted); }
.dsr-fieldHint { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-badge {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 6px; background: var(--dsr-sunken); color: var(--dsr-muted);
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.dsr-tabs { display: flex; align-items: center; gap: 18px; border-bottom: 1px solid var(--dsr-line); }
.dsr-tab {
  height: 38px; padding: 0; border: 0; background: transparent; color: var(--dsr-muted);
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.dsr-tab.active { color: var(--dsr-ink); font-weight: 600; border-bottom-color: var(--dsr-ink); }
.dsr-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--dsr-line-strong); border-top-color: var(--dsr-primary);
  animation: dsr-spin 720ms linear infinite;
}
@keyframes dsr-spin { to { transform: rotate(360deg); } }
.dsr-empty { padding: 48px 24px; text-align: center; color: var(--dsr-muted); font-size: 13px; }
.dsr-empty .title { font-size: 13px; font-weight: 600; color: var(--dsr-ink); margin-bottom: 6px; }
.dsr-errorBar, .dsr-error {
  padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(180, 35, 24, 0.24);
  background: #fbe4e0; color: #a24b3a; font-size: 12px;
}
.dsr-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  padding: 8px 14px; border-radius: 8px; font-size: 12px; color: #fff; z-index: 30;
  background: rgba(37, 43, 45, 0.92); box-shadow: var(--dsr-shadow-card);
}
.dsr-toast.error { background: #a24b3a; }

/* 对话框 */
.dsr-dialogMask {
  position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: rgba(25, 31, 32, 0.32);
}
.dsr-dialog {
  width: min(560px, calc(100% - 48px)); max-height: calc(100% - 48px); display: flex; flex-direction: column;
  background: var(--dsr-raised); border-radius: 14px; border: 1px solid var(--dsr-line-strong);
  box-shadow: var(--dsr-shadow-float); overflow: hidden;
}
.dsr-dialogHead {
  height: 44px; flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 0 10px 0 16px; border-bottom: 1px solid var(--dsr-line);
}
.dsr-dialogTitle { font-size: 13px; font-weight: 600; }
.dsr-dialogBody { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.dsr-dialogFoot {
  flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--dsr-line); background: var(--dsr-canvas);
}

/* ===== 报告区左栏 ===== */
.dsr-rpt-rail { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px 12px 12px; }
.dsr-rpt-top { display: flex; align-items: center; gap: 6px; flex: none; }
.dsr-rpt-create {
  flex: 1; height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 0; border-radius: 8px; background: var(--dsr-primary); color: #fff;
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 2px 6px rgba(59, 109, 216, 0.24);
}
.dsr-rpt-create:hover { background: var(--dsr-primary-dark); }
.dsr-rpt-create span { font-size: 16px; line-height: 1; }
.dsr-rpt-rail > .dsr-iconbtn { width: 36px; height: 36px; border: 1px solid var(--dsr-line-strong); background: var(--dsr-raised); border-radius: 8px; }
.dsr-rpt-filters { display: flex; flex-direction: column; gap: 8px; flex: none; }
.dsr-rpt-search { position: relative; display: flex; align-items: center; }
.dsr-rpt-searchIcon { position: absolute; left: 10px; display: inline-flex; color: var(--dsr-faint); pointer-events: none; }
.dsr-rpt-search .dsr-input { padding-left: 30px; }
.dsr-rpt-seg { display: flex; gap: 2px; height: 24px; padding: 2px; border-radius: 7px; background: #eaeff5; }
.dsr-rpt-segBtn {
  flex: 1; height: 20px; padding: 0 7px; border: 0; border-radius: 5px; background: transparent;
  color: var(--dsr-muted); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.dsr-rpt-segBtn.active { background: var(--dsr-ink); color: #fff; }
.dsr-rpt-segBtn:focus-visible { outline: none; box-shadow: var(--dsr-ring); }
.dsr-rpt-tree { flex: 1; min-height: 0; overflow: auto; padding: 2px 0 8px; }
.dsr-rpt-group { display: flex; flex-direction: column; }
.dsr-rpt-groupHead, .dsr-rpt-item {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 1px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsr-ink); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
  width: 100%; min-width: 0; box-sizing: border-box;
}
.dsr-rpt-groupHead:hover, .dsr-rpt-item:hover { background: var(--dsr-hover); }
.dsr-rpt-item.active { background: var(--dsr-selected); }
.dsr-rpt-groupHead { font-weight: 600; }
.dsr-rpt-groupLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-rpt-groupCount, .dsr-rpt-itemCount { margin-left: auto; font-size: 11.5px; color: var(--dsr-faint); font-variant-numeric: tabular-nums; }
.dsr-rpt-children { display: flex; flex-direction: column; }
.dsr-rpt-children .dsr-rpt-item { padding-left: 24px; }
.dsr-rpt-children .dsr-rpt-children .dsr-rpt-item { padding-left: 40px; }
.dsr-rpt-chev { display: inline-flex; color: var(--dsr-faint); transition: transform 120ms ease; flex: none; }
.dsr-rpt-chev.open { transform: rotate(90deg); }
.dsr-rpt-chip {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px;
  background: var(--dsr-sunken); color: var(--dsr-muted); font-size: 11px; font-weight: 600; flex: none;
}
.dsr-rpt-chip[data-type="week"] { background: #fbe4e0; color: #a24b3a; }
.dsr-rpt-chip[data-type="month"] { background: #e8f0ff; color: #3563cf; }
.dsr-rpt-chip[data-type="quarter"] { background: #efeaf8; color: #6b528f; }
.dsr-rpt-chip[data-type="year"] { background: #eef6f0; color: #2f6a49; }
.dsr-rpt-itemPeriod { color: var(--dsr-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-rpt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsr-faint); flex: none; }
.dsr-rpt-dot.ok { background: #16a34a; }
.dsr-rpt-dot.warn, .dsr-rpt-dot.generating { background: #d97706; }
.dsr-rpt-dot.error { background: #dc2626; }
.dsr-rpt-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 36px 12px; color: var(--dsr-muted); font-size: 12.5px; text-align: center; }
.dsr-rpt-stateActions { display: flex; gap: 8px; }
.dsr-rpt-gen { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--dsr-raised); border: 1px solid var(--dsr-line); box-shadow: var(--dsr-shadow-card); }
.dsr-rpt-genTitle { font-size: 12px; font-weight: 600; color: var(--dsr-ink); }
.dsr-rpt-genText, .dsr-rpt-genRange { font-size: 11.5px; color: var(--dsr-muted); }
.dsr-rpt-quick { display: flex; flex-wrap: wrap; gap: 4px; }
.dsr-rpt-quickBtn {
  height: 24px; padding: 0 8px; border: 1px solid var(--dsr-line-strong); border-radius: 6px;
  background: var(--dsr-raised); color: var(--dsr-muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.dsr-rpt-quickBtn.active { border-color: var(--dsr-primary); color: var(--dsr-primary); background: rgba(59, 109, 216, 0.08); }
.dsr-rpt-dialogRow { display: flex; gap: 10px; }
.dsr-rpt-dialogRow > * { flex: 1; min-width: 0; }
.dsr-rpt-dialogError { font-size: 12px; color: var(--dsr-red); }

/* ===== 报告主区 ===== */
.dsr-rpt-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dsr-rpt-tabStrip {
  height: 38px; flex: none; display: flex; align-items: center; gap: 6px;
  padding: 0 10px; border-bottom: 1px solid var(--dsr-line); background: var(--dsr-canvas);
}
.dsr-rpt-tab {
  height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 10px;
  border: 0; border-radius: 8px; background: var(--dsr-selected); color: var(--dsr-ink);
  font: inherit; font-size: 12.5px; font-weight: 500; max-width: 360px; min-width: 0;
}
.dsr-rpt-tabStrip .dsr-rpt-chip { background: transparent; color: var(--dsr-muted); padding: 0; font-weight: 500; }
.dsr-rpt-tabPeriod { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-rpt-tabClose { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--dsr-muted); cursor: pointer; }
.dsr-rpt-tabClose:hover { background: var(--dsr-hover); color: var(--dsr-ink); }
.dsr-rpt-pane { flex: 1; min-height: 0; overflow: auto; padding: 16px 22px 28px; }
.dsr-rpt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; }
.dsr-rpt-meta { font-size: 13px; color: var(--dsr-muted); margin: 0; }
.dsr-rpt-headActions { display: flex; align-items: center; gap: 8px; }
.dsr-rpt-tabs { display: flex; gap: 20px; margin: 8px 0 0; border-bottom: 1px solid var(--dsr-line); }
.dsr-rpt-tabBtn { height: 38px; padding: 0; border: 0; background: transparent; color: var(--dsr-muted); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dsr-rpt-tabBtn.active { color: var(--dsr-ink); font-weight: 600; border-bottom-color: var(--dsr-ink); }
.dsr-rpt-content { padding-top: 16px; }
.dsr-rpt-kpiGrid, .dsr-rpt-stats > .dsr-rpt-kpiGrid, .dsr-rpt-summaryGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dsr-rpt-kpi {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; border-radius: 14px; border: 1px solid var(--dsr-line);
  background: #fff; box-shadow: var(--dsr-shadow-card);
}
.dsr-rpt-kpi:nth-child(1) { border-top: 3px solid var(--dsr-primary); background: color-mix(in srgb, var(--dsr-primary) 6%, var(--dsr-raised)); }
.dsr-rpt-kpi:nth-child(2) { border-top: 3px solid var(--dsr-primary); background: color-mix(in srgb, var(--dsr-primary) 8%, var(--dsr-raised)); }
.dsr-rpt-kpi:nth-child(3) { border-top: 3px solid var(--dsr-violet); background: color-mix(in srgb, var(--dsr-violet) 8%, var(--dsr-raised)); }
.dsr-rpt-kpiLabel { font-size: 12px; color: var(--dsr-muted); display: inline-flex; align-items: center; gap: 5px; }
.dsr-rpt-kpiValue { font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--dsr-ink); font-variant-numeric: tabular-nums; }
.dsr-rpt-kpi:nth-child(2) .dsr-rpt-kpiValue { color: var(--dsr-primary); }
.dsr-rpt-kpi:nth-child(3) .dsr-rpt-kpiValue { color: var(--dsr-violet); }
.dsr-rpt-kpiHint { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-rpt-alert { margin: 12px 0; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(180, 35, 24, 0.24); background: #fbe4e0; color: #a24b3a; font-size: 12px; }
.dsr-rpt-scope { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 2px 0 14px; color: var(--dsr-muted); font-size: 12px; }
.dsr-rpt-scopeRange { color: var(--dsr-ink); font-weight: 600; font-size: 13px; }
.dsr-rpt-scopeMeta { color: var(--dsr-muted); }
.dsr-rpt-section { margin-top: 18px; }
.dsr-rpt-sectionHead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.dsr-rpt-sectionTitle { font-size: 13px; font-weight: 600; color: var(--dsr-ink); }
.dsr-rpt-sectionHint { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-rpt-card { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--dsr-line); background: var(--dsr-raised); box-shadow: var(--dsr-shadow-card); }
.dsr-rpt-cardTitle { font-size: 12px; font-weight: 600; color: var(--dsr-muted); margin-bottom: 10px; }
.dsr-rpt-metricRow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 4px 0; font-size: 12px; color: var(--dsr-muted); }
.dsr-rpt-metricRow .dsr-rpt-num, .dsr-rpt-num { color: var(--dsr-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsr-rpt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsr-rpt-table th { text-align: left; font-weight: 600; color: var(--dsr-muted); padding: 6px 8px; border-bottom: 1px solid var(--dsr-line); }
.dsr-rpt-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsr-line); color: var(--dsr-ink); font-variant-numeric: tabular-nums; }
.dsr-rpt-table tr:last-child td { border-bottom: 0; }
.dsr-rpt-repoBtn { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0; color: var(--dsr-ink); font: inherit; font-size: 12px; cursor: pointer; }
.dsr-rpt-repoNs, .dsr-repoNs { color: var(--dsr-faint); font-size: 11.5px; }
.dsr-rpt-branchRow { display: flex; gap: 10px; padding: 4px 0 4px 22px; font-size: 11.5px; color: var(--dsr-muted); }
.dsr-rpt-branchCell { min-width: 90px; color: var(--dsr-ink); }
.dsr-rpt-topic { padding: 10px 12px; border: 1px solid var(--dsr-line); border-radius: 10px; margin-bottom: 8px; background: var(--dsr-raised); }
.dsr-rpt-topicHead { display: flex; align-items: center; gap: 8px; }
.dsr-rpt-topicSummary { font-size: 12px; color: var(--dsr-muted); margin-top: 4px; }
.dsr-rpt-topics { display: flex; flex-direction: column; }
.dsr-rpt-trendWrap { overflow: hidden; }
.dsr-rpt-trendSvg { width: 100%; height: auto; display: block; }
.dsr-rpt-md { max-width: 820px; font-size: 13px; line-height: 1.6; color: var(--dsr-ink); }
.dsr-rpt-md h1 { font-size: 17.55px; font-weight: 650; line-height: 1.3; margin: 18px 0 7px; }
.dsr-rpt-md h2 { font-size: 15.6px; font-weight: 650; line-height: 1.3; margin: 16px 0 6px; }
.dsr-rpt-md h3 { font-size: 14.04px; font-weight: 650; line-height: 1.3; margin: 14px 0 5px; }
.dsr-rpt-md p { margin: 6px 0; }
.dsr-rpt-md ul, .dsr-rpt-md ol { margin: 6px 0; padding-left: 22px; }
.dsr-rpt-md li { margin: 3px 0; }
.dsr-rpt-md code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; padding: 1px 5px; border-radius: 5px; background: var(--dsr-sunken); }
.dsr-rpt-md pre { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: var(--dsr-sunken); overflow: auto; }
.dsr-rpt-md pre code { background: transparent; padding: 0; }
.dsr-rpt-md blockquote { margin: 10px 0; padding: 8px 12px; border-left: 3px solid var(--dsr-line-strong); background: rgba(42, 53, 56, 0.04); border-radius: 0 8px 8px 0; color: var(--dsr-muted); }
.dsr-rpt-md hr { border: 0; border-top: 1px solid var(--dsr-line); margin: 14px 0; }
.dsr-rpt-md a { color: var(--dsr-primary); text-decoration: none; }
.dsr-rpt-md strong { font-weight: 650; }
.dsr-rpt-moreWrap { position: relative; }
.dsr-rpt-menuMask { position: fixed; inset: 0; z-index: 12; }
.dsr-rpt-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 13; min-width: 168px;
  padding: 4px; border-radius: 10px; border: 1px solid var(--dsr-line-strong);
  background: var(--dsr-raised); box-shadow: var(--dsr-shadow-float);
}
.dsr-rpt-menuItem {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px;
  border: 0; border-radius: 7px; background: transparent; color: var(--dsr-ink);
  font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
}
.dsr-rpt-menuItem:hover { background: var(--dsr-sunken); }
.dsr-rpt-menuItem.danger { color: var(--dsr-red); }
.dsr-rpt-menuSep { height: 1px; margin: 4px 6px; background: var(--dsr-line); }
.dsr-rpt-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 24px; text-align: center; color: var(--dsr-muted); font-size: 13px; }
.dsr-rpt-emptyActions { display: flex; gap: 8px; margin-top: 6px; }
.dsr-rpt-detail { flex: 1; min-height: 0; overflow: auto; padding: 16px 22px 28px; }
.dsr-rpt-paneInner { display: flex; flex-direction: column; }

/* ===== 统计区 ===== */
.dsr-stt-aside { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px 12px 12px; }
.dsr-stt-asideSearch { position: relative; display: flex; align-items: center; }
.dsr-stt-asideSearch .dsr-input { padding-left: 30px; }
.dsr-stt-allRepos {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 32px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsr-ink); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.dsr-stt-allRepos.active { background: var(--dsr-selected); }
.dsr-stt-allRepos:hover { background: var(--dsr-hover); }
.dsr-stt-count { color: var(--dsr-faint); font-size: 11.5px; font-variant-numeric: tabular-nums; font-weight: 400; }
.dsr-repoTree { flex: 1; min-height: 0; overflow: auto; padding-bottom: 8px; }
.dsr-repoTreeRow {
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 28px; padding: 0 8px;
  border: 0; border-radius: 8px; background: transparent; color: var(--dsr-ink); font: inherit;
  font-size: 12.5px; text-align: left; cursor: pointer; box-sizing: border-box;
}
.dsr-repoTreeRow:hover { background: var(--dsr-hover); }
.dsr-repoTreeRow.active { background: var(--dsr-selected); font-weight: 600; }
.dsr-repoTreeChevron { display: inline-flex; color: var(--dsr-faint); transition: transform 120ms ease; flex: none; }
.dsr-repoTreeChevron.open { transform: rotate(90deg); }
.dsr-repoTreeName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-repoTreeCount { color: var(--dsr-faint); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.dsr-stt-asideEmpty { padding: 24px 8px; text-align: center; color: var(--dsr-faint); font-size: 12px; }
.dsr-stt-main { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; padding: 18px 22px 28px; }
.dsr-stt-page { display: flex; flex-direction: column; gap: 14px; }
.dsr-stt-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsr-stt-titleCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsr-stt-name { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; color: var(--dsr-ink); }
.dsr-stt-path { margin: 0; font-size: 12px; color: var(--dsr-faint); }
.dsr-stt-rule { margin: 2px 0 0; font-size: 12px; color: var(--dsr-muted); }
.dsr-stt-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dsr-stt-ranges { display: flex; align-items: center; gap: 2px; padding: 2px; border-radius: 14px; background: #fff; box-shadow: var(--dsr-shadow-card); }
.dsr-stt-range {
  height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsr-muted); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.dsr-stt-range:hover { color: var(--dsr-ink); }
.dsr-stt-range.active { background: rgba(59, 109, 216, 0.12); color: var(--dsr-primary); }
.dsr-stt-dates { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px; background: var(--dsr-canvas); box-shadow: inset 0 0 0 1px var(--dsr-line); }
.dsr-stt-date { border: 0; background: transparent; color: var(--dsr-ink); font: inherit; font-size: 12px; width: 108px; outline: none; }
.dsr-stt-date::-webkit-calendar-picker-indicator { opacity: 0.5; }
.dsr-stt-dateSep { color: var(--dsr-faint); font-size: 12px; }
.dsr-stt-tools .dsr-btn { height: 32px; }
.dsr-stt-tools .dsr-btn.primary { border-radius: 999px; padding: 0 16px; }
.dsr-stt-wall { display: flex; flex-direction: column; }
.dsr-wall { display: flex; flex-direction: column; gap: 6px; }
.dsr-wallScroll { overflow-x: auto; padding-bottom: 2px; }
.dsr-wallCanvas { display: grid; grid-template-columns: 20px repeat(var(--dsr-wall-weeks, 53), 14px); grid-template-rows: 14px repeat(7, 14px); gap: 3px; width: max-content; }
.dsr-wallMonth { font-size: 10.5px; color: var(--dsr-faint); align-self: end; white-space: nowrap; overflow: hidden; }
.dsr-wallWeekday { font-size: 10px; color: var(--dsr-faint); display: flex; align-items: center; }
.dsr-wallCell { width: 14px; height: 14px; padding: 0; border: 0; border-radius: 2px; background: #ebedf0; cursor: pointer; }
.dsr-wallCell:hover { outline: 1px solid var(--dsr-muted); outline-offset: 1px; }
.dsr-wallCell.is-active { outline: 2px solid var(--dsr-primary); outline-offset: 1px; }
.dsr-wallCell.level-1, .dsr-wallSwatch.level-1 { background: #9be9a8; }
.dsr-wallCell.level-2, .dsr-wallSwatch.level-2 { background: #40c463; }
.dsr-wallCell.level-3, .dsr-wallSwatch.level-3 { background: #30a14e; }
.dsr-wallCell.level-4, .dsr-wallSwatch.level-4 { background: #216e39; }
.dsr-wallLegend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 2px; font-size: 11px; color: var(--dsr-faint); }
.dsr-wallSwatch { width: 12px; height: 12px; border-radius: 2px; background: #ebedf0; }.dsr-wallLegend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 4px; font-size: 11px; color: var(--dsr-faint); }
.dsr-wallSwatch { width: 12px; height: 12px; border-radius: 2px; }
.dsr-stt-note { margin: 0; font-size: 12px; color: #b0672f; }
.dsr-stt-summary { display: flex; align-items: baseline; gap: 22px; flex-wrap: wrap; }
.dsr-stt-summary .dsr-stt-add { margin-left: auto; }
.dsr-stt-figure { margin: 0; display: flex; align-items: baseline; gap: 6px; }
.dsr-stt-figure strong { font-size: 22px; font-weight: 650; line-height: 1.1; color: var(--dsr-ink); font-variant-numeric: tabular-nums; }
.dsr-stt-figure span { font-size: 12px; color: var(--dsr-muted); }
.dsr-stt-summary .dsr-stt-add { font-size: 12px; color: var(--dsr-green); font-variant-numeric: tabular-nums; }
.dsr-stt-summary .dsr-stt-del { font-size: 12px; color: var(--dsr-red); font-variant-numeric: tabular-nums; }
.dsr-stt-branches { display: flex; flex-direction: column; gap: 7px; max-width: 720px; }
.dsr-stt-branch { display: grid; grid-template-columns: 140px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.dsr-stt-branchName { font-size: 12px; color: var(--dsr-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-stt-branchTrack { height: 6px; border-radius: 3px; background: var(--dsr-sunken); overflow: hidden; }
.dsr-stt-branchFill { height: 100%; border-radius: 3px; background: var(--dsr-primary); }
.dsr-stt-branchMeta { font-size: 11.5px; color: var(--dsr-muted); font-variant-numeric: tabular-nums; }
.dsr-stt-activity { display: flex; flex-direction: column; }
.dsr-stt-activityTitle { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 6px; font-size: 13px; font-weight: 600; color: var(--dsr-ink); }
.dsr-stt-month { border-bottom: 1px solid var(--dsr-line); }
.dsr-stt-monthRow { display: flex; align-items: center; gap: 12px; width: 100%; height: 40px; padding: 0 2px; border: 0; background: transparent; color: var(--dsr-ink); font: inherit; cursor: pointer; text-align: left; }
.dsr-stt-monthLabel { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.dsr-stt-monthBar { flex: 1; max-width: 380px; height: 6px; border-radius: 3px; background: var(--dsr-sunken); overflow: hidden; }
.dsr-stt-monthBarFill { height: 100%; border-radius: 3px; background: #30a14e; }
.dsr-stt-monthCount { margin-left: auto; font-size: 12px; color: var(--dsr-muted); font-variant-numeric: tabular-nums; }
.dsr-stt-monthChevron { display: inline-flex; color: var(--dsr-muted); transition: transform 120ms ease; }
.dsr-stt-monthChevron.open { transform: rotate(90deg); }
.dsr-stt-days { display: flex; flex-direction: column; padding: 2px 0 8px; }
.dsr-stt-day { border-bottom: 1px solid var(--dsr-line); }
.dsr-stt-day:last-child { border-bottom: 0; }
.dsr-stt-dayRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; }
.dsr-stt-dayBtn { display: inline-flex; align-items: center; gap: 8px; height: 26px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsr-ink); font: inherit; cursor: pointer; }
.dsr-stt-dayBtn:hover { background: var(--dsr-hover); }
.dsr-stt-dayDate { font-size: 13px; font-variant-numeric: tabular-nums; }
.dsr-stt-dayCount { color: var(--dsr-muted); font-size: 11.5px; }
.dsr-stt-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dsr-stt-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 0; border-radius: 999px;
  background: var(--dsr-sunken); color: #4c5658; font: inherit; font-size: 11.5px; cursor: pointer;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsr-stt-chip:hover { background: #e3e8e8; color: var(--dsr-ink); }
.dsr-stt-dayDetail { padding: 2px 0 10px 8px; display: flex; flex-direction: column; gap: 2px; }
.dsr-stt-dayHead, .dsr-dayHead { display: none; }
.dsr-day, .dsr-stt-dayItem { display: flex; align-items: baseline; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.dsr-day:hover, .dsr-stt-dayItem:hover { background: var(--dsr-hover); }
.dsr-stt-empty { padding: 40px 16px; text-align: center; color: var(--dsr-muted); font-size: 12.5px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.dsr-stt-error { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(180, 35, 24, 0.24); background: #fbe4e0; color: #a24b3a; font-size: 12px; display: flex; align-items: center; gap: 10px; }
.dsr-stt-genWrap { display: inline-flex; }

/* ===== 同步 / 设置 ===== */
.dsr-sync { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 28px; display: flex; flex-direction: column; gap: 14px; }
.dsr-syncCard, .dsr-settings .dsr-syncCard { border: 1px solid var(--dsr-line); border-radius: 14px; background: var(--dsr-raised); box-shadow: var(--dsr-shadow-card); overflow: hidden; }
.dsr-syncCardHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--dsr-line); }
.dsr-syncCardTitle { font-size: 13px; font-weight: 600; }
.dsr-syncCardBody { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsr-formGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsr-btnRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsr-progressRow { display: flex; flex-direction: column; gap: 6px; }
.dsr-progressHead { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; color: var(--dsr-muted); }
.dsr-progressTrack { height: 6px; border-radius: 3px; background: var(--dsr-sunken); overflow: hidden; }
.dsr-progressFill { height: 100%; border-radius: 3px; background: var(--dsr-primary); }
.dsr-kvGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px 16px; }
.dsr-kv { display: flex; flex-direction: column; gap: 2px; }
.dsr-kvLabel { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-kvValue { font-size: 13px; color: var(--dsr-ink); font-variant-numeric: tabular-nums; }
.dsr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsr-table th { text-align: left; padding: 6px 8px; color: var(--dsr-muted); font-weight: 600; border-bottom: 1px solid var(--dsr-line); }
.dsr-table td { padding: 6px 8px; border-bottom: 1px solid var(--dsr-line); color: var(--dsr-ink); }
.dsr-checkList { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; border: 1px solid var(--dsr-line); border-radius: 10px; padding: 6px; }
.dsr-checkRow { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; }
.dsr-checkRow:hover { background: var(--dsr-hover); }
.dsr-checkName { color: var(--dsr-ink); }
.dsr-checkNs { color: var(--dsr-faint); font-size: 11.5px; }
.dsr-noticeBar { padding: 8px 10px; border-radius: 8px; background: #fbe7d6; border: 1px solid #f0cdb2; color: #b0672f; font-size: 12px; }
.dsr-pageTitle { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
.dsr-pageIntro, .dsr-pageHint { font-size: 12px; color: var(--dsr-muted); }
.dsr-settings { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 28px; display: flex; flex-direction: column; gap: 14px; }
.dsr-settings .dsr-tabs { margin-bottom: 2px; }
.dsr-settings .dsr-pageTitle { display: none; }
.dsr-tplGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.dsr-tplTabs { display: flex; gap: 6px; flex-wrap: wrap; }
.dsr-tplNote { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-inlineMeta { font-size: 12px; color: var(--dsr-muted); }
.dsr-section { font-size: 13px; font-weight: 600; margin: 4px 0; }
.dsr-rowBetween { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsr-num { font-variant-numeric: tabular-nums; }
.dsr-hint { font-size: 11.5px; color: var(--dsr-faint); }
.dsr-mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11.5px; }

@media (max-width: 900px) {
  .dsr-aside { width: 280px; }
  .dsr-rpt-kpiGrid, .dsr-rpt-summaryGrid { grid-template-columns: 1fr; }
}

.dsr-settingsRoot { height: auto; min-height: 100%; background: transparent; }
.dsr-settingsSection .dsr-settings { padding: 0; overflow: visible; }
.dsr-listPane .dsr-rpt-top { display: none; }
.dsr-settingsSection .dsr-settings .dsr-pageTitle { display: none; }

.dsr-spacer { flex: 1 1 auto; }
.dsr-listPane { background: var(--dsw-alias-bg-layer-2, transparent); }

/* ===== DSH 风格收口（取值参考 packages/client/ui-theme + ui-primitives） ===== */
.dsr-root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
}
.dsr-pageHead { padding: 18px 24px 12px; gap: 8px; }
.dsr-pageTitle { font-size: 18px; font-weight: 600; letter-spacing: 0; }
.dsr-pageSub { font-size: 13px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-pageTabs {
  display: flex; align-items: flex-end; gap: 22px; flex: none;
  padding: 0 24px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
}
.dsr-pageTab {
  height: auto; padding: 7px 1px 9px; margin: 0; border: 0; border-radius: 2px;
  background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsr-muted));
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; position: relative;
}
.dsr-pageTab:hover { color: var(--dsw-alias-label-primary, var(--dsr-ink)); }
.dsr-pageTab.active { color: var(--dsw-alias-label-primary, var(--dsr-ink)); font-weight: 500; border-bottom-color: transparent; }
.dsr-pageTab.active::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary, var(--dsr-ink));
}
.dsr-listPane { width: 304px; border-right: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); background: transparent; }

/* 按钮：胶囊几何（md 36 / sm 28），主按钮为墨色填充 */
.dsr-btn {
  height: 28px; padding: 0 10px; gap: 4px; border: 0; border-radius: 14px;
  background: transparent; color: var(--dsw-alias-label-primary, var(--dsr-ink));
  font: inherit; font-size: 12px; line-height: 18px; font-weight: 400; box-shadow: none;
}
.dsr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, var(--dsr-selected)); }
.dsr-btn.primary {
  background: var(--dsw-alias-brand-primary, var(--dsr-primary));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 500; box-shadow: none;
}
.dsr-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsr-primary-dark)); }
.dsr-btn.danger { background: transparent; color: var(--dsw-alias-state-error-primary, var(--dsr-red)); border: 0; }
.dsr-btn.sm, .dsr-btn--sm { height: 28px; padding: 0 10px; font-size: 12px; }
.dsr-iconbtn { width: 28px; height: 28px; border-radius: 50%; }

/* 输入框：32px / r8 / 0.5px 描边 / 取消内阴影 */
.dsr-input, .dsr-textarea, .dsr-select {
  height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsr-line-strong));
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, var(--dsr-raised));
  box-shadow: none; font-size: 13px;
}
.dsr-input:focus, .dsr-textarea:focus, .dsr-select:focus {
  outline: none; border-color: var(--dsw-alias-brand-primary, var(--dsr-primary)); box-shadow: none;
}
.dsr-textarea { padding: 8px 10px; }
.dsr-badge {
  height: 18px; padding: 0 6px; border-radius: 5px;
  background: var(--dsw-alias-fill-l2, var(--dsr-sunken));
  color: var(--dsw-alias-label-secondary, var(--dsr-muted)); font-size: 11px; font-weight: 500;
}
.dsr-fieldLabel { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, var(--dsr-ink)); }
.dsr-fieldHint { font-size: 12px; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }

/* Tab（报告详情/模板）：13px + 墨色 2px 下划线 */
.dsr-tabs, .dsr-rpt-tabs { display: flex; align-items: flex-end; gap: 22px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); }
.dsr-tab, .dsr-rpt-tabBtn {
  height: auto; padding: 7px 1px 9px; margin: 0; border: 0; border-radius: 2px;
  background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsr-muted));
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 400; position: relative; cursor: pointer;
}
.dsr-tab:hover, .dsr-rpt-tabBtn:hover { color: var(--dsw-alias-label-primary, var(--dsr-ink)); }
.dsr-tab.active, .dsr-rpt-tabBtn.active { color: var(--dsw-alias-label-primary, var(--dsr-ink)); font-weight: 500; border-bottom-color: transparent; }
.dsr-tab.active::after, .dsr-rpt-tabBtn.active::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary, var(--dsr-ink));
}

/* 报告树 / 仓库树 / 活动行：30px 行高，交互色取 DSH interactive token */
.dsr-rpt-rail, .dsr-stt-aside { padding: 12px 12px 16px; gap: 10px; }
.dsr-rpt-seg { height: 28px; padding: 2px; border-radius: 14px; background: var(--dsw-alias-bg-layer-2, var(--dsr-sunken)); }
.dsr-rpt-segBtn { height: 24px; border-radius: 12px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-rpt-segBtn.active {
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, var(--dsr-ink));
  font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.dsr-rpt-groupHead, .dsr-rpt-item, .dsr-repoTreeRow {
  height: 30px; min-height: 30px; border-radius: 8px; font-size: 13px;
}
.dsr-rpt-groupHead:hover, .dsr-rpt-item:hover, .dsr-repoTreeRow:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover));
}
.dsr-rpt-item.active, .dsr-repoTreeRow.active { background: var(--dsw-alias-interactive-bg-active, var(--dsr-selected)); }
.dsr-rpt-chip, .dsr-rpt-chip[data-type] {
  height: 18px; padding: 0 6px; border-radius: 5px; font-size: 11px; font-weight: 500;
  background: var(--dsw-alias-fill-l2, var(--dsr-sunken));
  color: var(--dsw-alias-label-secondary, var(--dsr-muted));
}
.dsr-rpt-state { color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }

/* 报告详情：tab strip 与卡片全部去阴影、统一 0.5px 描边 */
.dsr-rpt-main { background: transparent; }
.dsr-rpt-tabStrip {
  position: sticky; top: 0; z-index: 6; height: 38px; padding: 0 24px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  background: var(--dsw-alias-bg-base, transparent);
}
.dsr-rpt-tab { height: 26px; border-radius: 13px; background: var(--dsw-alias-interactive-bg-hover, var(--dsr-selected)); font-size: 12px; }
.dsr-rpt-tabStrip .dsr-rpt-chip { background: transparent; padding: 0; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }
.dsr-rpt-content { padding: 18px 24px 40px; gap: 14px; }
.dsr-rpt-meta { font-size: 13px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-rpt-kpi {
  min-height: 72px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  border-top: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: none;
}
.dsr-rpt-kpi:nth-child(1), .dsr-rpt-kpi:nth-child(2), .dsr-rpt-kpi:nth-child(3) {
  border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  border-top: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.dsr-rpt-kpi.accent { border-top-color: var(--dsw-alias-border-l2, var(--dsr-line-strong)); }
.dsr-rpt-kpiValue { font-size: 22px; font-weight: 600; }
.dsr-rpt-kpi:nth-child(2) .dsr-rpt-kpiValue, .dsr-rpt-kpi:nth-child(3) .dsr-rpt-kpiValue { color: var(--dsw-alias-label-primary, var(--dsr-ink)); }
.dsr-rpt-card, .dsr-rpt-topic { border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); border-radius: 12px; box-shadow: none; background: var(--dsw-alias-bg-layer-1, #fff); }
.dsr-rpt-cardTitle, .dsr-rpt-sectionTitle { font-size: 14px; font-weight: 600; }
.dsr-rpt-md { max-width: 820px; font-size: 13px; line-height: 1.6; }
.dsr-rpt-md h1 { font-size: 17px; font-weight: 600; }
.dsr-rpt-md h2 { font-size: 15px; font-weight: 600; }
.dsr-rpt-md h3 { font-size: 14px; font-weight: 600; }

/* 统计页：标题 20/600；范围组用中性分段；工具按钮胶囊 */
.dsr-stt-main { padding: 20px 24px 28px; }
.dsr-stt-name { font-size: 20px; font-weight: 600; letter-spacing: 0; }
.dsr-stt-rule { font-size: 13px; }
.dsr-stt-ranges { background: var(--dsw-alias-bg-layer-2, var(--dsr-sunken)); box-shadow: none; border-radius: 999px; padding: 2px; }
.dsr-stt-range { height: 26px; border-radius: 999px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-stt-range.active { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, var(--dsr-ink)); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.dsr-stt-dates { height: 32px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: none; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsr-line-strong)); }
.dsr-stt-date { font-size: 13px; }
.dsr-stt-tools .dsr-btn.primary { border-radius: 16px; height: 32px; padding: 0 14px; }
.dsr-stt-tools .dsr-btn { height: 32px; border-radius: 16px; font-size: 13px; padding: 0 14px; }
.dsr-stt-figure strong { font-size: 20px; font-weight: 600; }
.dsr-stt-branchTrack, .dsr-stt-monthBar { height: 6px; }
.dsr-stt-monthLabel { font-size: 14px; font-weight: 500; }
.dsr-stt-monthRow { height: 40px; border-radius: 8px; }
.dsr-stt-monthRow:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }

/* 设置分区：18/600 标题、13 辅助、卡片 r16 + 0.5px 描边 */
.dsr-settingsSection .dsr-pageTitle { display: block; font-size: 18px; font-weight: 600; }
.dsr-settingsSection .dsr-pageIntro { font-size: 13px; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }
.dsr-syncCard { border: 0.5px solid var(--dsw-alias-border-l4, var(--dsr-line-strong)); border-radius: 16px; background: var(--dsw-alias-bg-layer-3, var(--dsr-raised)); box-shadow: none; }
.dsr-syncCardHead { padding: 14px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); }
.dsr-syncCardTitle { font-size: 15px; font-weight: 600; }
.dsr-syncCardBody { padding: 14px 16px; gap: 14px; }
.dsr-settings .dsr-field { gap: 6px; }
.dsr-settings .dsr-btn { margin-top: 2px; }
.dsr-kvLabel { font-size: 12px; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }
.dsr-kvValue { font-size: 13px; }


/* 普通按钮统一 0.5px 描边（交付台账同款小按钮） */
.dsr-btn:not(.primary) { border: 0.5px solid var(--dsw-alias-border-l3, var(--dsr-line-strong)); background: transparent; }
.dsr-btn:not(.primary):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }

/* 页头普通按钮加 0.5px 描边（对齐交付台账的 刷新/重新扫描 按钮） */
.dsr-pageHead .dsr-btn:not(.primary) { border: 0.5px solid var(--dsw-alias-border-l3, var(--dsr-line-strong)); }
.dsr-pageHead .dsr-btn:not(.primary):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }

/* 设置分区：按交付台账的设置页做竖向字段布局（去卡片，改用细线分段） */
.dsr-settingsSection .dsr-settings { max-width: 760px; padding: 0; }
.dsr-settingsSection .dsr-syncCard {
  border: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  border-radius: 0; background: transparent; box-shadow: none;
}
.dsr-settingsSection .dsr-syncCardHead { padding: 14px 0 6px; border-bottom: 0; }
.dsr-settingsSection .dsr-syncCardBody { padding: 0 0 14px; gap: 12px; }
.dsr-settingsSection .dsr-syncCardTitle { font-size: 13px; font-weight: 620; }
.dsr-settingsSection .dsr-syncHead { gap: 8px; }

.dsr-aliasMsg { margin: 8px 0 0; font-size: 12px; line-height: 1.5; }
.dsr-aliasMsg.ok { color: var(--dsw-alias-state-success-primary, #15803d); }
.dsr-aliasMsg.warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.dsr-aliasList { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsr-aliasList li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-aliasList code { padding: 1px 6px; border-radius: 5px; background: var(--dsw-alias-fill-l2, var(--dsr-sunken)); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.dsr-syncEmbedded { padding-top: 0; }
.dsr-syncEmbedded .dsr-pageIntro { display: none; }

.dsr-syncNotice { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, transparent); }
.dsr-syncNotice strong { font-size: 12.5px; font-weight: 600; }

.dsr-repoTreePicker { max-height: 340px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l1, var(--dsr-line)); border-radius: 10px; padding: 6px; }
.dsr-repoGroup + .dsr-repoGroup { margin-top: 4px; }
.dsr-repoGroupHead {
  display: flex; align-items: center; gap: 2px; min-height: 34px; padding: 3px 8px;
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03));
}
.dsr-repoGroupHead:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-repoChildren {
  margin-left: 10px; padding-left: 18px;
  border-left: 1px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
}
.dsr-repoChildren .dsr-repoGroupHead { background: transparent; min-height: 30px; }
.dsr-repoChildren .dsr-repoGroupHead:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-repoToggle {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsr-muted)); cursor: pointer;
}
.dsr-repoToggle:hover { color: var(--dsw-alias-label-primary, var(--dsr-ink)); background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-repoFolder { display: inline-flex; align-items: center; margin-right: 6px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-repoCheck { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; cursor: pointer; }
.dsr-repoCheck input { margin: 0; accent-color: var(--dsw-alias-brand-primary, var(--dsr-primary)); }
.dsr-repoLabel { font-weight: 600; color: var(--dsw-alias-label-primary, var(--dsr-ink)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsr-repoChildren .dsr-repoLabel { font-weight: 500; }
.dsr-repoCount {
  margin-left: 4px; padding: 0 6px; border-radius: 999px;
  background: var(--dsw-alias-fill-l2, rgba(0, 0, 0, 0.06));
  font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); font-variant-numeric: tabular-nums;
}
.dsr-repoRow { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.dsr-repoRow:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-repoName { font-size: 12.5px; color: var(--dsw-alias-label-primary, var(--dsr-ink)); white-space: nowrap; }
.dsr-repoPath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }

/* DSH 风格 tab：胶囊/分段，去掉黑色下划线 */
.dsr-pageTabs, .dsr-tabs, .dsr-rpt-tabs {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 4px; padding: 6px 18px 8px; border-bottom: 0;
}
.dsr-pageTab, .dsr-tab, .dsr-rpt-tabBtn {
  height: 28px; padding: 0 12px; margin: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, var(--dsr-muted));
  font: inherit; font-size: 13px; line-height: 28px; font-weight: 400;
  position: static; cursor: pointer;
}
.dsr-pageTab:hover, .dsr-tab:hover, .dsr-rpt-tabBtn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover));
  color: var(--dsw-alias-label-primary, var(--dsr-ink));
}
.dsr-pageTab.active, .dsr-tab.active, .dsr-rpt-tabBtn.active {
  background: var(--dsw-alias-interactive-bg-active, var(--dsr-selected));
  color: var(--dsw-alias-label-primary, var(--dsr-ink));
  font-weight: 500; border: 0;
}
.dsr-pageTab.active::after, .dsr-tab.active::after, .dsr-rpt-tabBtn.active::after,
.dsr-pageTab.active::before, .dsr-tab.active::before, .dsr-rpt-tabBtn.active::before {
  content: none; display: none;
}
/* 已打开报告的 tab：胶囊 chip，无下划线 */
.dsr-rpt-tabStrip {
  height: 40px; padding: 0 18px; gap: 6px;
  border-bottom: 0; background: var(--dsw-alias-bg-base, transparent);
}
.dsr-rpt-tab {
  height: 28px; padding: 0 10px; border-radius: 8px; box-shadow: none;
  border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong));
  background: transparent; font-size: 12px;
}
.dsr-rpt-tab.active {
  box-shadow: none; border-color: transparent;
  background: var(--dsw-alias-interactive-bg-active, var(--dsr-selected));
}
.dsr-rpt-tabClose { width: 16px; height: 16px; border-radius: 4px; }

/* ===== 官方 primitives 照抄（Button/Input/Tag/Pill/Modal） =====
 * 数值直接取自 DSH 源码：
 *   ui-primitives/Button.module.css（h36/r18 · sm h28/r14）
 *   ui-primitives/Input.module.css（h32/r8 · 0.5px 描边）
 *   ui-settings-plugins/fields.module.css（h34/r8 · bg layer-3）
 *   ui-primitives/Tag.module.css（r999 · 11px）
 *   ui-primitives/Pill.module.css（h24/r12 · ghost-active）
 *   ui-primitives/Modal.module.css（r24 · mask + elevation-prominent）
 * 只保留 --dsw-alias-* token，不自造圆角/阴影。
 */

/* ---- Button（md 36 / sm 28） ---- */
.dsr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 36px; padding: 0 14px; border: 0; border-radius: 18px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px; font-weight: 400;
  box-shadow: none; cursor: pointer;
}
.dsr-btn.sm { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; line-height: 18px; }
.dsr-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dsr-btn:not(.primary) { border: 0; background: transparent; }
.dsr-btn:not(.primary):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsr-btn:not(.primary):active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsr-btn.primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  border: 0; font-weight: 500;
}
.dsr-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsr-btn.danger { border: 0; background: transparent; color: var(--dsw-alias-state-error-primary); }
.dsr-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
/* Dialog 里的取消按钮用 outline 胶囊（Modal 取消按钮形态） */
.dsr-dialog .dsr-btn:not(.primary) { border: 0.5px solid var(--dsw-alias-border-l3); }
.dsr-dialog .dsr-btn:not(.primary):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsr-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsr-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsr-iconbtn.sm { width: 24px; height: 24px; border-radius: 6px; }

/* ---- Input / Textarea / Select（h34 · r8 · 0.5px · bg layer-3） ---- */
.dsr-input, .dsr-textarea, .dsr-select {
  box-sizing: border-box; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 1.5; box-shadow: none;
}
.dsr-textarea { height: auto; padding: 10px 12px; min-height: 96px; resize: vertical; }
.dsr-input::placeholder, .dsr-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsr-input:focus, .dsr-textarea:focus, .dsr-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsr-input:disabled, .dsr-textarea:disabled, .dsr-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }

/* ---- Tag / Badge（r999 · 11px · tone 走 status token 10~12% 混色） ---- */
.dsr-badge, .dsr-tag {
  display: inline-flex; align-items: center; border: 0; border-radius: 999px; corner-shape: round;
  padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2);
}
.dsr-badge.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dsr-badge.warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dsr-badge.bad { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }

/* ---- Tabs（Pill 形态：h24/r12，选中 ghost-active） ---- */
.dsr-pageTabs, .dsr-tabs, .dsr-rpt-tabs {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  padding: 6px 18px 8px; border-bottom: 0;
}
.dsr-pageTab, .dsr-tab, .dsr-rpt-tabBtn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 8px; margin: 0; border: 0; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; font-weight: 400; cursor: pointer;
  box-shadow: none;
}
.dsr-pageTab:hover, .dsr-tab:hover, .dsr-rpt-tabBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsr-pageTab.active, .dsr-tab.active, .dsr-rpt-tabBtn.active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
  font-weight: 400;
}
.dsr-rpt-tabStrip { height: 40px; padding: 0 18px; gap: 6px; border-bottom: 0; background: var(--dsw-alias-bg-base, transparent); }
.dsr-rpt-tab {
  height: 24px; padding: 0 8px; border: 0; border-radius: 12px; box-shadow: none;
  background: var(--dsw-alias-bg-layer-2); font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.dsr-rpt-tab.active { background: var(--dsw-alias-button-ghost-active-fill); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border); }

/* ---- Modal（Modal.module.css：mask + r24 卡片） ---- */
.dsr-dialogMask {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur);
}
.dsr-dialog {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 0;
  width: min(560px, 100%); max-width: calc(100vw - 48px); max-height: calc(100vh - 48px);
  overflow: hidden; padding: 0 0 24px; border: 0; border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent);
}
.dsr-dialogHead {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 22px 14px 12px 24px;
}
.dsr-dialogTitle { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsr-dialogBody { display: flex; flex-direction: column; gap: 12px; padding: 0 24px; min-height: 0; overflow: auto; }
.dsr-dialogFoot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 16px 24px 0; }

/* ===== 交付台账式单栏：统计卡 / 过滤 chips / 密集行 / 行内展开 ===== */
.dsr-cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 10px; }
.dsr-card {
  min-width: 118px; padding: 9px 13px; box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 3%, transparent);
}
.dsr-cardValue { font-size: 20px; font-weight: 650; line-height: 1.2; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, var(--dsr-ink)); }
.dsr-cardValue.ok { color: var(--dsw-alias-state-success-primary, #15803d); }
.dsr-cardValue.brand { color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsr-primary)); }
.dsr-cardLabel { margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 18px 8px; }
.dsr-filterLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); margin-right: 2px; }
.dsr-filter {
  padding: 2px 9px; border: 0.5px solid transparent; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, var(--dsr-muted));
  font: inherit; font-size: 12px; line-height: 20px; cursor: pointer;
}
.dsr-filter:hover { color: var(--dsw-alias-label-primary, var(--dsr-ink)); background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-filter.active {
  color: var(--dsw-alias-label-primary, var(--dsr-ink)); font-weight: 500;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 7%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 12%, transparent);
}
.dsr-grow { flex: 1 1 auto; }
.dsr-search { width: 190px; margin-left: auto; }
.dsr-body { flex: 1; min-height: 0; overflow: auto; padding: 0 18px 24px; }
.dsr-rowList { border-top: 0.5px solid var(--dsw-alias-border-l1, var(--dsr-line)); }
.dsr-rowItem {
  display: grid; grid-template-columns: 64px minmax(0, 1fr) 88px 96px 110px 18px;
  gap: 10px; align-items: center; min-height: 38px; padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
  border-left: 2px solid transparent; border-radius: 6px; cursor: pointer;
  font-size: 12.5px; line-height: 1.35; color: var(--dsw-alias-label-primary, var(--dsr-ink));
}
.dsr-rowItem:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsr-hover)); }
.dsr-rowItem.active { background: var(--dsw-alias-interactive-bg-active, var(--dsr-selected)); }
.dsr-rowItem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, var(--dsr-primary)); outline-offset: -2px; }
.dsr-rowItem[data-tone='ok'] { border-left-color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsr-rowItem[data-tone='brand'] { border-left-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6); }
.dsr-rowItem[data-tone='err'] { border-left-color: var(--dsw-alias-state-error-primary, #ec1313); }
.dsr-rowItem[data-tone='idle'] { border-left-color: var(--dsw-alias-state-idle-primary, #cfd3d6); }
.dsr-rowBadge { display: inline-flex; width: fit-content; padding: 1px 8px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, var(--dsr-line-strong)); font-size: 11px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-rowMain { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dsr-rowTitle { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsr-rowMeta { font-size: 11.5px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); }
.dsr-rowNum, .dsr-rowTime { font-size: 12px; color: var(--dsw-alias-label-secondary, var(--dsr-muted)); font-variant-numeric: tabular-nums; text-align: right; }
.dsr-rowChev { display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); transition: transform 0.12s ease; }
.dsr-rowChev.open { transform: rotate(180deg); }
.dsr-rowDetail { padding: 0 10px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05)); }
.dsr-rowDetail .dsr-rpt-tabStrip { display: none; }
.dsr-rowDetail .dsr-rpt-main { min-height: 0; }
.dsr-rowDetail .dsr-rpt-content { padding: 12px 0 8px; }
.dsr-pageFoot { display: flex; align-items: center; gap: 10px; padding: 12px 2px 0; }
.dsr-footHint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsr-muted)); }
.dsr-splitStats { min-height: 0; }
`);

// ---------------------------------------------------------------- 文案
const zh = {
  nav: '报告',
  title: '工作报告',
  close: '关闭',
  settings: '设置',
  back: '返回',
  areaReports: '报告',
  areaStats: '统计',
  areaSettings: '设置',
  loading: '加载中…',
  failed: '加载失败',
  retry: '重试',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  delete: '删除',
  export: '导出',
  regenerate: '重生成',
  more: '更多',
  newReport: '新建报告',
  refresh: '刷新',
  searchReport: '搜索报告…',
  searchRepo: '搜索仓库',
  allRepos: '全部仓库',
  filterAll: '全部',
  emptyTitle: '还没有报告',
  emptyHint: '生成本地报告，或先去同步提交。',
  selectTitle: '选择一份报告',
  selectHint: '从左侧打开报告查看正文和统计。',
  reportTab: '正文',
  statsTab: '统计',
  generatedAt: '生成时间',
  period: '周期',
  commits: '提交',
  repositories: '仓库',
  totalLines: '行变更',
  generateTitle: '新建报告',
  reportType: '报告类型',
  startDate: '开始日期',
  endDate: '结束日期',
  quickRange: '快捷范围',
  generate: '开始生成',
  generating: '生成中…',
  deleteConfirm: '确认删除这份报告？',
  ruleText: '不含合并和拣选',
  query: '查询',
  syncData: '同步数据',
  generateReport: '生成报告',
  activity: '提交记录',
  coverageNote: '有些日子还没同步，这里只统计本地已有的提交。',
  noCommitsInRange: '该范围内没有本地提交。',
  syncTitle: '同步 GitLab 数据',
  settingsTitle: '设置',
  templates: '模板与写作指引',
  saved: '已保存',
  templateEdit: '编辑模板',
  exportMarkdown: '导出 Markdown',
  quickRanges: { last7: '近 7 天', last30: '近 30 天', week: '本周', month: '本月', lastMonth: '上个月', last12: '近一年' },
};

const en = {
  nav: 'Reports',
  title: 'Reports & stats',
  close: 'Close',
  settings: 'Settings',
  back: 'Back',
  areaReports: 'Reports',
  areaStats: 'Stats',
  areaSettings: 'Settings',
  loading: 'Loading…',
  failed: 'Failed to load',
  retry: 'Retry',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  delete: 'Delete',
  export: 'Export',
  regenerate: 'Regenerate',
  more: 'More',
  newReport: 'New report',
  refresh: 'Refresh',
  searchReport: 'Search reports…',
  searchRepo: 'Search repositories',
  allRepos: 'All repositories',
  filterAll: 'All',
  emptyTitle: 'No reports yet',
  emptyHint: 'Generate a report, or sync commits first.',
  selectTitle: 'Select a report',
  selectHint: 'Open a report on the left to see its content and stats.',
  reportTab: 'Content',
  statsTab: 'Stats',
  generatedAt: 'Generated at',
  period: 'Period',
  commits: 'Commits',
  repositories: 'Repositories',
  totalLines: 'Line changes',
  generateTitle: 'New report',
  reportType: 'Report type',
  startDate: 'Start date',
  endDate: 'End date',
  quickRange: 'Quick range',
  generate: 'Generate',
  generating: 'Generating…',
  deleteConfirm: 'Delete this report?',
  ruleText: 'Excludes merges and cherry-picks',
  query: 'Query',
  syncData: 'Sync data',
  generateReport: 'Generate report',
  activity: 'Commit activity',
  coverageNote: 'Some days are not synced yet; only local commits are counted.',
  noCommitsInRange: 'No local commits in this range.',
  syncTitle: 'Sync GitLab data',
  settingsTitle: 'Settings',
  templates: 'Templates and guidance',
  saved: 'Saved',
  templateEdit: 'Edit template',
  exportMarkdown: 'Export Markdown',
  quickRanges: { last7: 'Last 7 days', last30: 'Last 30 days', week: 'This week', month: 'This month', lastMonth: 'Last month', last12: 'Last 12 months' },
};

const extraZh = {"typeWeek":"周报","typeMonth":"月报","typeQuarter":"季报","typeYear":"年报","statusPending":"待生成","statusGenerating":"生成中","statusCompleted":"已完成","statusFailed":"失败","jobPending":"等待中","jobRunning":"同步中","jobCompleted":"已完成","jobFailed":"失败","jobCancelled":"已取消","less":"少","more":"多","thisWeek":"本周","thisYearCommits":"这一年提交","reposCount":"个仓库","starting":"启动中…","cancelRequested":"正在取消…","syncStarted":"已创建同步任务","saved":"已保存","saveSelection":"保存范围","clearAll":"清空","selectAll":"全选","reset":"重置","reload":"重新加载","available":"可同步","selected":"已选","projectQuery":"搜索仓库","previewCoverage":"覆盖度","lineWithMerge":"含合并","lineWithoutMerge":"不含合并","ruleExcludeMerge":"不含合并和拣选","tagMerge":"合并","tagCherry":"拣选","noTitle":"（没有标题）","trendTitle":"趋势","commitLog":"提交记录","statistics":"统计","summary":"摘要","range":"范围","status":"状态","noStats":"暂无统计数据","noStatsHint":"该报告还没有生成统计数据","repoBreakdown":"仓库明细","domainDist":"业务域","topics":"主题","totalChange":"总变更","netChange":"净变更","pureAdditions":"净新增","lineStats":"行数口径","noRepos":"暂无仓库","noReposHint":"同步提交后这里会显示仓库","repoTreeEmpty":"还没有仓库","emptyRange":"该范围内没有本地提交","emptyRangeHint":"换个日期范围，或先去同步数据","syncWindow":"同步窗口","syncWindowHint":"只同步该窗口内的提交","windowRequired":"请选择日期范围","windowReversed":"开始日期不能晚于结束日期","baseUrl":"GitLab 地址","baseUrlRequired":"请填写 GitLab 地址","token":"Access Token","tokenKeepHint":"留空表示沿用已保存的 Token","tokenNewHint":"输入后保存到本机凭据库","tokenSaved":"已保存 Token","tokenMissing":"未保存 Token","noConnection":"还没有 GitLab 连接","connection":"GitLab 连接","connectionSelect":"选择连接","connectionRequired":"请先选择或保存连接","connectionSaved":"连接已保存","connectionSavedNoVerify":"连接已保存（未校验）","refreshConnection":"刷新连接","refreshProjects":"刷新仓库","noProjects":"没有可选仓库","noProjectsHint":"检查 Token 权限（read_api）或连接","projectsHint":"勾选要同步的仓库","projectQueryHint":"按名称或路径过滤","saveConnection":"保存连接","syncTitle":"同步 GitLab 数据","syncHint":"先保存 GitLab 连接并选择仓库，再同步指定窗口的提交","syncDialogHint":"同步会写入本地数据库；大范围会覆盖该区间内的本地提交","syncPageMissing":"同步页面未加载","noActiveJob":"当前没有进行中的任务","noJobs":"还没有同步任务","noJobsHint":"创建任务后会显示在这里","jobs":"同步任务","commitsSynced":"已入库提交","repoProgress":"仓库进度","currentProject":"当前仓库","startedAt":"开始时间","finishedAt":"结束时间","dataDir":"数据目录","timezone":"时区","timezoneHint":"只影响周期计算与显示，不改已存日期","defaultReportType":"默认报告类型","template":"模板","guidance":"写作指引","templates":"模板与写作指引","templatesHint":"模板决定正文骨架，guidance 是追加写作约束；保存后新生成的报告立即生效","templatesNote":"恢复默认需要清空文本框后保存，或在配置文件里删除对应键。","templatePlaceholder":"编辑模板…","guidancePlaceholder":"编辑写作指引…","saveTemplates":"保存模板","settingsTitle":"设置","settingsIntro":"连接、时区与写作模板都保存在本机 profile，不写入报告数据。","settingsHint":"Token 保存在本机 DSH 凭据库，不写入明文配置。","rebuild":"重新加载","error":"出错了","dayExpand":"查看这一天的提交","dayCollapse":"收起这一天的提交","dayNoCommits":"这一天没有本地提交","dayTruncated":"这一天提交比较多，先显示前 200 条","dayCommitsFailed":"当天提交加载失败","dayPickHint":"点某一天查看当天提交","noActivity":"这段时间还没有提交","noActivityHint":"先去同步数据，或换一个范围","activeDays":"活跃天数","branches":"分支","additions":"新增","deletions":"删除","mergeCommits":"合并提交","cherryPicks":"拣选提交"};
const extraEn = {"typeWeek":"Weekly","typeMonth":"Monthly","typeQuarter":"Quarterly","typeYear":"Yearly","statusPending":"Pending","statusGenerating":"Generating","statusCompleted":"Done","statusFailed":"Failed","jobPending":"Pending","jobRunning":"Running","jobCompleted":"Done","jobFailed":"Failed","jobCancelled":"Cancelled","less":"Less","more":"More","thisWeek":"This week","thisYearCommits":"commits this year","reposCount":"repos","starting":"Starting…","cancelRequested":"Cancelling…","syncStarted":"Sync job created","saved":"Saved","saveSelection":"Save selection","clearAll":"Clear","selectAll":"Select all","reset":"Reset","reload":"Reload","available":"Available","selected":"Selected","projectQuery":"Search repositories","previewCoverage":"Coverage","lineWithMerge":"With merges","lineWithoutMerge":"Without merges","ruleExcludeMerge":"Excludes merges and cherry-picks","tagMerge":"Merge","tagCherry":"Cherry-pick","noTitle":"(no title)","trendTitle":"Trend","commitLog":"Commit activity","statistics":"Statistics","summary":"Summary","range":"Range","status":"Status","noStats":"No statistics yet","noStatsHint":"This report has no generated statistics yet","repoBreakdown":"Repositories","domainDist":"Domains","topics":"Topics","totalChange":"Total changes","netChange":"Net","pureAdditions":"Net additions","lineStats":"Line stats","noRepos":"No repositories","noReposHint":"Repositories appear after syncing","repoTreeEmpty":"No repositories yet","emptyRange":"No local commits in this range","emptyRangeHint":"Try another range or sync data first","syncWindow":"Sync window","syncWindowHint":"Only commits in this window are synced","windowRequired":"Pick a date range","windowReversed":"Start date must not be after end date","baseUrl":"GitLab URL","baseUrlRequired":"GitLab URL is required","token":"Access token","tokenKeepHint":"Leave empty to keep the saved token","tokenNewHint":"Stored in the local credential store","tokenSaved":"Token saved","tokenMissing":"No token saved","noConnection":"No GitLab connection yet","connection":"GitLab connection","connectionSelect":"Select connection","connectionRequired":"Pick or save a connection first","connectionSaved":"Connection saved","connectionSavedNoVerify":"Connection saved (unverified)","refreshConnection":"Refresh connection","refreshProjects":"Refresh repositories","noProjects":"No projects available","noProjectsHint":"Check the token scope (read_api) or connection","projectsHint":"Pick the repositories to sync","projectQueryHint":"Filter by name or path","saveConnection":"Save connection","syncTitle":"Sync GitLab data","syncHint":"Save a connection and pick repositories before syncing a window","syncDialogHint":"Syncing writes to the local database; a wide range replaces local commits in that window","syncPageMissing":"Sync page not loaded","noActiveJob":"No active job","noJobs":"No sync jobs yet","noJobsHint":"Jobs will appear here once created","jobs":"Sync jobs","commitsSynced":"Commits synced","repoProgress":"Progress","currentProject":"Current repository","startedAt":"Started","finishedAt":"Finished","dataDir":"Data directory","timezone":"Time zone","timezoneHint":"Affects period math only, not stored dates","defaultReportType":"Default report type","template":"Template","guidance":"Guidance","templates":"Templates and guidance","templatesHint":"Templates define the body skeleton; guidance adds writing constraints and applies to new reports.","templatesNote":"To restore defaults clear the textarea and save, or remove the key from config.","templatePlaceholder":"Edit template…","guidancePlaceholder":"Edit guidance…","saveTemplates":"Save templates","settingsTitle":"Settings","settingsIntro":"Connection, time zone and templates live in the local profile, not in report data.","settingsHint":"The token is stored in the DSH credential store, never in plain configuration.","rebuild":"Reload","error":"Something went wrong","dayExpand":"Show the commits of this day","dayCollapse":"Hide commits of this day","dayNoCommits":"No local commits on this day","dayTruncated":"Showing the first 200 commits of this day","dayCommitsFailed":"Failed to load day commits","dayPickHint":"Click a day to see its commits","noActivity":"No commits in this range","noActivityHint":"Sync data first or pick another range","activeDays":"Active days","branches":"Branches","additions":"Additions","deletions":"Deletions","mergeCommits":"Merge commits","cherryPicks":"Cherry-picks"};

/** 允许页面用兜底文案：tx(t, key, fallback) */
function tx(t, key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

// ---------------------------------------------------------------- 面板图标（sidebar.panellist）
function PanelIcon(props) {
  const size = (props && props.size) || 18
  const active = Boolean(props && props.active)
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    h('path', { d: 'M7 3.75h7.2L18 7.55v12.7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z' }),
    h('path', { d: 'M13.8 3.9v4h4.1' }),
    h('path', { d: 'M9 12h6M9 15.5h6M9 8.5h2' }),
  )
}

// ---------------------------------------------------------------- 主面板（main slot，保留原功能布局：左列表 + 右详情）

function ReportsPanel(props) {
  const t = (props && props.t) || ((key) => key)
  const state = useStore()
  React.useEffect(() => {
    bootstrap()
  }, [])
  const area = state.area === 'sync' ? 'sync' : 'reports'
  const listPane =
    area === 'sync'
      ? typeof StatsAside === 'function'
        ? h(StatsAside, { t, state, actions })
        : null
      : typeof ReportRail === 'function'
        ? h(ReportRail, { t, state, actions })
        : null
  const contentPane =
    area === 'sync'
      ? typeof StatsMain === 'function'
        ? h(StatsMain, { t, state, actions })
        : h(EmptyState, { title: '统计页面未加载' })
      : typeof ReportMain === 'function'
        ? h(ReportMain, { t, state, actions })
        : h(EmptyState, { title: '报告页面未加载' })

  return h(
    'section',
    { className: 'dsr-root', 'aria-label': tx(t, 'title', '工作报告') },
    h(
      'header',
      { className: 'dsr-pageHead' },
      h('h1', { className: 'dsr-pageTitle' }, tx(t, 'title', '工作报告')),
      h('span', { className: 'dsr-pageSub' }, tx(t, 'subtitle', '提交统计与报告生成')),
      h('span', { className: 'dsr-spacer' }),
      h(Button, { size: 'sm', onClick: () => actions.refreshReports(), disabled: state.reportsLoading }, state.reportsLoading ? tx(t, 'loading', '加载中…') : tx(t, 'refresh', '刷新')),
      h(Button, { variant: 'primary', size: 'sm', onClick: () => rpOpenGenerateDialog(null) }, tx(t, 'newReport', '新建报告')),
    ),
    h(
      'nav',
      { className: 'dsr-pageTabs', role: 'tablist' },
      h(
        'button',
        { type: 'button', role: 'tab', 'aria-selected': area === 'reports', className: `dsr-pageTab${area === 'reports' ? ' active' : ''}`, onClick: () => actions.setArea('reports') },
        tx(t, 'areaReports', '报告'),
      ),
      h(
        'button',
        { type: 'button', role: 'tab', 'aria-selected': area === 'sync', className: `dsr-pageTab${area === 'sync' ? ' active' : ''}`, onClick: () => actions.setArea('sync') },
        tx(t, 'areaStats', '统计'),
      ),
    ),
    h(
      'div',
      { className: 'dsr-split' },
      h('div', { className: 'dsr-listPane' }, listPane),
      h('div', { className: 'dsr-contentPane' }, contentPane),
    ),
    h(Toast, { toast: state.toast }),
  )
}

// ---------------------------------------------------------------- 设置区（settings.section）
function ReportSettings(props) {
  const t = (props && props.t) || ((key) => key)
  const state = useStore()
  React.useEffect(() => {
    bootstrap()
    actions.loadConfig()
    actions.loadTemplates().catch(() => {})
  }, [])
  return h(
    'section',
    { className: 'dsr-root dsr-settingsRoot' },
    h(
      'div',
      { className: 'dsr-settingsSection' },
      typeof SettingsPage === 'function'
        ? h(SettingsPage, { t, state, actions })
        : h(EmptyState, { title: '设置页面未加载' }),
    ),
  )
}

// ---------------------------------------------------------------- 注册
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-report';
    style.textContent = CLIENT_CSS.join('\n');
    document.head.append(style);
    return () => style.remove();
  }, 'dsh-report: styles');
  ctx.effect(() => ctx.locale.register(NS, { zh: { ...extraZh, ...zh }, en: { ...extraEn, ...en } }), 'dsh-report: dictionaries');

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'dsh-report',
            order: 40,
            label: () => tx(t, 'title', '工作报告'),
            locale: NS,
          },
          (props) => h(PanelIcon, props),
        ),
      ),
    'dsh-report: sidebar icon',
  );

  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'dsh-report',
            locale: NS,
            inject: () => ({ t }),
          },
          ReportsPanel,
        ),
      ),
    'dsh-report: main panel',
  );

  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-report',
            order: 50,
            label: () => tx(t, 'title', '工作报告'),
            locale: NS,
            inject: () => ({ t }),
          },
          ReportSettings,
        ),
      ),
    'dsh-report: settings section',
  );
}

return { inject, apply };
  },
});
