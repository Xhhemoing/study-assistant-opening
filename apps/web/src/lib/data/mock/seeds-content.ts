import type { AbilitySlice, AttemptEvent, PracticeItem } from "@aistudy/contracts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export const pid = (s: string) => `11111111-1111-4111-8111-1111111111${s}`;
export const iid = (s: string) => `22222222-2222-4222-8222-2222222222${s}`;
export const aid = (s: string) => `33333333-3333-4333-8333-3333333333${s}`;
export const cid = (s: string) => `44444444-4444-4444-8444-4444444444${s}`;

export interface SyllabusPoint {
  id: string;
  title: string;
}

export const SEED_SYLLABUS: SyllabusPoint[] = [
  "函数与极限",
  "导数的定义",
  "导数的计算",
  "微分中值定理",
  "洛必达法则",
  "函数的单调性与极值",
  "曲线的凹凸与拐点",
  "不定积分",
  "定积分",
  "微分方程初步",
  "向量代数",
  "多元函数微分",
].map((title, i) => ({ id: pid((i + 1).toString(16).padStart(2, "0")), title }));

const SLICES: AbilitySlice[] = ["recognition", "recall", "procedure", "transfer", "expression"];

function makeItem(n: number, pointIdx: number): PracticeItem {
  const point = SEED_SYLLABUS[pointIdx] as SyllabusPoint;
  const base = {
    id: iid(n.toString(16).padStart(2, "0")),
    syllabusPointId: point.id,
    abilitySlice: SLICES[n % SLICES.length] as AbilitySlice,
    estimatedMinutes: 5 + (n % 8),
    hints: Array.from(
      { length: 1 + (n % 3) },
      (_, k) => `提示${k + 1}：回顾「${point.title}」的核心定义与典型例题`,
    ),
    contentVersion: 1,
  };
  if (n < 9) {
    return {
      ...base,
      kind: "multiple_choice",
      stem: `关于「${point.title}」，下列说法正确的是？`,
      options: ["A. 教材定义表述", "B. 常见误解", "C. 无关结论", "D. 以偏概全"],
      answer: "A",
    };
  }
  if (n < 15) {
    return {
      ...base,
      kind: "short_answer",
      stem: `用一句话写出「${point.title}」最核心的定义。`,
      answer: "定义",
    };
  }
  return {
    ...base,
    kind: "checkpoint",
    stem: `完成「${point.title}」的典型计算，勾选所有正确步骤。`,
    options: ["第一步：列式", "第二步：跳步心算", "第三步：规范求解", "第四步：省略检验"],
    answer: "0,2",
  };
}

export function buildSeedItems(): PracticeItem[] {
  const items: PracticeItem[] = [];
  for (let p = 0; p < 12; p += 1) items.push(makeItem(items.length, p));
  for (let p = 0; p < 7; p += 1) items.push(makeItem(items.length, p));
  items.push(makeItem(items.length, 11));
  return items;
}

interface SeedAttempt {
  correct: boolean;
  slice: AbilitySlice;
  confidence: number;
}

const STABLE_RUN: SeedAttempt[] = [
  { correct: true, slice: "transfer", confidence: 4 },
  { correct: true, slice: "recognition", confidence: 4 },
  { correct: true, slice: "recall", confidence: 4 },
  { correct: true, slice: "procedure", confidence: 5 },
];

export function buildSeedAttempts(
  ownerUserId: string,
  items: PracticeItem[],
  now: Date,
): AttemptEvent[] {
  const events: AttemptEvent[] = [];
  const push = (pointIdx: number, runs: SeedAttempt[]) => {
    const point = SEED_SYLLABUS[pointIdx] as SyllabusPoint;
    const item = items[pointIdx] as PracticeItem;
    for (const run of runs) {
      const n = events.length;
      events.push({
        id: aid(n.toString(16).padStart(2, "0")),
        ownerUserId,
        practiceItemId: item.id,
        syllabusPointId: point.id,
        idempotencyKey: `seed-attempt-${n.toString().padStart(3, "0")}`,
        answer: run.correct ? item.answer : "错误答案",
        correct: run.correct,
        assisted: false,
        durationMs: 60000 + n * 1000,
        hintCount: 0,
        confidence: run.confidence,
        errorCause: run.correct ? null : "concept",
        abilitySlice: run.slice,
        contentVersion: 1,
        schemaVersion: 1,
        createdAt: new Date(now.getTime() - 3 * DAY_MS + n * 30 * 60000).toISOString(),
      });
    }
  };
  push(0, STABLE_RUN);
  push(1, STABLE_RUN);
  for (const p of [2, 3, 4]) {
    push(p, [
      { correct: false, slice: "recognition", confidence: 3 },
      { correct: true, slice: "recall", confidence: 4 },
    ]);
  }
  for (const p of [5, 6]) {
    push(p, [
      { correct: true, slice: "recognition", confidence: 4 },
      { correct: false, slice: "recall", confidence: 3 },
    ]);
  }
  return events;
}

export const CARD_CONTENT: Array<[string, string]> = [
  ["导数的定义", "函数增量比的极限：f'(x) = lim(Δy/Δx)，Δx→0"],
  ["洛必达法则使用条件", "0/0 或 ∞/∞ 型未定式，且导数之比的极限存在"],
  ["微分中值定理", "闭区间连续、开区间可导，则存在 ξ 使 f'(ξ) 等于割线斜率"],
  ["定积分的几何意义", "曲边梯形的有向面积"],
  ["不定积分与原函数", "∫f(x)dx = F(x) + C"],
  ["函数单调性判定", "导数符号决定单调区间"],
  ["极限的四则运算", "和差积商的极限等于极限的和差积商（分母极限非零）"],
  ["泰勒公式直觉", "用多项式逼近光滑函数"],
];
