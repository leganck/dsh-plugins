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
