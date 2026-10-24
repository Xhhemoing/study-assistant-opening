import {validateDocument, SCHEMA_VERSION} from '../core/document.mjs';
const TIME_LABEL = /^\*{0,2}((?:第\s*[一二三四五六七八九十\d]{1,3}\s*(?:天|日|周|阶段|轮|课时|节)|(?:周|星期)[一二三四五六日天]|\d{1,2}[/.-]\d{1,2}|\d{1,2}月\d{1,2}日|(?:day|week|phase)\s*\d{1,2}|(?:上午|下午|晚上|早上|考前\s*\d{1,2}\s*天))(?:\s*[-–~至]\s*[^：:]{1,12})?)\*{0,2}\s*[：:]\s*\*{0,2}(.+)$/i;
/** Only explicit, flat Markdown list runs in planning tasks; no inferred steps or execution. */
export function planningLists(text) {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]).map(m => ({
    text: m[0].replace(/\r?\n$/, ''), start: m.index, end: m.index + m[0].length}));
  const result = [];
  let fence = null;
  const item = line => line.match(/^ {0,3}(?:([-+*])\s+|(\d{1,2})[.)]\s+)(\S.*)$/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {fence = open[1]; continue;}
    const first = item(line);
    if (!first || /^\[[ xX]\]/.test(first[3]) || first[2] && first[2] !== '1') continue;
    if (i > 0 && lines[i - 1].text.trim() && item(lines[i - 1].text)) continue;
    const indent = line.match(/^ */)[0].length;
    const ordered = !!first[2], rows = [];
    let end = i;
    while (end < lines.length) {
      const match = item(lines[end].text);
      if (!match || lines[end].text.match(/^ */)[0].length !== indent || !!match[2] !== ordered || /^\[[ xX]\]/.test(match[3])) break;
      if (ordered && Number(match[2]) !== Number(first[2]) + rows.length) break;
      rows.push(match[3]); end++;
    }
    const continuation = end < lines.length && lines[end].text.trim() && !/^#{1,6}\s/.test(lines[end].text);
    if (rows.length < 3 || rows.length > 12 || rows.some(s => s.length > 1000) || continuation) {i = Math.max(i, end - 1); continue;}
    // Every item opens with an explicit time label ("第 1 天：…", "周一：…", "10/25：…"): a schedule, shown as a timeline.
    const timed = rows.map(r => r.match(TIME_LABEL));
    const timeline = timed.every(m => m && m[2].trim() && m[2].length <= 200) && new Set(timed.map(m => m[1].replace(/\s+/g, ''))).size === rows.length;
    const id = `auto_${lines[i].start}_list`, type = timeline ? 'timeline' : ordered ? 'steps' : 'checklist';
    const data = timeline ? {items: timed.map(m => ({when: m[1].trim(), title: m[2].trim()}))} : ordered ? {items: rows} : {items: rows.map((text, n) => ({id: `item-${n + 1}`, text}))};
    try {
      const block = validateDocument({schemaVersion: SCHEMA_VERSION, id: 'probe', revision: 1, title: '', blocks: [{id, type, data}]}).blocks[0];
      result.push({id, block, format: 'markdown-list', start: lines[i].start, end: lines[end - 1].end,
        source: text.slice(lines[i].start, lines[end - 1].end)});
    } catch { /* Retain the entire original list when unsupported. */ }
    i = end - 1;
  }
  return result;
}
