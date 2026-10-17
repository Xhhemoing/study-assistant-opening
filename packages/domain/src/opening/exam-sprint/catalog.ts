import type { ExamPack } from "@aistudy/contracts";
import { EXAM_LESSONS } from "./lessons";
import { EXAM_MOCK_QUESTIONS } from "./mock-questions";
import { EXAM_SOURCE_ITEMS, EXAM_WEEK_PLAN } from "./source-catalog";
import { EXAM_TRAINING_QUESTIONS } from "./training-questions";

/** Answer-bearing data: import only from the server catalog subpath, never the public domain barrel. */
export const EXAM_SPRINT_PACK: ExamPack = {
  id: "math-i-part-i-sprint", version: "2026-10-17-v1",
  title: "Math I · 考前冲刺",
  description: "按复数、数列极限、微分、积分、级数五章推进：预置串讲 → 独立练习 → 错因记录 → 延迟复测。配套来源题目录可登记纸笔作答与收集疑问，A/B短模拟各10题，建议25分钟。",
  topics: [
    { id: "topic-1", title: "Topic 1 · Complex numbers 复数" },
    { id: "topic-2", title: "Topic 2 · Sequences and limits 数列与极限" },
    { id: "topic-3", title: "Topic 3 · Differential calculus 微分与Taylor" },
    { id: "topic-4", title: "Topic 4 · Integral calculus 积分与应用" },
    { id: "topic-5", title: "Topic 5 · Series 级数与一致收敛" },
  ],
  lessons: EXAM_LESSONS,
  questions: [...EXAM_TRAINING_QUESTIONS, ...EXAM_MOCK_QUESTIONS],
  sourceItems: EXAM_SOURCE_ITEMS,
  weekPlan: EXAM_WEEK_PLAN,
  limitations: [
    "235项是材料中的来源题索引，不是235道已录入、可在线判分的题。本期预置33道训练题及两套各10题的短模拟，共53道原创客观题。",
    "预置讲解、题目和答案是可继续人工审校的编辑内容；不是从用户试卷逐字转录的题目，也不代表已核实的真题答案。",
    "综合题、证明题和来源材料中的纸笔作答目前由你自评并记录过程。客观题自动核对选项不能替代完整推导评分。",
    "A/B均为约25分钟的短模拟，不是正式120分钟/100分的完整试卷，不能用其成绩推断正式考试分数；尚未实现完整正式试卷预测，也不承诺90–95分或命中率。",
    "已关联的课件为Topic 2–5；Topic 1课件缺失，复数串讲是原创补充，需要与实际课程要求核对。",
    "全部学习状态从未测开始。展示的掌握度仅来自后续真实作答/求助记录；纸笔自评与在线独立作答分别统计，不预置成功或薄弱证据。",
    "七天安排是可调整的学习顺序，不保证七天内完成全部来源题；系统根据你实际记录的用时估算剩余负荷。",
  ],
};
