/**
 * Answer templates: designer-made layouts that the model fills in, so visual quality does not
 * depend on the model's design judgment. routePrompt is a transparent, deterministic first pass
 * (keywords only). It only selects guidance for the model; it never blocks or rewrites output.
 */
export const TEMPLATES = Object.freeze({
  text: {
    label: '纯文字',
    components: [],
    guide: '问题简单或是闲聊：直接用简洁的 Markdown 回答，不要插入任何 sw: 组件。'
  },
  explain: {
    label: '讲清一个概念',
    components: ['matrix', 'math', 'diagram', 'exercise'],
    guide:
      '顺序：一句话结论 → 直觉解释 → 一个图解或可调组件（有确定数据时才用）→ 关键公式 → 一道自测题。'
  },
  compare: {
    label: '比较方案',
    components: ['compare', 'chart', 'callout'],
    guide:
      '顺序：一句话建议 → 对比表（compare，3–6 行）→ 有可靠数值时才用 chart → 用 callout 写清取舍和适用条件。'
  },
  plan: {
    label: '做计划',
    components: ['timeline', 'checklist', 'callout'],
    guide:
      '顺序：目标与前提 → 时间线（timeline，按阶段）→ 可勾选清单（checklist）→ 用 callout 写风险。'
  },
  calculate: {
    label: '算一算',
    components: ['calc', 'math', 'callout'],
    guide:
      '顺序：结论（数值用 {{块ID.变量}} 绑定）→ 可调计算器（calc，给出输入范围和公式）→ 公式说明 → 假设与边界。'
  }
});
// Ordered: the first matching rule wins. Kept small and readable on purpose.
const RULES = [
  [
    'calculate',
    /多少钱|月供|利率|利息|复利|计算|算一算|算算|换算|多少(?:元|天|年|个)|预算|折扣|税/
  ],
  ['compare', /比较|对比|区别|差异|哪个好|哪个更|选哪|还是.{0,12}[?？]|优缺点|\bvs\.?\b/i],
  ['plan', /计划|规划|安排|时间表|日程|路线图|备考|怎么准备|学习路线|步骤清单|待办/],
  ['explain', /解释|为什么|原理|是什么|怎么理解|直观|讲讲|讲解|推导|证明|含义|意义/]
];
/** Returns {template, reason}. Short greetings and chit-chat stay text-only. */
export function routePrompt(prompt) {
  const p = String(prompt ?? '').trim();
  if (Array.from(p).length < 6 && !/[?？]/.test(p))
    return {template: 'text', reason: '问题很短，直接文字回答'};
  for (const [template, re] of RULES) {
    const m = p.match(re);
    if (m) return {template, reason: `关键词“${m[0]}”`};
  }
  return {template: 'text', reason: '没有命中需要图形的模式'};
}
