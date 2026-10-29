import {validateReviewTelemetry} from './usage.mjs';
import {requireContract, cleanText, CATALOG} from './document.mjs';
/** Public presentation reasoning is inert metadata, bounded independently of the answer. */
export function validateDecision(value) {
  requireContract(value && typeof value === 'object' && !Array.isArray(value), 'DECISION', '决策说明不合法');
  requireContract(['text', 'enhance', 'suggest', 'authored'].includes(value.state) &&
    Number.isInteger(value.extraModelCalls) && value.extraModelCalls >= 0 && value.extraModelCalls <= 1,
    'DECISION', '决策状态或调用数不合法');
  const list = (items, limit) => {
    requireContract(Array.isArray(items) && items.length <= limit, 'DECISION', '候选说明超出预算');
    return items.map(item => {
      requireContract(item && typeof item.type === 'string' && Object.hasOwn(CATALOG, item.type) &&
        Array.isArray(item.reasons) && item.reasons.length <= 4, 'DECISION', '候选说明不合法');
      return {key: cleanText(item.key, 160), type: item.type, reasons: item.reasons.map(r => cleanText(r, 300))};
    });
  };
  requireContract(Array.isArray(value.qualityWarnings) && value.qualityWarnings.length <= 4, 'DECISION', '数据提示超出预算');
  const semantic = value.semantic;
  if (semantic !== null) requireContract(semantic && typeof semantic === 'object' &&
    Number.isInteger(semantic.calls) && semantic.calls >= 0 && semantic.calls <= 1, 'DECISION', '语义复核说明不合法');
  return {state: value.state, task: cleanText(value.task, 40), reason: cleanText(value.reason, 500),
    selected: list(value.selected, 8), alternatives: list(value.alternatives, 6),
    qualityWarnings: value.qualityWarnings.map(s => cleanText(s, 300)), extraModelCalls: value.extraModelCalls,
    semantic: semantic === null ? null : validateReviewTelemetry(semantic),
    ...presentationSummary(value.presentation), ...aiSummary(value.ai)};
}
const PRESETS = ['none', 'reveal', 'stagger', 'draw', 'step-through', 'highlight', 'count-up', 'write'];
/** Optional, bounded decoration summary (motion preset per block, sketch). Invalid input is dropped, not fatal. */
function presentationSummary(p) {
  if (!p || typeof p !== 'object') return {};
  const motion = {};
  for (const [id, preset] of Object.entries(p.motion ?? {}).slice(0, 12)) if (typeof id === 'string' && id.length <= 120 && PRESETS.includes(preset)) motion[id] = preset;
  return {presentation: {motion, sketch: p.sketch === true, sketchBlocks: (Array.isArray(p.sketchBlocks) ? p.sketchBlocks : []).filter(x => typeof x === 'string' && x.length <= 120).slice(0, 12),
    motionReason: cleanText(String(p.motionReason ?? ''), 300), sketchReason: cleanText(String(p.sketchReason ?? ''), 300)}};
}
function aiSummary(a) {
  if (!a || typeof a !== 'object' || typeof a.status !== 'string') return {};
  const int = x => Number.isSafeInteger(x) && x >= 0 ? x : 0;
  return {ai: {status: cleanText(a.status, 40), calls: Math.min(1, int(a.calls)), gateCalls: Math.min(1, int(a.gateCalls)), latencyMs: int(a.latencyMs),
    ...(typeof a.task === 'string' ? {task: cleanText(a.task, 40)} : {}), accepted: Array.isArray(a.accepted) ? Math.min(8, a.accepted.length) : 0, rejected: Array.isArray(a.rejected) ? Math.min(12, a.rejected.length) : 0}};
}
