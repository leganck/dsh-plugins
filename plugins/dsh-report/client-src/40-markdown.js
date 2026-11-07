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
