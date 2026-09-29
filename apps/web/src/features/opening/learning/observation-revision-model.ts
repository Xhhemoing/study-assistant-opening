import { observationRevisionInputSchema, type LearningObservation, type ObservationHistory, type ObservationRevisionInput } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";

export type ObservationRevisionDraft = Pick<LearningObservation, "answer" | "outcome" | "assistance" | "courseId" | "skillLabel"> & { requirementKey: string };
export type ObservationRevisionEditor = {
  record: LearningObservation;
  expectedHead: string;
  draft: ObservationRevisionDraft;
  reason: string;
  revisionKind: "replace" | "retract";
  conflict: boolean;
};

export function observationRevisionDraft(record: LearningObservation): ObservationRevisionDraft {
  return { answer: record.answer, outcome: record.outcome, assistance: record.assistance, courseId: record.courseId, skillLabel: record.skillLabel, requirementKey: record.requirementKey ?? "" };
}

export function currentHistoryRecord(history: ObservationHistory): LearningObservation {
  const head = history.revisions.find((revision) => revision.id === history.headObservationId);
  if (!head) throw new Error("当前版本暂不可用，请刷新后重试。");
  return head;
}

/** A conflict refresh updates only the concurrency basis; unsaved edits remain reviewable. */
export function reloadObservationRevisionEditor(editor: ObservationRevisionEditor, history: ObservationHistory): ObservationRevisionEditor {
  return { ...editor, record: currentHistoryRecord(history), expectedHead: history.headObservationId, conflict: false };
}

export function observationRevisionCommand(input: Omit<ObservationRevisionEditor, "conflict"> & { clientKey: string }): ObservationRevisionInput {
  const operation = {
    rootObservationId: input.record.rootObservationId ?? input.record.id,
    revisesObservationId: input.expectedHead, expectedHead: input.expectedHead,
    reason: input.reason, clientKey: input.clientKey,
  };
  if (input.revisionKind === "retract") return observationRevisionInputSchema.parse({ ...operation, revisionKind: "retract" });
  return observationRevisionInputSchema.parse({ ...operation, revisionKind: "replace", replacement: {
    ...input.draft, skillLabel: input.draft.skillLabel.trim(), requirementKey: input.draft.requirementKey.trim() || null,
    // Editing an answer cannot carry the old answer's reference verification forward.
    verdictSource: "self_report", referenceSourceId: null,
  } });
}

export function observationRevisionFailure(error: unknown) {
  if (error instanceof OpeningApiError && error.status === 409) return { kind: "conflict" as const, message: "记录已被更新。你的输入已保留；请重新载入并查看最新版本，再提交纠正。" };
  if (error instanceof OpeningApiError && (error.status === 403 || error.status === 404)) return { kind: "unavailable" as const, message: "这条记录已不可用，已停止展示。请刷新课程记录。" };
  return { kind: "error" as const, message: error instanceof Error ? error.message : "保存失败，输入已保留，请重试。" };
}
