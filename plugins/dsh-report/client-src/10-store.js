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
