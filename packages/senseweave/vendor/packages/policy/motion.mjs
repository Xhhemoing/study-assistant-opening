/**
 * Context-adaptive presentation style: a small, whitelisted set of motion presets and an
 * optional hand-drawn ("sketch") rendering. Pure data; the element applies it with CSS/WAAPI.
 * Motion is decoration only: every block is complete and readable without it, and it is never
 * played while streaming, for reduced-motion users, for screen readers, or when the host turns it off.
 */
import {requireContract, cleanText} from '../core/document.mjs';

export const MOTION_PRESETS = Object.freeze(['none', 'reveal', 'stagger', 'draw', 'step-through', 'highlight', 'count-up', 'write']);
/** Which presets make sense for which component. Suggestions outside this table are rejected. */
export const MOTION_BY_TYPE = Object.freeze({
  steps: Object.freeze(['step-through', 'stagger', 'reveal']),
  checklist: Object.freeze(['stagger', 'reveal']),
  timeline: Object.freeze(['stagger', 'reveal']),
  chart: Object.freeze(['draw', 'highlight', 'count-up', 'reveal']),
  plot: Object.freeze(['draw', 'reveal']),
  compare: Object.freeze(['highlight', 'stagger', 'reveal']),
  table: Object.freeze(['reveal', 'stagger']),
  diagram: Object.freeze(['draw', 'reveal']),
  derivation: Object.freeze(['write', 'reveal']),
  details: Object.freeze(['reveal']),
  json: Object.freeze(['reveal']),
  diff: Object.freeze(['reveal'])
});
export const SKETCH_TYPES = Object.freeze(['steps', 'checklist', 'timeline', 'chart', 'plot', 'compare', 'diagram', 'derivation', 'callout']);
const STYLES = ['auto', 'sketch', 'plain'];
const MAX_ANIMATED = 3;
const TEACHING = ['explain', 'review'];
const ANNOTATION = /(?:关键(?:是|在于)?|重点(?:是|在于)?|注意|易错(?:点)?(?:是|在于)?|错因(?:是|在于)?|结论(?:是)?|核心(?:是|在于)?)[：:，,]?\s*([^，,。；;！!？?\n]{2,24})/g;

function localPreset(type, tasks, sketch) {
  if (type === 'steps') return tasks.some(t => TEACHING.includes(t)) || sketch ? ['step-through', '讲解/复盘按步骤逐步高亮'] : ['stagger', '有序条目逐项出现'];
  if (type === 'checklist' || type === 'timeline') return ['stagger', '条目逐项出现，便于跟随'];
  if (type === 'chart') return tasks.includes('compare') ? ['highlight', '比较任务突出最大/最小差异'] : ['draw', '柱形自基线描绘'];
  if (type === 'plot') return ['draw', '折线按数据点顺序描绘'];
  if (type === 'compare') return ['highlight', '对照表逐列突出差异'];
  if (type === 'diagram') return sketch ? ['draw', '手绘关系图逐笔描绘'] : ['reveal', '图形渐显'];
  if (type === 'derivation') return ['write', '推导逐行书写'];
  if (type === 'table' || type === 'details' || type === 'json' || type === 'diff') return ['reveal', '渐显'];
  return ['none', '正文与该组件不需要动画'];
}

/**
 * @param {{blocks: {id:string,type:string,body?:string}[]}} document validated document
 * @param {object} options context (raw host context), resolved (resolveContext output), final,
 *   capabilities (raw host capabilities: motion/sketch booleans), suggestion (validated hints from a
 *   host-injected model; still filtered here), mode
 */
export function planPresentationStyle(document, {context = {}, resolved = {}, final = true, capabilities = {}, suggestion = null, mode = 'rich'} = {}) {
  const style = context.style ?? 'auto';
  requireContract(STYLES.includes(style), 'CONTEXT', 'Unknown style');
  requireContract(capabilities.motion === undefined || typeof capabilities.motion === 'boolean', 'CAPABILITIES', 'motion must be boolean');
  requireContract(capabilities.sketch === undefined || typeof capabilities.sketch === 'boolean', 'CAPABILITIES', 'sketch must be boolean');
  // A model-suggested intent may shape decoration only when the host did not declare the task.
  const tasks = resolved.taskSource !== 'explicit' && Array.isArray(suggestion?.tasks) && suggestion.tasks.length ? suggestion.tasks : resolved.tasks ?? [resolved.task ?? 'auto'];
  const blocks = (document?.blocks ?? []).filter(b => b.type !== 'prose');
  const rejected = [];
  // ---- sketch (hand-drawn) style
  let sketch = false, sketchReason = '默认标准样式';
  const teaching = resolved.taskSource === 'explicit' && TEACHING.includes(resolved.task);
  if (capabilities.sketch === false) sketchReason = '宿主关闭手绘样式';
  else if (style === 'plain') sketchReason = '用户偏好标准样式';
  else if (style === 'sketch') {sketch = true; sketchReason = '用户偏好手绘样式';}
  else if (teaching) {sketch = true; sketchReason = '宿主声明讲解/复盘场景，采用板书式手绘';}
  else if (suggestion?.style === 'sketch') {sketch = true; sketchReason = '模型建议手绘样式（讲解/批注类上下文）';}
  const sketchBlocks = sketch ? blocks.filter(b => SKETCH_TYPES.includes(b.type)).map(b => b.id) : [];
  // ---- motion
  let off = null;
  if (mode !== 'rich' || !blocks.length) off = '没有增强组件';
  else if (capabilities.motion === false) off = '宿主关闭动画';
  else if (resolved.reducedMotion || context.reducedMotion === true) off = '用户偏好减少动态';
  else if (resolved.screenReader || context.screenReader === true) off = '屏幕阅读器场景不播放装饰性动画';
  else if (final === false) off = '流式生成中不播放；完成后只播放一次';
  const motionBlocks = {};
  let animated = 0;
  for (const b of blocks) {
    let [preset, reason] = off ? ['none', off] : localPreset(b.type, tasks, sketchBlocks.includes(b.id));
    const wanted = !off && (suggestion?.motion?.[b.id] ?? suggestion?.motion?.[b.type]);
    if (wanted) {
      if ((MOTION_BY_TYPE[b.type] ?? []).includes(wanted)) {preset = wanted; reason = `模型建议（白名单内）：${reason}`;}
      else rejected.push({blockId: b.id, preset: cleanText(String(wanted), 40), reason: '动画不在该组件的白名单内'});
    }
    if (preset !== 'none' && ++animated > MAX_ANIMATED) {preset = 'none'; reason = '动画预算已用完（最多 3 个组件）';}
    motionBlocks[b.id] = {preset, reason};
  }
  // ---- annotations: verbatim phrases in prose, only in teaching/sketch/annotate contexts
  const annotations = [];
  const prose = (document?.blocks ?? []).filter(b => b.type === 'prose');
  if (sketch || tasks.includes('review') || context.annotate === true) {
    for (const b of prose) {
      for (const m of String(b.body ?? '').matchAll(ANNOTATION)) {
        if (annotations.length >= 3) break;
        annotations.push({blockId: b.id, phrase: m[1].trim(), kind: 'underline', source: 'local'});
      }
    }
  }
  for (const a of suggestion?.annotations ?? []) {
    if (annotations.length >= 5) break;
    const phrase = typeof a === 'string' ? a : a?.phrase;
    const target = typeof phrase === 'string' && phrase.trim().length >= 2 && phrase.length <= 40 && prose.find(b => String(b.body ?? '').includes(phrase.trim()));
    if (target && !annotations.some(x => x.phrase === phrase.trim())) annotations.push({blockId: target.id, phrase: phrase.trim(), kind: a?.kind === 'circle' ? 'circle' : 'underline', source: 'model'});
    else if (phrase) rejected.push({phrase: cleanText(String(phrase), 40), reason: '批注短语没有逐字出现在正文中'});
  }
  const enabled = !off && Object.values(motionBlocks).some(x => x.preset !== 'none');
  return {
    motion: {enabled, reason: off ?? (enabled ? '按组件类型与任务自动选择受控动画；无动画时内容同样完整' : '组件不需要动画'), blocks: motionBlocks},
    sketch: {enabled: sketch, reason: sketchReason, blocks: sketchBlocks},
    annotations,
    rejected
  };
}
