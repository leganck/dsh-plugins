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
  title: '报告与统计',
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
    { className: 'dsr-root', 'aria-label': tx(t, 'title', '报告与统计') },
    h(
      'header',
      { className: 'dsr-pageHead' },
      h('h1', { className: 'dsr-pageTitle' }, tx(t, 'title', '报告与统计')),
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
    style.dataset.plugin = '@local/dsh-report';
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
            label: () => tx(t, 'title', '报告与统计'),
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
            label: () => tx(t, 'title', '报告与统计'),
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
