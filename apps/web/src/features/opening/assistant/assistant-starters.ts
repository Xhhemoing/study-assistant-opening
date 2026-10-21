import type { ComposerPurpose, TutorMode } from "@aistudy/contracts";

export type AssistantStarter = { label: string; text: string; mode: TutorMode; purpose: ComposerPurpose };
/** Choosing a starter prepares an editable draft; it never sends a request. */
export function assistantStarters(study: boolean, queryAvailable: boolean): AssistantStarter[] {
  if (study) return [
    { label: "给我一个提示", text: "请只给我下一步的方向，先不要揭示答案。", mode: "hint", purpose: "answer" },
    { label: "讲清楚一步", text: "请帮我讲清楚当前这一步为什么成立，先不要展开完整解答。", mode: "hint", purpose: "teach" },
    { label: "换个例子", text: "请用一个不同的简单例子说明当前概念，保留这道题让我自己做。", mode: "hint", purpose: "teach" },
  ];
  return [
    { label: "解释一个概念", text: "我想理解一个概念。请先问我已经知道什么，再一步步解释。", mode: "explain", purpose: "teach" },
    { label: "出一道题", text: "请根据我们正在学习的内容出一道练习题，先不要显示答案。", mode: "hint", purpose: "teach" },
    queryAvailable
      ? { label: "查我的学习记录", text: "我最近的学习记录有哪些？", mode: "explain", purpose: "query" }
      : { label: "检验我的理解", text: "我想用自己的话讲一遍，请帮我找出理解中的缺口，先不要直接给答案。", mode: "listen", purpose: "answer" },
  ];
}
