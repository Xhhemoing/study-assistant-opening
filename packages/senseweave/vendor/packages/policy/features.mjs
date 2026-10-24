import {dataProfile} from './evidence.mjs';
import {WEIGHTS_V0 as W, VISUAL_COST_V0} from './weights-v0.mjs';

// Internal structural features; no public exports from the package entry point.
export const FEATURE_VERSION = 'features-v0';
export function extractFeatures(candidate, ctx) {
  const b=candidate.block,type=b.type,table=type==='table',json=type==='json';
  const rows=table?b.data.rows.length:0,columns=table?b.data.columns.length:0;
  const profile=dataProfile(b);
  return {
    type, markdownTable:table&&candidate.format==='markdown-table',
    large:table&&(rows>=5||columns>=4),
    inspectCompare:table&&['inspect','compare'].includes(ctx.task),
    compactWide:table&&ctx.viewport==='compact'&&columns>4,
    small:table&&rows<=2&&columns<=2,
    planning:type==='checklist'||type==='steps',
    jsonLong:json&&JSON.stringify(b.data.value).length>=100,
    jsonInspect:json&&ctx.task==='inspect',
    variant:!!candidate.variant, explored:!!candidate.explored,
    visual:ctx.preference==='visual',
    reader:!!ctx.screenReader&&['plot','chart','diagram'].includes(type),
    constant:!!candidate.variant&&!!profile.constant,
    missing:!!candidate.variant&&profile.missingRatio>=0.3,
    compactMany:!!candidate.variant&&ctx.viewport==='compact'&&profile.rows>10
  };
}

/** Ordered v0 evaluation intentionally preserves legacy IEEE-754 operation order,
 * reason order (including reasons preceding a variant override), clamp and rounding.
 * Do not replace with an unordered dot product at rounding boundaries.
 */
export function scoreCandidate(candidate,ctx,preferences) {
  const f=extractFeatures(candidate,ctx),type=f.type;
  const reasons=['已识别完整结构，组件数据可由原文直接获得'];
  let value=W.base;
  if(type==='table'){
    value=f.markdownTable?W.markdownTable:W.base;
    if(f.large){value+=W.large;reasons.push('行列规模使本地筛选/排序有价值');}
    if(f.inspectCompare){value+=W.inspectCompare;reasons.push('当前任务需要查找或比较');}
    if(f.compactWide){value+=W.compactWide;reasons.push('窄屏宽表增加阅读负担');}
    if(f.small){value+=W.small;reasons.push('小表格通常不需要额外交互');}
  }
  if(f.planning){value=W.planning;reasons.push(type==='checklist'?'计划任务中的显式条目可逐项核对；勾选仅为本页状态':'原文有明确编号顺序，保留每一项，不推断新步骤');}
  if(type==='json'){value=W.json+(f.jsonLong?W.jsonLong:0)+(f.jsonInspect?W.jsonInspect:0);reasons.push('树状折叠只用于结构检查，不执行对象内容');}
  if(type==='math'){value=W.math;reasons.push('受限公式可无模型编译为 MathML');}
  if(type==='diff'){value=W.diff;reasons.push('保留每条差异，仅增强阅读，不应用补丁');}
  if(type==='diagram'){value=W.diagram;reasons.push('仅采用显式节点和边，不从自然语言猜关系');}
  if(f.variant&&f.explored){value=W.explored;reasons.push('备选视图：轴语义与单位明确、无新增数值；是否更合适由语义选择器结合问题判断');}
  else if(f.variant){value=W.variant;reasons.push('任务匹配，轴语义与单位明确，无新增数值');}
  if(f.visual){value+=W.visual;reasons.push('用户明确偏好增强展示');}
  if(f.reader){value+=W.reader;reasons.push('屏幕阅读器优先结构化文字/数据表');}
  if(f.constant){value+=W.constant;reasons.push('数据没有数值变化，优先保留可核对的数据表');}
  if(f.missing){value+=W.missing;reasons.push('缺失比例增加图形误读风险，优先数据核对');}
  if(f.compactMany){value+=W.compactMany;reasons.push('窄屏下较多数据点或分类需要更高的阅读成本');}
  // Read adjustment and call it exactly once, retaining the preferences receiver.
  const feedback=preferences?.adjustment?.(type,ctx.task)??0;
  if(feedback){value+=feedback;reasons.push('依据当前实例显式的有用/无用反馈保守调整');}
  return {score:Math.round(Math.max(0,Math.min(1,value))*1000)/1000,reasons,visualCost:VISUAL_COST_V0[type]??1};
}
