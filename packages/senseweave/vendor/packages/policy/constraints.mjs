import {CATALOG, cleanText, requireContract} from '../core/document.mjs';

// Only the host's current user instruction is inspected. Quoted examples, code and
// block quotes are data; they must not silently become presentation instructions.
export function instructionText(prompt) {
  return prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/g, ' ')
    .replace(/(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu,' ')
    .split('\n').filter(line => !/^\s*(?:>|(?:示例|反例|引用|example|counterexample|quote)\s*[:：])/i.test(line)).join('\n');
}

export function presentationConstraints(context = {}) {
  const constraints = context.constraints ?? {};
  requireContract(constraints && typeof constraints === 'object' && !Array.isArray(constraints), 'CONTEXT', 'Expected presentation constraints');
  requireContract(constraints.allowEnhancements === undefined || typeof constraints.allowEnhancements === 'boolean', 'CONTEXT', 'Invalid allowEnhancements');
  const components = constraints.allowedComponents ?? Object.keys(CATALOG);
  requireContract(Array.isArray(components) && components.length <= 40 && components.every(c => Object.hasOwn(CATALOG, c)), 'CONTEXT', 'Invalid allowedComponents');
  const prompt = instructionText(cleanText(context.prompt ?? '', 6000));
  const textRequest = /(?:只要|只用|仅用|纯)\s*(?:文字|文本)|(?:不要|不用|无需|不需要|别|避免)(?:再|使用|用|任何|生成|添加|显示|制作|给我|提供|的|\s){0,8}(?:图表|图形|表格|界面|可视化|动画|画图|作图|配图|编号列表|列表|编号)|(?:直接|仅|只)\s*(?:用|写|输出)?\s*(?:一段话|文字|文本)|\b(?:plain\s+text\s+only|text\s+only|no\s+(?:charts?|tables?|visuals?|ui|lists?|bullets?)|(?:do\s+not|don't|dont|without|avoid)\s+(?:(?:use|using|any|show|showing|add|adding|generate)\s+)*(?:charts?|tables?|visuals?|ui))\b/i.test(prompt);
  return {noUI: context.preference === 'text' || constraints.allowEnhancements === false || textRequest,
    allowedComponents: [...new Set(components)], instruction: prompt};
}
