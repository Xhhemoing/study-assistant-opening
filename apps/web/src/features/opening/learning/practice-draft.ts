"use client";

import { useCallback, useEffect, useState } from "react";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import type { createOpeningLearningClient } from "../client/learning-client";
import { raiseAssistanceOnly, type DeliveredAssistance } from "./reference-check";
import { assertPracticeDraftSaved, emptyPracticeDraft, initializePracticeDraft, isRecoverableManualDraft, moveArchivedPracticeDraft, patchPracticeDraft, practiceDraftHasUnsavedStorage, readPartitionedPracticeDraftCollection, readPracticeDraftCollection, reconcileMovedPracticeArchives, switchPracticeDraft, type DraftPatch, type PracticeDraft, type PracticeDraftCollection, type PracticeDraftScopes, type PracticeFields } from "./practice-draft-storage";
import { userFacingMessage } from "../../../lib/user-facing-error";
export * from "./practice-draft-storage";

type Client = ReturnType<typeof createOpeningLearningClient>;
const inFlight = new Map<string, Promise<unknown>>();

export function restoredPracticeAssistance(fields: Pick<PracticeFields, "assistance" | "deliveredAssistance">, delivered: DeliveredAssistance) {
  const deliveredAssistance: DeliveredAssistance = fields.deliveredAssistance === "revealed" || delivered === "revealed" ? "revealed" : fields.deliveredAssistance === "hinted" || delivered === "hinted" ? "hinted" : "none";
  return { deliveredAssistance, assistance: raiseAssistanceOnly(fields.assistance, deliveredAssistance) };
}

export function assertPracticeAttempt(draft: PracticeDraft, attempt: LearningAttempt, expectedRequestKey?: string) {
  const context = JSON.parse(draft.scope) as unknown[];
  const [courseId, mode, retestId, , requirementKey] = context;
  const [focusSkill, focusRequirement] = context.length >= 9 ? context.slice(7, 9) : [];
  if ((expectedRequestKey && draft.start?.clientKey !== expectedRequestKey) || attempt.courseId !== courseId || (draft.attemptId && attempt.id !== draft.attemptId) || attempt.sessionId !== draft.start?.createInput?.sessionId) throw new Error("练习身份已改变，原草稿已保留。");
  if (focusSkill && (attempt.skillLabel !== focusSkill || (attempt.requirementKey ?? null) !== focusRequirement)) throw new Error("针对练习的主题或要求已改变，原草稿已保留。");
  const question = context.length === 10 ? context[9] as { sourceId: string; sourceVersion: number } : null;
  if (question && (!attempt.sourceIds.includes(question.sourceId) || attempt.sourceVersions[question.sourceId] !== question.sourceVersion)) throw new Error("题图版本已改变，原题干和答案已保留，请重新核对题图。");
  if (mode === "matrix") {
    const input = draft.start?.createInput?.matrixExercise;
    if (!input || !attempt.matrixExercise || attempt.matrixExercise.exerciseKey !== input.exerciseKey || attempt.matrixExercise.variant !== input.variant || !attempt.sourceIds.includes(input.sourceId)) throw new Error("矩阵题目已改变，原答案已保留，请到课程历史核对。");
  } else if (mode === "span") {
    const input = draft.start?.createInput?.spanExercise;
    if (!input || !attempt.spanExercise || attempt.spanExercise.id !== input.problemId || Number(attempt.spanExercise.version) !== input.version || !attempt.sourceIds.includes(input.sourceId)
      || (attempt.contextAnchor?.sourceId && attempt.contextAnchor.sourceId !== input.sourceId)
      || (context[3] && attempt.contextAnchor?.activityId && attempt.contextAnchor.activityId !== context[3])) throw new Error("span题目已改变，首答与请求已保留。");
  } else if (attempt.spanExercise || attempt.matrixExercise || (retestId && attempt.requirementKey !== requirementKey)) throw new Error("练习要求已改变，原草稿已保留。");
}

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function usePracticeDraft(scope: string, initial: Partial<PracticeFields>, scopes?: PracticeDraftScopes, targetScopeFor?: (draft: PracticeDraft) => string) {
  const [fallback] = useState(() => emptyPracticeDraft(scope, initial));
  const [collection, setCollection] = useState<PracticeDraftCollection>({ version: 2, scope, activeId: fallback.id, drafts: [fallback] });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [hiddenArchives, setHiddenArchives] = useState<ReadonlySet<string>>();
  useEffect(() => {
    try {
      const storage = browserStorage();
      const stored = scopes
        ? readPartitionedPracticeDraftCollection(scopes, fallback, storage)
        : readPracticeDraftCollection(scope, storage);
      if (!stored && !storage) throw new Error("无法读取练习草稿，已停止新建和切换。请允许此页面使用浏览器存储后重试。");
      const restored = stored ?? initializePracticeDraft(fallback);
      if (targetScopeFor) setHiddenArchives(reconcileMovedPracticeArchives(restored, targetScopeFor, storage));
      setCollection(targetScopeFor ? readPracticeDraftCollection(scope, null)! : restored);
      setStorageWarning(practiceDraftHasUnsavedStorage(scope));
      setLoadError(""); setReady(true);
    } catch (reason) { setLoadError(userFacingMessage(reason, "无法读取练习草稿")); setReady(false); }
  }, [scope, fallback, scopes, loadRevision, targetScopeFor]);
  const draft = collection.drafts.find(value => value.id === collection.activeId)!;
  const drafts = scopes?.manual === scope ? collection.drafts.filter(isRecoverableManualDraft)
    : hiddenArchives?.size ? collection.drafts.filter(value => value.id === draft.id || !hiddenArchives.has(value.id))
      : collection.drafts;
  const patch = useCallback((change: DraftPatch | ((current: PracticeDraft) => DraftPatch)) => {
    if (!ready) throw new Error("练习草稿尚未读完，未修改已保存的内容。");
    const result = patchPracticeDraft(scope, initial, change, browserStorage(), draft.id);
    setStorageWarning(!result.persisted);
    setCollection(readPracticeDraftCollection(scope, null)!);
    return result.draft;
  // Initial inputs belong to this scope. Each callback captures its own immutable draft identity.
  }, [scope, draft.id, ready]);
  function select(switchDraft: (storage: Storage | null) => PracticeDraftCollection): boolean {
    if (!ready) return false;
    try {
      const selected = switchDraft(browserStorage());
      setCollection(selected.scope === scope ? selected : readPracticeDraftCollection(scope, null)!);
      setSwitchError("");
      return true;
    }
    catch (reason) { setSwitchError(userFacingMessage(reason, "草稿未切换，原答案已保留")); return false; }
    finally { setStorageWarning(practiceDraftHasUnsavedStorage(scope)); }
  }
  return { draft, drafts, patch, ready, storageWarning, loadError, switchError,
    requireSaved: () => assertPracticeDraftSaved(scope),
    reload: () => setLoadRevision(value => value + 1),
    restore: (id: string, targetScope = scope) => drafts.some(value => value.id === id) && select(storage => targetScope === scope
      ? switchPracticeDraft(scope, draft.id, id, storage)
      : moveArchivedPracticeDraft(scope, draft.id, id, targetScope, storage)),
    startAnother: (fields: Partial<PracticeFields> = initial) => select(storage => switchPracticeDraft(scope, draft.id, emptyPracticeDraft(scope, fields), storage)),
  };
}

export type PracticeContinuity = ReturnType<typeof usePracticeDraft>;

/** A returning view can subscribe without initiating another write. */
export function pendingPracticeRequest<T>(key: string): Promise<T> | undefined {
  return inFlight.get(key) as Promise<T> | undefined;
}

/** Share a write already in flight across route unmount/remount within this document. */
export async function runPracticeRequest<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = operation();
  inFlight.set(key, pending);
  try { return await pending; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}

export async function readPracticeRecord(client: Client, courseId: string, attempt: LearningAttempt, knownObservationId?: string | null) {
  if (attempt.courseId !== courseId) throw new Error("练习与当前课程不一致，草稿已保留，请到原课程继续。");
  const exposure = await client.getAttempt(attempt.id);
  if (exposure.attemptId !== attempt.id || exposure.sessionId !== attempt.sessionId) throw new Error("练习身份已改变，草稿已保留。");
  const rows = await client.listObservations(courseId);
  const id = attempt.observationId ?? knownObservationId ?? rows.find(row => row.attemptId === attempt.id)?.id;
  let observation: LearningObservation | null = null;
  let originalObservation: LearningObservation | null = null;
  if (id) {
    const history = await client.getObservationHistory(id);
    originalObservation = history.revisions.find(row => row.id === history.rootObservationId) ?? null;
    if (!originalObservation || originalObservation.attemptId !== attempt.id || originalObservation.sessionId !== attempt.sessionId) throw new Error("保存记录与原练习不一致，草稿已保留。");
    observation = history.revisions.find(row => row.id === history.headObservationId) ?? null;
    if (!observation || observation.revisionKind === "retract" || observation.courseId !== courseId) throw new Error("此练习记录已更新或撤回，请到课程历史核对；原草稿已保留。");
  }
  return { observation, originalObservation, deliveredAssistance: exposure.deliveredAssistance };
}
