import type { LearningAttempt } from "@aistudy/contracts";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import type { TeachingToolsContext } from "./teaching-workspace";

/** Match the existing contextual tool's source/version guards for the sole current unit. */
export function teachingAssistantContext(value: TeachingToolsContext): CurrentStudyContext {
  const questionBound = value.isQuestion && Boolean(value.learningAttempt);
  const source = value.sourceRefs.length === 1 ? value.sourceRefs[0] : undefined;
  const version = source && (typeof source.version === "number" || (typeof source.version === "string" && /^\d+$/.test(source.version))) ? Number(source.version) : undefined;
  const pinned = version !== undefined && Number.isSafeInteger(version) && version >= 0;
  const blockedReason = value.isQuestion && !value.learningAttempt ? "先保存自己的原答案，再围绕这道题提问。帮助会关联本次作答。"
    : questionBound ? undefined
      : value.sourceRefs.length > 1 ? "请从「提问与笔记」选定一份固定版本原材料，再围绕这段讲解提问。"
        : source && !pinned ? "这段讲解的资料版本暂不可核实。请从引用入口打开固定版本原文后提问。"
          : !source && value.activity.sourceIds.length ? "这段讲解没有可锁定的资料版本。请打开原材料后提问。" : undefined;
  return { isQuestion: value.isQuestion, learningAttempt: value.learningAttempt, blockedReason,
    context: { courseId: value.activity.courseId ?? undefined, activityId: value.activity.id, blockId: value.blockId ?? undefined,
      contentVersion: value.contentVersion, attemptId: value.learningAttempt?.id, itemVersionId: value.learningAttempt?.itemVersionId ?? undefined,
      purpose: "learning_help", label: value.unitTitle, fragment: value.unitText,
      ...(!questionBound && source && pinned ? { sourceId: source.sourceId, sourceVersion: version, page: source.page ?? undefined, chunkId: source.chunkId ?? undefined } : {}),
      returnTo: value.activity.courseId ? `/opening/courses/${value.activity.courseId}/study` : "/opening/today" } };
}

export function spanPracticeEntryKey(courseId: string, mode: string, problemId: string, retestId?: string, newEvidenceEventId?: string): string {
  return JSON.stringify([courseId, mode, problemId, retestId ?? null, newEvidenceEventId ?? null]);
}

export function spanAssistantContext(courseId: string, isPresentation: boolean, attempt: LearningAttempt | null, unavailable: boolean): CurrentStudyContext {
  return { isQuestion: !isPresentation, learningAttempt: !isPresentation && !unavailable ? attempt : null,
    blockedReason: unavailable ? "课程材料暂不可核实，请先恢复本题的材料。"
      : isPresentation ? "当前是示范步骤；请进入练习并固定题目后，从本题继续提问。"
        : !attempt ? "请先开始或恢复这道题，再围绕本题提问。" : undefined,
    context: { courseId, ...(!isPresentation && !unavailable && attempt ? { attemptId: attempt.id, itemVersionId: attempt.itemVersionId ?? undefined } : {}),
      purpose: "learning_help", label: "线性组合与 span", returnTo: `/opening/courses/${courseId}/study/span` } };
}
