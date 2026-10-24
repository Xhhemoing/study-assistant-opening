import type { LearningAttempt } from "@aistudy/contracts";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import type { TeachingToolsContext } from "./teaching-workspace";

/** Match the existing contextual tool's source/version guards for the sole current unit. */
export function teachingAssistantContext(value: TeachingToolsContext): CurrentStudyContext {
  const learningAttempt = value.learningAttempt?.courseId === value.activity.courseId
    && value.learningAttempt?.requirementKey === `teaching:${value.blockId}:v${value.contentVersion}` ? value.learningAttempt : null;
  const questionBound = value.isQuestion && Boolean(learningAttempt);
  const source = value.sourceRefs.length === 1 ? value.sourceRefs[0] : undefined;
  const version = source && (typeof source.version === "number" || (typeof source.version === "string" && /^\d+$/.test(source.version))) ? Number(source.version) : undefined;
  const pinned = version !== undefined && Number.isSafeInteger(version) && version >= 0;
  // 讲解段落永远可以提问：资料版本无法锁定时只是不附带单一原文锚点（回答仍以真实引用为准），而不是拒绝提问。
  // 只有「题目尚未开始」才需要先开始本题，以便帮助记到这次作答上。
  const blockedReason = value.isQuestion && !learningAttempt ? "先开始或恢复本题，再围绕这道题提问。帮助会关联本次作答。" : undefined;
  return { isQuestion: value.isQuestion, learningAttempt, blockedReason,
    context: { courseId: value.activity.courseId ?? undefined, activityId: value.activity.id, blockId: value.blockId ?? undefined,
      contentVersion: value.contentVersion, attemptId: learningAttempt?.id, itemVersionId: learningAttempt?.itemVersionId ?? undefined,
      purpose: "learning_help", label: value.unitTitle, fragment: value.unitText,
      ...(!questionBound && source && pinned ? { sourceId: source.sourceId, sourceVersion: version, page: source.page ?? undefined, chunkId: source.chunkId ?? undefined } : {}),
      returnTo: value.activity.courseId ? `/opening/courses/${value.activity.courseId}/study` : "/opening/today" } };
}

export function spanPracticeEntryKey(courseId: string, mode: string, problemId: string, retestId?: string, newEvidenceEventId?: string): string {
  return JSON.stringify([courseId, mode, problemId, retestId ?? null, newEvidenceEventId ?? null]);
}

export function spanAssistantContext(courseId: string, isPresentation: boolean, attempt: LearningAttempt | null, unavailable: boolean): CurrentStudyContext {
  return { isQuestion: !isPresentation, learningAttempt: !isPresentation && !unavailable ? attempt : null,
    // 示范与讲解步骤不涉及作答，可直接围绕课程提问；练习题需先开始本题，帮助才能如实记到这次作答。
    blockedReason: isPresentation ? undefined
      : unavailable ? "课程材料暂不可核实，请先恢复本题的材料。"
        : !attempt ? "请先开始或恢复这道题，再围绕本题提问。" : undefined,
    context: { courseId, ...(!isPresentation && !unavailable && attempt ? { attemptId: attempt.id, itemVersionId: attempt.itemVersionId ?? undefined } : {}),
      purpose: "learning_help", label: isPresentation ? "线性组合与 span · 示范" : "线性组合与 span", returnTo: `/opening/courses/${courseId}/study/span` } };
}
