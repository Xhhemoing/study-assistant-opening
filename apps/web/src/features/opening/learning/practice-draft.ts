"use client";

import { useCallback, useEffect, useState } from "react";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import type { createOpeningLearningClient } from "../client/learning-client";
import { raiseAssistanceOnly, type DeliveredAssistance } from "./reference-check";
import { assertPracticeDraftSaved, emptyPracticeDraft, initializePracticeDraft, patchPracticeDraft, practiceDraftHasUnsavedStorage, readPracticeDraftCollection, switchPracticeDraft, type DraftPatch, type PracticeDraft, type PracticeDraftCollection, type PracticeFields } from "./practice-draft-storage";
export * from "./practice-draft-storage";

type Client = ReturnType<typeof createOpeningLearningClient>;
const inFlight = new Map<string, Promise<unknown>>();

export function restoredPracticeAssistance(fields: Pick<PracticeFields, "assistance" | "deliveredAssistance">, delivered: DeliveredAssistance) {
  const deliveredAssistance: DeliveredAssistance = fields.deliveredAssistance === "revealed" || delivered === "revealed" ? "revealed" : fields.deliveredAssistance === "hinted" || delivered === "hinted" ? "hinted" : "none";
  return { deliveredAssistance, assistance: raiseAssistanceOnly(fields.assistance, deliveredAssistance) };
}

export function assertPracticeAttempt(draft: PracticeDraft, attempt: LearningAttempt, expectedRequestKey?: string) {
  const [courseId, mode, retestId, , requirementKey, , , focusSkill, focusRequirement] = JSON.parse(draft.scope) as unknown[];
  if ((expectedRequestKey && draft.start?.clientKey !== expectedRequestKey) || attempt.courseId !== courseId || (draft.attemptId && attempt.id !== draft.attemptId) || attempt.sessionId !== draft.start?.createInput?.sessionId) throw new Error("练习身份已改变，原草稿已保留。");
  if (focusSkill && (attempt.skillLabel !== focusSkill || (attempt.requirementKey ?? null) !== focusRequirement)) throw new Error("针对练习的主题或要求已改变，原草稿已保留。");
  if (mode === "matrix") {
    const input = draft.start?.createInput?.matrixExercise;
    if (!input || !attempt.matrixExercise || attempt.matrixExercise.exerciseKey !== input.exerciseKey || attempt.matrixExercise.variant !== input.variant || !attempt.sourceIds.includes(input.sourceId)) throw new Error("矩阵题目已改变，原答案已保留，请到课程历史核对。");
  } else if (mode === "span") {
    const input = draft.start?.createInput?.spanExercise;
    if (!input || !attempt.spanExercise || attempt.spanExercise.id !== input.problemId || Number(attempt.spanExercise.version) !== input.version || !attempt.sourceIds.includes(input.sourceId)) throw new Error("span题目已改变，首答与请求已保留。");
  } else if (attempt.spanExercise || attempt.matrixExercise || (retestId && attempt.requirementKey !== requirementKey)) throw new Error("练习要求已改变，原草稿已保留。");
}

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

export function usePracticeDraft(scope: string, initial: Partial<PracticeFields>) {
  const [fallback] = useState(() => emptyPracticeDraft(scope, initial));
  const [collection, setCollection] = useState<PracticeDraftCollection>({ version: 2, scope, activeId: fallback.id, drafts: [fallback] });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  useEffect(() => {
    try {
      const storage = browserStorage();
      const stored = readPracticeDraftCollection(scope, storage);
      if (!stored && !storage) throw new Error("无法读取练习草稿，已停止新建和切换。请允许此页面使用浏览器存储后重试。");
      setCollection(stored ?? initializePracticeDraft(fallback));
      setStorageWarning(practiceDraftHasUnsavedStorage(scope));
      setLoadError(""); setReady(true);
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : "无法读取练习草稿"); setReady(false); }
  }, [scope, fallback, loadRevision]);
  const draft = collection.drafts.find(value => value.id === collection.activeId)!;
  const patch = useCallback((change: DraftPatch | ((current: PracticeDraft) => DraftPatch)) => {
    if (!ready) throw new Error("练习草稿尚未读完，未修改已保存的内容。");
    const result = patchPracticeDraft(scope, initial, change, browserStorage(), draft.id);
    setStorageWarning(!result.persisted);
    setCollection(readPracticeDraftCollection(scope, null)!);
    return result.draft;
  // Initial inputs belong to this scope. Each callback captures its own immutable draft identity.
  }, [scope, draft.id, ready]);
  function select(target: PracticeDraft | string): boolean {
    if (!ready) return false;
    try { setCollection(switchPracticeDraft(scope, draft.id, target, browserStorage())); setSwitchError(""); setStorageWarning(false); return true; }
    catch (reason) { setSwitchError(reason instanceof Error ? reason.message : "草稿未切换，原答案已保留"); return false; }
  }
  return { draft, drafts: collection.drafts, patch, ready, storageWarning, loadError, switchError,
    requireSaved: () => assertPracticeDraftSaved(scope),
    reload: () => setLoadRevision(value => value + 1),
    restore: (id: string) => select(id),
    startAnother: (fields: Partial<PracticeFields> = initial) => select(emptyPracticeDraft(scope, fields)),
  };
}

export type PracticeContinuity = ReturnType<typeof usePracticeDraft>;

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
  if (id) {
    const history = await client.getObservationHistory(id);
    if (!history.revisions.some(row => row.id === history.rootObservationId && row.attemptId === attempt.id && row.sessionId === attempt.sessionId)) throw new Error("保存记录与原练习不一致，草稿已保留。");
    observation = history.revisions.find(row => row.id === history.headObservationId) ?? null;
    if (!observation || observation.revisionKind === "retract" || observation.courseId !== courseId) throw new Error("此练习记录已更新或撤回，请到课程历史核对；原草稿已保留。");
  }
  return { observation, deliveredAssistance: exposure.deliveredAssistance };
}
