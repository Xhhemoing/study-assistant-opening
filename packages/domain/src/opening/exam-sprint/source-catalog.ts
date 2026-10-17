/**
 * Math I source inventory, checked against the supplied PDFs on 2026-10-17.
 * sourcePage is the 1-based PDF page, including slide overlays, not the slide footer.
 * Count main exercise numbers once; answer keys, worked examples and subparts are excluded.
 *
 * The seven-day budget comes from the user's shared training conversation:
 * https://chatgpt.com/share/6ad32a67-184c-83e9-9980-e87e1cf92d7d
 * suggestedDay is an editable initial allocation based on that plan, not an observed
 * learning result or a recovered row from the unavailable companion workbook.
 * Skills are intentionally unmapped until each source problem has been reviewed.
 */
type SourceItem = {
  id: string;
  topicId: string;
  label: string;
  sourceTitle: string;
  sourcePage: number | null;
  kind: "choice" | "problem" | "exercise";
  suggestedDay: number;
  skills: string[];
};

type SourceGroup = {
  topic: number;
  kind: SourceItem["kind"];
  idPrefix: string;
  labelPrefix: string;
  sourceTitle: string;
  day: number;
  pages: Array<[page: number, numbers: number[]]>;
};

const numbers = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

const referenceChoicePages: Array<SourceGroup["pages"]> = [
  [[1, numbers(1, 8)], [2, numbers(9, 17)], [3, numbers(18, 20)]],
  [[1, numbers(1, 7)], [2, numbers(8, 15)], [3, numbers(16, 20)]],
  [[1, numbers(1, 7)], [2, numbers(8, 14)], [3, numbers(15, 20)]],
  [[1, numbers(1, 6)], [2, numbers(7, 13)], [3, numbers(14, 20)]],
  [[1, numbers(1, 5)], [2, numbers(6, 11)], [3, numbers(12, 17)], [4, numbers(18, 20)]],
];

const referenceGroups: SourceGroup[] = referenceChoicePages.flatMap((pages, index) => {
  const topic = index + 1;
  return [
    {
      topic,
      kind: "choice",
      idPrefix: `t${topic}-q`,
      labelPrefix: `Topic ${topic} · 参考选择题 Q`,
      sourceTitle: `Topic_${topic}_Example_Test_to_Practice.pdf`,
      day: topic,
      pages,
    },
    {
      topic,
      kind: "problem",
      idPrefix: `t${topic}-p`,
      labelPrefix: `Topic ${topic} · 参考综合题 P`,
      sourceTitle: `Topic_${topic}_Example_Problems_to_Practice.pdf`,
      day: topic,
      pages: [[1, numbers(1, 10)]],
    },
  ];
});

const exerciseGroups: SourceGroup[] = [
  {
    topic: 2,
    kind: "exercise",
    idPrefix: "t2-e",
    labelPrefix: "Topic 2 · 课件练习 E",
    sourceTitle: "Topic_2_Sequences_and_Limits_SLIDES.pdf",
    day: 2,
    pages: Array.from({ length: 10 }, (_, index) => [53 + index, numbers(1 + index * 2, 2 + index * 2)]),
  },
  {
    topic: 3,
    kind: "exercise",
    idPrefix: "t3-e",
    labelPrefix: "Topic 3 · 课件练习 E",
    sourceTitle: "Topic_3__Differential_Calculus_SLIDES.pdf",
    day: 3,
    pages: [
      [49, numbers(1, 3)], [50, numbers(4, 6)], [51, numbers(7, 9)],
      [52, numbers(10, 12)], [53, numbers(13, 15)], [54, numbers(16, 18)], [55, numbers(19, 20)],
    ],
  },
  {
    topic: 4,
    kind: "exercise",
    idPrefix: "t4-e-primitive",
    labelPrefix: "Topic 4 · 原函数练习 E",
    sourceTitle: "Topic_4_Integral_Calculus_SLIDES.pdf",
    day: 4,
    pages: [[30, numbers(1, 9)], [31, numbers(10, 14)], [32, numbers(15, 20)]],
  },
  {
    topic: 4,
    kind: "exercise",
    idPrefix: "t4-e-application",
    labelPrefix: "Topic 4 · 定积分与应用练习 E",
    sourceTitle: "Topic_4_Integral_Calculus_SLIDES.pdf",
    day: 4,
    // The supplied PDF has E1–E5 followed by E7–E9. Do not invent E6 or renumber E7–E9.
    pages: [[61, numbers(1, 5)], [62, numbers(7, 9)]],
  },
  {
    topic: 5,
    kind: "exercise",
    idPrefix: "t5-e-numerical",
    labelPrefix: "Topic 5 · 数项级数练习 E",
    sourceTitle: "Topic_5_Series_SLIDES.pdf",
    day: 4,
    pages: [[30, numbers(1, 5)], [31, numbers(6, 9)]],
  },
  {
    topic: 5,
    kind: "exercise",
    idPrefix: "t5-e-functional",
    labelPrefix: "Topic 5 · 函数列与函数项级数练习 E",
    sourceTitle: "Topic_5_Series_SLIDES.pdf",
    day: 5,
    pages: [[65, numbers(1, 3)], [66, numbers(4, 6)], [67, numbers(7, 8)]],
  },
];

// Early interleaving follows the shared plan. The remaining items use their chapter's
// first-round day; the learner can change the allocation after the initial diagnosis.
const suggestedDayOverrides: Record<string, number> = {
  "t1-p-6": 2, "t1-p-7": 2, "t1-p-8": 2, "t1-p-9": 2, "t1-p-10": 2,
  "t2-p-10": 3, "t2-e-11": 3, "t2-e-19": 3, "t2-e-20": 3,
  "t3-q-15": 4, "t3-q-16": 4, "t3-q-17": 4, "t3-q-18": 4, "t3-q-19": 4, "t3-q-20": 4,
  "t3-p-9": 4, "t3-p-10": 4, "t3-e-10": 4, "t3-e-18": 4, "t3-e-19": 4, "t3-e-20": 4,
  "t4-q-3": 1, "t4-q-4": 1, "t4-p-1": 1,
  "t4-e-primitive-9": 1, "t4-e-primitive-10": 1, "t4-e-primitive-11": 1,
  "t4-q-11": 2, "t4-p-6": 2,
  "t4-e-application-1": 2, "t4-e-application-2": 2,
  "t4-p-7": 3, "t4-p-10": 3, "t4-e-application-5": 3,
  "t5-p-3": 4, "t5-p-5": 4, "t5-p-6": 4, "t5-p-7": 3,
  "t5-e-functional-1": 1, "t5-e-functional-2": 3, "t5-e-functional-3": 3, "t5-e-functional-8": 3,
};

export const EXAM_SOURCE_ITEMS: SourceItem[] = [...referenceGroups, ...exerciseGroups].flatMap(
  (group) => group.pages.flatMap(([sourcePage, exerciseNumbers]) => exerciseNumbers.map((number) => {
    const id = `${group.idPrefix}-${number}`;
    return {
      id,
      topicId: `topic-${group.topic}`,
      label: `${group.labelPrefix}${number}`,
      sourceTitle: group.sourceTitle,
      sourcePage,
      kind: group.kind,
      suggestedDay: suggestedDayOverrides[id] ?? group.day,
      skills: [],
    };
  })),
);

export const EXAM_WEEK_PLAN: Array<{ day: number; minutes: number; title: string; tasks: string[] }> = [
  {
    day: 1, minutes: 360, title: "定位与修复入口",
    tasks: ["90 分钟全范围诊断并复盘", "复数与基础函数", "60 分钟完整分部积分并验算", "45 分钟函数列图像与量词", "记录真实解题速度，校准本周预算"],
  },
  {
    day: 2, minutes: 360, title: "极限、FTC、最大误差",
    tasks: ["数列极限与递推", "完成复数余题", "定积分与变上限求导", "上确界判据", "复测第 1 天错误"],
  },
  {
    day: 3, minutes: 360, title: "把章节连接起来",
    tasks: ["微分与 Taylor", "极限证明余题", "面积建模", "一致收敛、Dini、M-test 与交换积分反例", "核算剩余题目和复测的时间缺口"],
  },
  {
    day: 4, minutes: 390, title: "积分综合与级数边界",
    tasks: ["积分综合：重复根、循环分部、递推、弧长和绕 OY 旋转体", "Taylor 余项和参数题", "数项级数与临界判别"],
  },
  {
    day: 5, minutes: 390, title: "级数与全范围核查",
    tasks: ["数项、函数项和幂级数综合", "逐项运算与 Cauchy 乘积", "积分隔日变式", "逐题核查首轮记录及未通过项"],
  },
  {
    day: 6, minutes: 360, title: "陌生模拟 A",
    tasks: ["120 分钟陌生题模拟", "逐步评分", "90 分钟专项修补", "延迟复测", "覆盖复核"],
  },
  {
    day: 7, minutes: 300, title: "陌生模拟 B 与最终验收",
    tasks: ["第二套互补模拟", "批改与盲改", "全范围回忆", "整理失分清单和未验收能力"],
  },
];
