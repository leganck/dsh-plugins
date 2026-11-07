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
    setFormOpen(true);
    setError('');
    setNotice('');
    setConfirmId('');
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
                h('span', { className: 'dsr-connName' }, connection.displayName || connection.username || connection.baseUrl || connection.id),
                h('span', { className: 'dsr-connUrl' }, connection.baseUrl || '—'),
                connection.username ? h('span', { className: 'dsr-connUser' }, `@${connection.username}`) : null,
              ),
              h(Badge, { tone: connection.hasToken ? 'ok' : 'warn' }, connection.hasToken ? tr('tokenSaved', 'Token 已保存') : tr('tokenMissing', '未保存 Token')),
              h(
                'span',
                { className: 'dsr-connActions' },
                h(Button, { size: 'sm', onClick: () => openToken(connection), disabled: busy }, tr('updateToken', '更新 Token')),
                h(
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
      setSyncError(tr('noScopeNotice', '还没有保存同步仓库范围，请先到 设置 → 报告与统计 → 同步仓库范围 选择仓库。'));
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
          h('div', { className: 'dsr-hint' }, tr('noConnectionNoticeHint', '请先到 设置 → 报告与统计 保存 GitLab 地址与 Token，再回来同步。')),
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
            : tr('noScopeShort', '还没有选择同步仓库：请到 设置 → 报告与统计 → 同步仓库范围 选择'),
      ),
      h('span', { className: 'dsr-syncScopeHint' }, tr('syncScopeSummaryHint', '仓库范围在 设置 → 报告与统计 → 同步仓库范围 修改')),
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
