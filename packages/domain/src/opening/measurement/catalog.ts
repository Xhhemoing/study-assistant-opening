import type {
  MeasurementAttempt,
  MeasurementItemView,
  MeasurementPhase,
  MeasurementTrial,
} from "@aistudy/contracts";
import { MEASUREMENT_RETEST_GAP_MS } from "./evaluation";

/** Import this bank only in server code. Only publicMeasurementItem may cross to a client. */
export type MeasurementCatalogItem = MeasurementItemView & {
  correctOptionId: string;
  hint: string;
  solution: string;
};

export type MeasurementUnit = {
  id: string;
  label: string;
  protocolVersion: string;
  bankVersion: string;
  overview: string;
  limitations: readonly string[];
  items: readonly MeasurementCatalogItem[];
};

const skillLabels = {
  "choose-u-dv": "选择 u 与 dv",
  "compute-v": "由 dv 求 v",
  "assemble-parts": "组合 uv − ∫v du",
} as const;

function item(
  id: string, phase: MeasurementPhase, skillId: keyof typeof skillLabels, familyId: string,
  prompt: string, options: readonly [string, string, string, string], correctOptionId: string,
  hint: string, solution: string,
): MeasurementCatalogItem {
  return {
    id, version: "v1", phase, skillId, skillLabel: skillLabels[skillId], familyId, prompt,
    options: options.map((label, index) => ({ id: String.fromCharCode(65 + index), label })),
    correctOptionId, hint, solution,
  };
}

const partsUnit: MeasurementUnit = {
  id: "calculus-parts-v1",
  label: "分部积分：选择、积分与组合",
  protocolVersion: "v1",
  bankVersion: "v1",
  overview: "把分部积分连成三步：先选择 u 与 dv，让后续计算更简单；再单独求出 v；最后将 u、v、du 放入 ∫u dv = uv − ∫v du。这里每题只核对其中一步，练习时可请求提示，之后再回来看延迟测验。",
  limitations: [
    "这是固定题库的个人影子试验；选择题答对仅说明本题所测步骤的表现，不能证明独立完成开放题或已经掌握分部积分。",
    "练习与延迟测验按解题结构划分题族，系数变化不算新题族；新题族仍可能存在难度与先备知识差异，未经等值校准。",
    "延迟测验中包含练习未直接覆盖的初等积分与函数形式，分数差异不能单独归因为遗忘或教学效果。",
    "每技能只有两道练习和两道延迟测验；同一人的回答相关，样本不足以证明 BKT 优于其他模型。",
    "延迟时间从完成或跳过全部练习的服务器时间计算；迟到作答保留实际时间，不计作准时测验。",
  ],
  items: [
    item("parts-p-u-exp", "practice", "choose-u-dv", "parts-linear-exponential",
      "计算 ∫x e^x dx 时，希望对 u 求导后一次就去掉 x。下列哪组选择符合这个目标？",
      ["u = e^x，dv = x dx", "u = x，dv = e^x dx", "u = x e^x，dv = dx", "u = 1，dv = x e^x dx"], "B",
      "选取求导后变成常数的那一部分作 u。",
      "选 B：u = x、dv = e^x dx，于是 du = dx、v = e^x。其他拆法有些也满足乘积，但不符合题目要求的简化目标。"),
    item("parts-p-v-exp", "practice", "compute-v", "antiderivative-exponential",
      "分部积分的一步已确定 dv = e^(2x) dx。暂取积分常数为 0，v 应是什么？",
      ["e^(2x)", "2e^(2x)", "e^(−2x)/2", "e^(2x)/2"], "D",
      "对 e^(2x) 求导时会多出系数 2；积分时应怎样补偿这个系数？",
      "选 D：v = e^(2x)/2，因为 (e^(2x)/2)' = e^(2x)。此题只核对由 dv 求 v 这一步。"),
    item("parts-p-a-exp", "practice", "assemble-parts", "parts-linear-exponential",
      "对 ∫x e^x dx，已给定 u = x、v = e^x、du = dx。代入分部积分公式后，哪一个等式正确？",
      ["∫x e^x dx = x e^x − ∫e^x dx", "∫x e^x dx = x e^x + ∫e^x dx", "∫x e^x dx = e^x − ∫x e^x dx", "∫x e^x dx = x e^x − ∫x dx"], "A",
      "公式是 ∫u dv = uv − ∫v du；逐个代入，不要重新求 v。",
      "选 A：uv = x e^x，v du = e^x dx，所以原积分等于 x e^x − ∫e^x dx。"),
    item("parts-p-u-trig", "practice", "choose-u-dv", "parts-linear-trigonometric",
      "计算 ∫x cos x dx 时，希望对 u 求导后一次就去掉 x。下列哪组选择符合这个目标？",
      ["u = cos x，dv = x dx", "u = x cos x，dv = dx", "u = x，dv = cos x dx", "u = 1，dv = x cos x dx"], "C",
      "比较 x 与 cos x 求导后的形式，选择能变成常数的一部分。",
      "选 C：u = x、dv = cos x dx，于是 du = dx、v = sin x。"),
    item("parts-p-v-trig", "practice", "compute-v", "antiderivative-trigonometric",
      "分部积分的一步已确定 dv = sin x dx。暂取积分常数为 0，v 应是什么？",
      ["−sin x", "sin x", "cos x", "−cos x"], "D",
      "用求导检验符号：cos x 的导数是 −sin x，如何得到正的 sin x？",
      "选 D：v = −cos x，因为 (−cos x)' = sin x。"),
    item("parts-p-a-trig", "practice", "assemble-parts", "parts-linear-trigonometric",
      "对 ∫x sin x dx，已给定 u = x、v = −cos x、du = dx。哪一步正确？",
      ["∫x sin x dx = −x cos x − ∫cos x dx", "∫x sin x dx = x cos x + ∫cos x dx", "∫x sin x dx = −x cos x + ∫x cos x dx", "∫x sin x dx = −x cos x + ∫cos x dx"], "D",
      "外面的减号与 v 中的负号相乘，剩余积分前是什么符号？",
      "选 D：uv = −x cos x，−∫v du = −∫(−cos x) dx = +∫cos x dx。"),
    item("parts-48-u-log", "delay_48h", "choose-u-dv", "parts-single-logarithm",
      "在 x > 0 时计算 ∫ln x dx，希望通过对 u 求导把 ln x 变成 1/x。哪组选择符合这个目标？",
      ["u = 1，dv = ln x dx", "u = x，dv = (ln x)/x dx", "u = ln x，dv = dx", "u = x ln x，dv = dx/x"], "C",
      "先把被积函数写成 ln x · 1，再选择 u。",
      "选 C：u = ln x、dv = dx，于是 du = dx/x、v = x。"),
    item("parts-48-v-inverse", "delay_48h", "compute-v", "antiderivative-inverse-tangent",
      "分部积分的一步已确定 dv = dx/(1 + x²)。暂取积分常数为 0，v 应是什么？",
      ["arctan x", "ln(1 + x²)", "1/(1 + x²)", "−1/(1 + x²)"], "A",
      "回忆 arctan x 的导数。",
      "选 A：v = arctan x，因为 (arctan x)' = 1/(1 + x²)。"),
    item("parts-48-a-cyclic", "delay_48h", "assemble-parts", "parts-exponential-trigonometric-cycle",
      "对 ∫e^x sin x dx，已给定 u = e^x、v = −cos x、du = e^x dx。哪一步正确？",
      ["∫e^x sin x dx = −e^x cos x − ∫e^x cos x dx", "∫e^x sin x dx = −e^x cos x + ∫e^x cos x dx", "∫e^x sin x dx = e^x cos x + ∫e^x cos x dx", "∫e^x sin x dx = −e^x cos x + ∫cos x dx"], "B",
      "直接代入 uv − ∫v du，并保留 du 中的 e^x。",
      "选 B：uv = −e^x cos x，−∫v du = +∫e^x cos x dx。这里只要求正确组合第一步，不要求解完整个循环积分。"),
    item("parts-7-u-inverse", "delay_7d", "choose-u-dv", "parts-single-inverse-tangent",
      "计算 ∫arctan x dx，希望通过对 u 求导把 arctan x 变成有理函数。哪组选择符合这个目标？",
      ["u = 1，dv = arctan x dx", "u = x，dv = (arctan x)/x dx", "u = x arctan x，dv = dx/x", "u = arctan x，dv = dx"], "D",
      "arctan x 的导数是 1/(1 + x²)。",
      "选 D：u = arctan x、dv = dx，于是 du = dx/(1 + x²)、v = x。"),
    item("parts-7-v-power", "delay_7d", "compute-v", "antiderivative-polynomial",
      "计算 ∫x ln x dx 的分部积分步骤中，已经选定 dv = x dx。暂取积分常数为 0，v 应是什么？",
      ["x²/2", "x²", "1", "ln x"], "A",
      "用求导检查 x² 的系数，使导数恰好是 x。",
      "选 A：v = x²/2，因为 (x²/2)' = x。此题只核对给定 dv 的积分。"),
    item("parts-7-a-reciprocal", "delay_7d", "assemble-parts", "parts-logarithm-reciprocal-power",
      "在 x > 0 时，对 ∫(ln x)/x² dx，已给定 u = ln x、v = −1/x、du = dx/x。哪一步正确？",
      ["∫(ln x)/x² dx = −(ln x)/x − ∫dx/x²", "∫(ln x)/x² dx = (ln x)/x + ∫dx/x²", "∫(ln x)/x² dx = −(ln x)/x + ∫dx/x²", "∫(ln x)/x² dx = −(ln x)/x + ∫dx/x"], "C",
      "v du = (−1/x)(dx/x)，再处理公式前面的减号。",
      "选 C：uv = −(ln x)/x，v du = −dx/x²，故原积分为 −(ln x)/x + ∫dx/x²。"),
  ],
};

export function getMeasurementUnit(unitId: string): MeasurementUnit | null {
  return unitId === partsUnit.id ? partsUnit : null;
}

export function listMeasurementUnits(): readonly MeasurementUnit[] {
  return [partsUnit];
}

export function publicMeasurementItem(item: MeasurementCatalogItem): MeasurementItemView {
  return {
    id: item.id, version: item.version, skillId: item.skillId, skillLabel: item.skillLabel,
    familyId: item.familyId, phase: item.phase, prompt: item.prompt,
    options: item.options.map(({ id, label }) => ({ id, label })),
  };
}

export function gradeMeasurementAnswer(item: MeasurementCatalogItem, answer: string): "correct" | "incorrect" {
  if (!item.options.some((option) => option.id === answer)) throw new RangeError("Unknown measurement answer option");
  return answer === item.correctOptionId ? "correct" : "incorrect";
}

const phaseDelayMilliseconds: Record<MeasurementPhase, number> = {
  practice: 0, delay_48h: 48 * 60 * 60 * 1000, delay_7d: 7 * 24 * 60 * 60 * 1000,
};

/** Uses the enrollment-time frozen bank; revisions never reuse an exposed item. */
export function chooseNextMeasurementItem(input: {
  trial: MeasurementTrial;
  attempts: readonly MeasurementAttempt[];
  items: readonly MeasurementCatalogItem[];
  now: Date | string;
}): { item: MeasurementCatalogItem | null; dueAt: string | null; availableAt: string | null; complete: boolean } {
  const { trial, items } = input;
  if (trial.status === "completed") return { item: null, dueAt: null, availableAt: null, complete: true };
  const attempts = input.attempts.filter((attempt) => attempt.trialId === trial.id);
  if (attempts.some((attempt) => attempt.outcome === null && attempt.retractedAt === null)) {
    return { item: null, dueAt: null, availableAt: null, complete: false };
  }
  const presentedIds = new Set(attempts.map((attempt) => attempt.item.id));
  const phases: MeasurementPhase[] = ["practice", "delay_48h", "delay_7d"];
  const next = phases.flatMap((phase) => items.filter((item) => item.phase === phase))
    .find((item) => !presentedIds.has(item.id));
  if (!next) return { item: null, dueAt: null, availableAt: null, complete: true };
  if (next.phase === "practice") {
    return { item: trial.status === "active" ? next : null, dueAt: null, availableAt: null, complete: false };
  }
  if (trial.practiceCompletedAt === null) return { item: null, dueAt: null, availableAt: null, complete: false };
  const completedAt = new Date(trial.practiceCompletedAt).getTime();
  const now = new Date(input.now).getTime();
  if (!Number.isFinite(completedAt) || !Number.isFinite(now)) throw new RangeError("Invalid measurement clock");
  const due = completedAt + phaseDelayMilliseconds[next.phase];
  const dueAt = new Date(due).toISOString();
  // Keep the original protocol deadline for scoring. A late 48h return must
  // postpone presentation, without moving the 7d scoring window along with it.
  let available = due;
  if (next.phase === "delay_7d") {
    for (const attempt of attempts) {
      if (attempt.item.phase !== "delay_48h" || attempt.answeredAt === null) continue;
      const answeredAt = Date.parse(attempt.answeredAt);
      if (!Number.isFinite(answeredAt)) throw new RangeError("Invalid measurement clock");
      available = Math.max(available, answeredAt + MEASUREMENT_RETEST_GAP_MS);
    }
  }
  return { item: trial.status === "active" && now >= available ? next : null,
    dueAt, availableAt: new Date(available).toISOString(), complete: false };
}
