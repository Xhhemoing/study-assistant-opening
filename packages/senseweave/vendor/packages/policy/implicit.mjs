/**
 * Scores for candidates that the frozen v0 scorer does not know: implicit prose structure,
 * grounded AI proposals and alternative table views. Design heuristics, not probabilities.
 * Kept separate so the legacy v0 parity tests stay exact for every pre-existing candidate.
 */
import {validateDocument, SCHEMA_VERSION} from '../core/document.mjs';

export const IMPLICIT_COST = Object.freeze({steps: 1, checklist: 1, timeline: 1, compare: 1, chart: 2, plot: 3, derivation: 1});
const BASE = {steps: 0.86, checklist: 0.84, timeline: 0.84, compare: 0.82, chart: 0.8, plot: 0.82, derivation: 0.88};
const REASON = {
  sequence: '散文中有明确的先后标记（首先/然后/最后），逐字拆成步骤，不新增内容',
  enumeration: '冒号后逐项列出的准备事项，逐字拆成清单；勾选仅为本页状态',
  series: '同一单位的多项数值，标签与数字均逐字来自原文，未计算或补值',
  events: '带日期的事件按原文顺序排列，日期与事件逐字来自原文',
  comparison: '两个对象的优缺点逐字对照，表头只用固定维度词',
  derivation: '连续的推导行，逐字按行板书；可能包含最终答案',
  'table-timeline': '首列是按顺序排列的日期，事件表可读作时间线',
  proposal: '模型提议的片段已通过逐字引用、结构与数字溯源校验'
};

export function isImplicitCandidate(c) {return c?.format === 'prose' || c?.format === 'ai-proposal' || !!c?.view;}

export function scoreImplicit(candidate, ctx, preferences) {
  const type = candidate.block.type, kind = candidate.format === 'ai-proposal' ? 'proposal' : candidate.view ?? candidate.implicit;
  const reasons = [REASON[kind] ?? '已识别隐式结构，数据逐字来自原文'];
  let value = candidate.format === 'ai-proposal' ? 0.9 : BASE[type] ?? 0.78;
  const tasks = ctx.tasks ?? [ctx.task];
  if (type === 'steps' && candidate.block.data.items.length >= 4) {value += 0.03; reasons.push('步骤较多，编号后更易跟随');}
  if (['steps', 'checklist', 'timeline'].includes(type) && tasks.some(t => ['plan', 'explain'].includes(t))) {value += 0.04; reasons.push('当前任务需要按顺序理解或执行');}
  if (type === 'chart' && tasks.includes('compare')) {value += 0.08; reasons.push('当前任务需要比较大小');}
  if (type === 'plot' && tasks.includes('trend')) {value += 0.08; reasons.push('当前任务关心变化趋势');}
  if (type === 'compare' && tasks.includes('compare')) {value += 0.06; reasons.push('当前任务需要对照');}
  if (type === 'derivation' && tasks.some(t => ['explain', 'review'].includes(t))) {value += 0.06; reasons.push('讲解/复盘场景逐行展示推导');}
  if (ctx.preference === 'visual') {value += 0.05; reasons.push('用户明确偏好增强展示');}
  if (ctx.screenReader && ['plot', 'chart'].includes(type)) {value -= 0.2; reasons.push('屏幕阅读器优先结构化文字/数据表');}
  if (candidate.placement === 'after') reasons.push('原句保留在组件前，组件只作补充视图');
  const feedback = preferences?.adjustment?.(type, ctx.task) ?? 0;
  if (feedback) {value += feedback; reasons.push('依据当前实例显式的有用/无用反馈保守调整');}
  return {score: Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000, reasons: reasons.slice(0, 4), visualCost: IMPLICIT_COST[type] ?? 1};
}

const DATE_CELL = /^(?:\d{3,4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?|\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\s*月\s*\d{1,2}\s*日|(?:周|星期)[一二三四五六日天]|第\s*[一二三四五六七八九十\d]{1,3}\s*(?:天|日|周|阶段|课时|节|轮))$/;
const rank = s => {
  const m = s.match(/^(\d{3,4})\s*年(?:\s*(\d{1,2})\s*月)?(?:\s*(\d{1,2})\s*日)?$/) || s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) return Number(m[1]) * 10000 + Number(m[2] ?? 0) * 100 + Number(m[3] ?? 0);
  return null;
};
/** A two-column "date | event" table read as a timeline. Same cells, no new data. */
export function tableTimeline(candidate) {
  if (candidate.block.type !== 'table') return null;
  const {columns, rows} = candidate.block.data;
  if (columns.length !== 2 || rows.length < 3 || rows.length > 16) return null;
  if (!rows.every(r => typeof r[0] === 'string' && DATE_CELL.test(r[0].trim()) && typeof r[1] === 'string' && r[1].trim() && r[1].length <= 200)) return null;
  const ranks = rows.map(r => rank(r[0].trim()));
  if (ranks.every(x => x !== null) && ranks.some((x, i) => i && x < ranks[i - 1])) return null;
  try {
    const block = validateDocument({schemaVersion: SCHEMA_VERSION, id: 'probe', revision: 1, title: '', blocks: [{id: candidate.id, type: 'timeline', data: {items: rows.map(r => ({when: r[0].trim(), title: r[1].trim()}))}}]}).blocks[0];
    return {...candidate, block, view: 'table-timeline'};
  } catch {return null;}
}
