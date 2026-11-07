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
