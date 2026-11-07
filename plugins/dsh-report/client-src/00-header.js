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
