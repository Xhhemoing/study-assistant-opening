import {CATALOG} from '../core/document.mjs';
import {routePrompt, TEMPLATES} from '../core/templates.mjs';
import {negotiateCapabilities} from './capabilities.mjs';
import {resolveContext} from '../policy/index.mjs';
const EXAMPLES = {
  compare: {columns: ['选项', '适用条件'], rows: [['A', '条件一'], ['B', '条件二']]},
  steps: {items: ['第一步', '第二步']},
  timeline: {items: [{when: '阶段一', title: '验证需求', detail: '明确可检查的产物'}]},
  checklist: {items: [{id: 'check1', text: '人工确认验收条件'}]},
  matrix: {matrix: [[1, 1], [0, 1]]},
  calc: {inputs: [{id: 'x', label: '输入', value: 2, min: 0, max: 10, step: 1}], outputs: [{id: 'y', label: '输出', expr: 'x*2', digits: 0}]},
  chart: {unit: '次', rows: [{label: 'A', value: 3}], note: '示例数据，不是真实统计'},
  diagram: {nodes: [{id: 'a', label: '前提'}, {id: 'b', label: '结论'}], edges: [{from: 'a', to: 'b', relation: 'dependency'}]},
  math: {expression: {op: 'frac', args: [{op: 'number', value: '1'}, {op: 'symbol', value: 'x'}]}},
  exercise: {question: '请先解释你的理由。', answer: '简明解析。', hints: ['先检查条件。']},
  evidence: {claims: [{text: '待核验主张', relation: 'missing', sourceIds: []}]},
  callout: {}, code: {language: 'text', code: '不可执行的示例'}, prose: {}
};
export function selectPresentation({intent, prompt = '', capabilities} = {}) {
  const cap = negotiateCapabilities(capabilities);
  const ctx=resolveContext({prompt});
  if(ctx.noUI||ctx.exact)return {template:'text',reason:'用户要求原样或纯文字',components:[]};
  if (!cap.rich || intent === 'text') return {template: 'text', reason: '宿主或用户明确选择文字', components: []};
  let choice;
  if (intent && Object.hasOwn(TEMPLATES, intent)) choice = {template: intent, reason: '宿主明确指定意图'};
  else {
    const english = [['compare', /\b(compare|versus|pros and cons|difference)\b/i], ['plan', /\b(plan|schedule|roadmap)\b/i], ['calculate', /\b(calculate|calculator|convert|payment)\b/i], ['explain', /\b(explain|why|intuition|derive)\b/i]].find(([,re]) => re.test(prompt));
    choice = english ? {template: english[0], reason: '可解释英文关键词路由，不推断用户能力'} : routePrompt(prompt);
  }
  let components=TEMPLATES[choice.template].components;
  if(choice.template==='explain'&&!intent){
    components=[];
    if(/矩阵|线性变换|matrix|linear transform/i.test(prompt))components.push('matrix');
    if(/依赖关系|流程图|结构图|flowchart|dependency/i.test(prompt))components.push('diagram');
    if(/练习|自测|quiz|exercise/i.test(prompt))components.push('exercise');
  }
  return {...choice, components: components.filter(t => cap.components.includes(t)).slice(0, Math.min(2,cap.maxInteractiveBlocks))};
}
/** Prompt only the relevant trusted catalog, not every component on every answer. */
/** Teaching intents from a study host. Guidance only; no component is required. */
const TEACHING_GUIDES = {
  hint: ['教学提示模式：只给下一步提示，不给完整解答或最终答案。',
    '先指出学习者已经做对的部分，再用一个问题引导下一步；后续提示可放进 Markdown 列表，按由浅到深排序。',
    '不要输出完整步骤表、答案对照表或可直接抄写的结论。'],
  review: ['错题复盘模式：先用一句话说明错因，再对照“原做法 / 正确思路”。',
    '对照内容适合写成两列 Markdown 表格（每行一个关键步骤）；错因可写成编号清单，方便逐条核对。',
    '只陈述可从题目和作答中看出的错误，不推断学习者的能力或态度。']
};
export function createInstructions(context = {}) {
  if (Object.hasOwn(TEACHING_GUIDES, context.intent)) {
    const lines = ['SenseWeave is an optional presentation layer, NOT a tool executor or fact verifier.', ...TEACHING_GUIDES[context.intent],
      '普通 Markdown 表格、编号列表与受限 Mermaid 由本地运行时按需转换；不要输出 HTML、脚本或 sw: 组件。'];
    return lines.join('\n');
  }
  const selected = selectPresentation(context);
  const lines = ['SenseWeave is an optional presentation layer, NOT a tool executor or fact verifier.',
    '先给可独立理解的正文和必要条件。仅在有助理解时使用组件；不得为装饰编造数字、来源或执行回执。',
    '用户明确要求纯文字时不使用组件。简单问题直接回答。组件勾选不等于业务成功，练习完成不等于已经掌握。',
    '普通正文、Markdown 表格、完整 CSV/TSV/JSON 围栏与受限 LaTeX/Mermaid 可由本地运行时转换；不要重复输出同一份数据。',
    selected.components.length ? TEMPLATES[selected.template].guide : '无需特殊组件时直接用清晰正文；不强制图示、自测、卡片或其他固定模板。'];
  if (selected.components.length) {
    lines.push('在 Markdown 中使用完整的 JSON 围栏：```sw:类型；下一行 JSON；单独一行 ``` 结束。不要输出 HTML、脚本、JSX 或任意 URL 资源。');
    lines.push('每个组件使用唯一短 id（用于绑定时只用字母、数字和下划线）。数值计算可引用 {{组件ID.输出ID|2}}。');
    for (const type of selected.components) lines.push(`${type} — ${CATALOG[type]}: ${JSON.stringify({id: `${type}1`, title: CATALOG[type], data: EXAMPLES[type]})}`);
  }
  const max=context.maxChars??2400;
  if(!Number.isInteger(max)||max<400||max>12000)throw new Error('maxChars must be 400–12000');
  const kept=[];let chars=0;
  for(const line of lines){if(chars+line.length+1>max)break;kept.push(line);chars+=line.length+1;}
  return kept.join('\n');
}
