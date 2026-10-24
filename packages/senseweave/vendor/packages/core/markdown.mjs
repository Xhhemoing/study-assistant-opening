/**
 * Safe Markdown subset parsed into a plain JSON tree. There is no raw HTML, no images and
 * no remote loading; links survive only when safeUrl accepts them. Rendering is done by the
 * element with createElement/textContent, so the tree never becomes markup.
 */
import {safeUrl} from './document.mjs';
import {MAX_TABLE_ROWS} from './extended.mjs';
const MAX_DEPTH = 4;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// Order matters: escapes and code spans win over emphasis; links before bare URLs.
const INLINE = new RegExp(
  [
    /\\([\\`*_{}[\]()#+\-.!|~>])/.source,
    /(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/.source,
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,
    /~~(?=\S)([\s\S]*?\S)~~/.source,
    // ASCII word characters around a single * mean arithmetic such as 2*3*4, not emphasis.
    /(?<![A-Za-z0-9*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![A-Za-z0-9*])/.source,
    /\[([^\]\n]{1,500})\]\(([^\s()]{1,2048})\)/.source,
    /<(https:\/\/[^\s<>]{1,2048})>/.source,
    /(https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]{1,2048})/.source
  ].join('|'),
  'g'
);

function startsBlock(line) {
  return [FENCE, HEADING, RULE, QUOTE, BULLET, ORDERED].some(re => re.test(line));
}
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(x => x.trim().replace(/\\\|/g, '|'));
}

export function parseInline(text, depth = 0) {
  const out = [];
  const push = s => {
    if (!s) return;
    const last = out.at(-1);
    if (last?.type === 'text') last.text += s;
    else out.push({type: 'text', text: s});
  };
  const re = new RegExp(INLINE.source, 'g');
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const [all, escaped, ticks, code, strong, del, em, label, href, auto, bare] = m;
    if (escaped !== undefined) push(escaped);
    else if (ticks !== undefined) {
      const padded = code.length > 2 && code.startsWith(' ') && code.endsWith(' ');
      out.push({type: 'code', text: padded ? code.slice(1, -1) : code});
    } else if (depth >= MAX_DEPTH) push(all);
    else if (strong !== undefined)
      out.push({type: 'strong', children: parseInline(strong, depth + 1)});
    else if (del !== undefined) out.push({type: 'del', children: parseInline(del, depth + 1)});
    else if (em !== undefined) out.push({type: 'em', children: parseInline(em, depth + 1)});
    else if (label !== undefined) {
      const url = safeUrl(href);
      // Unsafe or relative targets stay visible as inert text instead of silently vanishing.
      if (url) out.push({type: 'link', href: url, children: parseInline(label, depth + 1)});
      else push(all);
    } else {
      let url = auto ?? bare;
      if (bare !== undefined) {
        const trimmed = url.replace(/[.,;:!?'*\]]+$/, '');
        re.lastIndex -= url.length - trimmed.length;
        last = re.lastIndex;
        url = trimmed;
      }
      const safe = safeUrl(url);
      if (safe) out.push({type: 'link', href: safe, children: [{type: 'text', text: url}]});
      else push(bare !== undefined ? url : all);
    }
  }
  push(text.slice(last));
  return out;
}

export function parseMarkdown(text, depth = 0) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blank = s => !s.trim();
  const out = [];
  let i = 0,
    m;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if ((m = line.match(FENCE))) {
      const close = new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence; an unclosed fence runs to the end like CommonMark
      out.push({type: 'code', language: m[2], text: body.join('\n')});
      continue;
    }
    if ((m = line.match(HEADING))) {
      out.push({type: 'heading', level: m[1].length, children: parseInline(m[2])});
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({type: 'rule'});
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) {
        inner.push(m[1]);
        i++;
      }
      out.push(
        depth < MAX_DEPTH
          ? {type: 'quote', children: parseMarkdown(inner.join('\n'), depth + 1)}
          : {type: 'paragraph', children: parseInline(inner.join('\n'))}
      );
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const pattern = ordered ? ORDERED : BULLET;
      const start = ordered ? Number(line.match(ORDERED)[1]) : 1;
      const items = [];
      while (i < lines.length) {
        if ((m = lines[i].match(pattern))) {
          items.push([m[ordered ? 2 : 1]]);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i])) {
          items.at(-1).push(lines[i].trim()); // indented continuation of the previous item
          i++;
        } else break;
      }
      out.push({type: 'list', ordered, start, items: items.map(x => parseInline(x.join('\n')))});
      continue;
    }
    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      const start=i;
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !blank(lines[i]))
        rows.push(cells(lines[i++]));
      if (header.length>12 || rows.length>MAX_TABLE_ROWS || rows.some(r=>r.length!==header.length)) {
        out.push({type:'code',language:'text',text:lines.slice(start,i).join('\n')});
        continue;
      }
      out.push({
        type: 'table',
        header: header.map(x => parseInline(x)),
        rows: rows.map(r => header.map((_, j) => parseInline(r[j] ?? '')))
      });
      continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i]))
      paragraph.push(lines[i++]);
    out.push({type: 'paragraph', children: parseInline(paragraph.join('\n'))});
  }
  return out;
}
