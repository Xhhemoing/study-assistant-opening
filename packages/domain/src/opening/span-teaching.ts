import type { SpanTeachingMode, SpanTeachingMove, StudySessionIntent } from "@aistudy/contracts";
import { SPAN_KNOWLEDGE_COMPONENTS } from "./span-teaching-catalog";

export const DEFAULT_STUDY_SESSION_INTENT: StudySessionIntent = { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
/** Explicit preferences apply immediately; this function never invents a confirmation. */
export function updateStudySessionIntent(current: StudySessionIntent, change: Partial<StudySessionIntent>): StudySessionIntent {
  if (change.timeBudgetMinutes !== undefined && (!Number.isFinite(change.timeBudgetMinutes) || change.timeBudgetMinutes <= 0 || change.timeBudgetMinutes > 240)) throw new RangeError("Time budget must be within 0–240 minutes");
  return { ...current, ...change };
}
export function spanModeForIntent(intent: StudySessionIntent): SpanTeachingMode {
  return intent.purpose === "overview" ? "overview" : intent.purpose === "challenge" ? "challenge" : "self_study";
}
/** Small, explainable rules for explicit instructions; no inferred scientific weights. */
export function applyExplicitStudyIntent(current: StudySessionIntent, message: string): { intent: StudySessionIntent; signals: StudySessionSignal[]; needsConfirmation: boolean } {
  if (/["'“”‘’「」『』`]|为什么|是什么意思|怎么|如何|能否|是否|如果|例如|比如|假如/.test(message)) return { intent: { ...current }, signals: [], needsConfirmation: false };
  // A positive substring inside a denied request/self-report is not consent.
  // Preserve the last confirmed intent until the alternative is made explicit.
  const denied = /(?:不要|别|不想|不需要|不必|无需|不打算|不是要|不是想|并非要)[^。！？\n]{0,16}(?:英文|中文|双语|快速|加快|讲慢|串讲|拔高|自学|复习|冲刺|先学|从零开始|先从基础学|巩固|保持|探路|关键步骤|完整讲解)|(?:没有|没|不是|并非)[^。！？\n]{0,6}(?:抄(?:了)?答案|猜的|蒙的)/.test(message);
  if (denied) return { intent: { ...current }, signals: [], needsConfirmation: true };
  const change: Partial<StudySessionIntent> = {};
  const explicitPurposes = ([
    ["串讲", "overview"], ["拔高", "challenge"], ["自学", "self_study"], ["复习", "review"], ["冲刺", "exam_sprint"],
  ] as const).filter(([phrase]) => message.includes(phrase));
  const needsConfirmation = explicitPurposes.length > 1 && /还是|或者|或是/.test(message);
  if (needsConfirmation) return { intent: { ...current }, signals: [], needsConfirmation: true };
  if (!needsConfirmation && explicitPurposes.length > 0) change.purpose = explicitPurposes.at(-1)![1];
  if (/快速|快一点|加快/.test(message)) change.pace = "fast";
  if (/慢一点|讲慢|慢慢/.test(message)) change.pace = "slow";
  if (/直接给关键步骤|只(?:要|讲|给).*关键步骤/.test(message)) { change.explanationStyle = "key_steps"; change.pace = "fast"; }
  if (/完整讲解|详细讲/.test(message)) change.explanationStyle = "full";
  if (/用英文|英文讲解/.test(message)) change.language = "en";
  if (/用中文|中文讲解/.test(message)) change.language = "zh";
  if (/双语|中英对照/.test(message)) change.language = "bilingual";
  if (/连续推进|继续往下|一直讲/.test(message)) change.continuous = true;
  if (/一步一步等我|每步等我|不要连续/.test(message)) change.continuous = false;
  if (/我(?:很累|累了)|有点累/.test(message)) change.selfReportedFatigue = "high";
  if (/(?:完全不会|一点也不会|从零开始|先学|先从基础学)/.test(message)) change.learningPhase = "new_learning";
  if (/先巩固/.test(message)) change.learningPhase = "consolidate";
  if (/先探路/.test(message)) change.learningPhase = "explore";
  if (/先保持/.test(message)) change.learningPhase = "maintain";
  if (change.learningPhase === "new_learning" || change.learningPhase === "consolidate") change.purpose = "self_study";
  const minutes = /(?:我只有|我有|时间预算(?:是|为)?|限时)\s*(\d+)\s*分钟/.exec(message);
  if (minutes && Number(minutes[1]) > 0 && Number(minutes[1]) <= 240) change.timeBudgetMinutes = Number(minutes[1]);
  const signals: StudySessionSignal[] = [];
  if (/我不懂|看不懂|没看懂/.test(message)) signals.push("confused");
  if (/太简单/.test(message)) signals.push("too_easy");
  if (/我是猜的|我猜的|蒙的/.test(message)) signals.push("guessed");
  if (/抄了答案|抄的答案|照着答案/.test(message)) signals.push("copied_answer");
  let intent = updateStudySessionIntent(current, change);
  for (const signal of signals) intent = applyStudySessionSignal(intent, signal).intent;
  return { intent, signals, needsConfirmation };
}
export type StudySessionSignal = "confused" | "too_easy" | "guessed" | "copied_answer";
export function applyStudySessionSignal(intent: StudySessionIntent, signal: StudySessionSignal): {
  intent: StudySessionIntent; action: "diagnose" | "increase_challenge" | "continue";
  reportedGuess: boolean; restrictIndependence: boolean; changesCorrectness: false; needsLaterVerification: boolean;
} {
  return { intent: signal === "confused" ? { ...intent, purpose: "confused", pace: "slow" } : signal === "too_easy" ? { ...intent, purpose: "challenge" } : { ...intent }, action: signal === "confused" ? "diagnose" : signal === "too_easy" ? "increase_challenge" : "continue", reportedGuess: signal === "guessed", restrictIndependence: signal === "copied_answer", changesCorrectness: false, needsLaterVerification: signal === "too_easy" || signal === "copied_answer" || signal === "guessed" };
}
export type StudySupportKind = "faithful_translation" | "term_definition" | "modeling_hint" | "equation_setup" | "key_step" | "answer";
/** Language help and mathematics help have separate effects on the target claim. */
export function studySupportAffectsIndependence(kind: StudySupportKind, target: "mathematics" | "english_reading"): boolean {
  return target === "english_reading" || (kind !== "faithful_translation" && kind !== "term_definition");
}
function move(mode: SpanTeachingMode, id: string, kind: SpanTeachingMove["presentation"]["kind"], instructions: string, studentAction: string, allowedHelp: SpanTeachingMove["allowedHelp"], expectedObservation: string, final = false, components: readonly string[] = SPAN_KNOWLEDGE_COMPONENTS): SpanTeachingMove {
  return { id, mode, targetKnowledgeComponents: [...components], presentation: { kind, instructions }, studentAction, allowedHelp, expectedObservation, continuation: { onSuccess: final ? "delayed_check" : "next_move", onFailure: "diagnose", stopWhen: final ? "封存独立首答并确定性核对；记录实际曝光后安排延迟复测，不能据此宣称保持" : "观察到目标表现才继续；达到时间预算或用户要求停止时保存进度" } };
}
/** Cross-KC modes declare their additional targets instead of relabeling a span score. */
export function createSpanTeachingSequence(mode: SpanTeachingMode): SpanTeachingMove[] {
  if (mode === "overview") return [
    move(mode, "overview-links", "worked_example", "把 αv+βw=u、增广矩阵与几何可达区域并排展示。", "逐一说明向量等式中的每个坐标如何成为方程，并解释几何含义。", "full_example", "能解释 span、方程组相容性、几何表示的对应关系。", false, [...SPAN_KNOWLEDGE_COMPONENTS, "linear-system:consistency", "geometry:plane-equation"]),
    move(mode, "overview-contrast", "contrast", "对比独立生成向量、相关生成向量与不相容目标。", "先判断题型，再选择方法；说明唯一解、多解、无解区别。", "step_hint", "能辨别问题结构，而非只照搬计算。"),
    move(mode, "overview-mixed", "independent_item", "给出跨方程与几何表征的未展示题，隐藏答案。", "独立计算并解释联系；解释质量与精确系数判分分开记录。", "language_only", "多个相关知识点分别有证据；只通过span题不视为串讲通过。", true, [...SPAN_KNOWLEDGE_COMPONENTS, "linear-system:consistency", "geometry:plane-equation"]),
  ];
  if (mode === "challenge") return [
    move(mode, "challenge-predict", "predict_then_explore", "先预测相关生成向量能否到达任意目标，再操作系数检查。", "给出反例并说明生成向量变化后结论成立条件。", "step_hint", "区分生成集合改变与仅调整系数。", false, [...SPAN_KNOWLEDGE_COMPONENTS, "geometry:line-equation"]),
    move(mode, "challenge-transfer", "independent_item", "使用预先声明表征转换的任务，隐藏示例答案。", "给出无解或多解证明；将代数约束转为几何解释。", "language_only", "完成预设迁移目标；精确验证器只验证其覆盖的代数部分。", true, [...SPAN_KNOWLEDGE_COMPONENTS, "linear-system:consistency", "geometry:line-equation"]),
  ];
  return [
    move(mode, "self-example", "worked_example", "解释span含义，逐步展示题意→向量等式→系数→全部坐标检查。", "说明每个方程来自哪个坐标。", "full_example", "能复述为何所有坐标必须同时成立。"),
    move(mode, "self-faded", "faded_example", "换一道题，仅展示向量等式，逐步省略系数与坐标检查。", "补全省略步骤；先作答再请求提示。", "step_hint", "能自行求系数并检查第三个坐标。"),
    move(mode, "self-independent", "independent_item", "提供未展示过的新题；仅允许忠实翻译与术语解释，答案保持隐藏。", "先提交独立首答与坐标检查，再查看核对结果。", "language_only", "建立等式、系数检验与全部坐标检查各自有可追溯证据。", true),
  ];
}
