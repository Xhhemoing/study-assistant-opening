/**
 * Inline composition: one model stream carries Markdown prose with fenced component blocks.
 *
 *   ```sw:matrix
 *   {"id": "shear", "title": "剪切", "data": {"matrix": [[1, 1], [0, 1]]}}
 *   ```
 *
 * composeText runs on the growing text, so the same function drives progressive rendering in
 * the browser and the final commit on the server. Earlier blocks keep their IDs as text grows;
 * an unfinished fence is reported as `pending` (a placeholder), never rendered half-parsed.
 * A fence that fails validation stays in the prose as visible JSON: no text is ever dropped.
 */
import {validateDocument, splitText, plainDocument, cleanText, SCHEMA_VERSION, CATALOG} from './document.mjs';
const SW_OPEN = /^ {0,3}(`{3,})\s*sw:([A-Za-z]+)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const META = ['id', 'title', 'body', 'qualifiers', 'refs', 'format'];
const MAX_BLOCKS = 40;

function parseFence(type, json, fallbackId) {
  const raw = JSON.parse(json);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw Object.assign(new Error('组件内容必须是 JSON 对象'), {code: 'COMPOSE'});
  // Either {"data": {...}} or the data fields inline next to the optional meta fields.
  const data =
    raw.data ?? Object.fromEntries(Object.entries(raw).filter(([k]) => !META.includes(k)));
  const block = {id: raw.id ?? fallbackId, type, data};
  for (const k of META.slice(1)) if (raw[k] !== undefined) block[k] = raw[k];
  return block;
}
/** Validate one component in isolation so a bad fence cannot fail the whole document. */
function checkBlock(block, sources) {
  return validateDocument(
    {schemaVersion: SCHEMA_VERSION, id: 'probe', revision: 1, title: 'probe', blocks: [block]},
    {sources, partial: true}
  ).blocks[0];
}

export function composeText(
  text,
  {id = 'composed', title = '模型回答', sources = [], final = false} = {}
) {
  cleanText(text, 60000);
  let overflow = false;
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  // While streaming, hold back a trailing partial line that may become a fence opener.
  if (!final && /^ {0,3}`+[^`\n]*$/.test(lines.at(-1) ?? '')) lines = lines.slice(0, -1);
  let docTitle = title;
  const firstText = lines.findIndex(l => l.trim());
  const h1 = firstText >= 0 && lines[firstText].match(/^ {0,3}#\s+(.+?)\s*#*\s*$/);
  // Only a finished first line becomes the title, so it does not flicker while streaming.
  if (h1 && (final || firstText < lines.length - 1)) {
    docTitle = h1[1].slice(0, 200);
    lines = lines.slice(firstText + 1);
  }
  const blocks = [],
    warnings = [],
    used = new Set();
  let prose = [],
    segment = 0,
    components = 0,
    pending = null,
    code = null; // an ordinary (non-sw) fence currently open
  const uniqueId = wanted => {
    let candidate = wanted,
      n = 2;
    while (used.has(candidate)) candidate = `${wanted}-${n++}`;
    used.add(candidate);
    return candidate;
  };
  const flush = () => {
    const body = prose.join('\n');
    prose = [];
    const n = ++segment;
    if (!body.trim()) return;
    splitText(body).forEach((piece, i) => {
      if (blocks.length >= MAX_BLOCKS) { overflow = true; return; }
      const pid = uniqueId(i ? `p${n}-${i + 1}` : `p${n}`);
      blocks.push({id: pid, type: 'prose', title: '', body: piece, format: 'markdown'});
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (code) {
      prose.push(line);
      if (new RegExp(`^ {0,3}\\${code[0]}{${code.length},}\\s*$`).test(line)) code = null;
      continue;
    }
    const open = line.match(SW_OPEN);
    if (!open || blocks.length >= MAX_BLOCKS - 1) {
      const fence = line.match(FENCE);
      if (fence) code = fence[1];
      prose.push(line);
      continue;
    }
    const close = new RegExp(`^ {0,3}\`{${open[1].length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    const type = open[2];
    const inner = lines.slice(i + 1, end).join('\n');
    if (end >= lines.length && !final) {
      // Unfinished component: show a placeholder; prose before it is already visible.
      flush();
      pending = {type, known: Object.hasOwn(CATALOG, type)};
      break;
    }
    components++;
    // Prose before the fence is closed off first, so its segment ID never depends on the fence.
    flush();
    try {
      if (end >= lines.length)
        throw Object.assign(new Error('组件代码块未闭合'), {code: 'COMPOSE'});
      const block = parseFence(type, inner, `${type}-${components}`);
      const wanted =
        typeof block.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(block.id)
          ? block.id
          : `${type}-${components}`;
      block.id = uniqueId(wanted);
      const checked = checkBlock(block, sources);
      if (checked.type !== type) throw Object.assign(new Error(`未知组件 ${type}`), {code: 'TYPE'});
      blocks.push(block);
    } catch (e) {
      // Keep the author's content readable instead of discarding it.
      warnings.push(`组件 ${type} 未通过校验（${e.code ?? 'JSON'}：${e.message}），已按原文保留。`);
      prose.push('```json', inner, '```');
    }
    i = end;
  }
  if (!pending) flush();
  if (overflow) {
    const document = plainDocument(text, id, title, {format: 'markdown'});
    document.warnings.push('组件预算已满，已回退为完整原文；未静默截断内容。');
    return {document, pending: null, components};
  }
  const document = validateDocument(
    {
      schemaVersion: SCHEMA_VERSION,
      id,
      revision: 1,
      title: docTitle,
      summary: '',
      warnings: [...new Set(warnings)].slice(0, 16),
      // Keep exact input (including CRLF, invalid fences and the original heading).
      originalText: final ? text : '',
      blocks
    },
    {sources, partial: !final}
  );
  return {document, pending, components};
}
