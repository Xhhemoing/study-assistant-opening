"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningSessionCreateInputSchema,
  type LearningAttempt, type LearningObservation,
} from "@aistudy/contracts";
import type { createOpeningLearningClient } from "../client/learning-client";
import { raiseAssistanceOnly, type DeliveredAssistance } from "./reference-check";

const fieldsSchema = z.object({
  sourceId: z.string().max(200), referenceSourceId: z.string().max(200), skillLabel: z.string().max(200),
  stem: z.string().max(4000), answer: z.string().max(20000),
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  assistance: z.enum(["unknown", "independent", "hinted", "revealed"]),
  deliveredAssistance: z.enum(["none", "hinted", "revealed"]),
  referenceSkipped: z.boolean(), matrixMode: z.boolean(),
  matrixKey: z.enum(["dimensions", "addition", "scalar", "multiplication"]), matrixVariant: z.number().int().min(0).max(8),
}).strict();
const startSchema = z.object({
  clientKey: z.string().min(8).max(200), sessionId: z.string().uuid().nullable(),
  sessionInput: learningSessionCreateInputSchema.nullable(), createInput: learningAttemptCreateInputSchema.nullable(),
}).strict().refine(value => value.createInput === null || (value.createInput.sessionId === value.sessionId && value.createInput.clientKey === value.clientKey));
const draftSchema = z.object({
  version: z.literal(1), scope: z.string(), fields: fieldsSchema, start: startSchema.nullable(),
  attemptId: z.string().uuid().nullable(), observationId: z.string().uuid().nullable(),
  submission: z.object({ attemptId: z.string().uuid(), input: learningAttemptSubmitInputSchema }).strict().nullable(),
  disputeKey: z.string().min(8).max(200).nullable(),
}).strict().refine(value => value.submission === null || value.submission.attemptId === value.attemptId);

export type PracticeFields = z.infer<typeof fieldsSchema>;
export type PracticeDraft = z.infer<typeof draftSchema>;
export type PracticeStart = NonNullable<PracticeDraft["start"]>;
type Client = ReturnType<typeof createOpeningLearningClient>;
const memory = new Map<string, PracticeDraft>();
const inFlight = new Map<string, Promise<unknown>>();
const unavailable = new Set<string>();
const storageKey = (scope: string) => `opening-practice:v1:${scope}`;

export function practiceScope(courseId: string, mode: "ordinary" | "matrix", retest?: { retestId: string; prompt: string; skillLabel: string; requirementKey?: string | null; retestActivityId?: string } | null): string {
  // Retest content/requirement changes never attach an older frozen request to a newer task.
  return JSON.stringify([courseId, mode, retest?.retestId ?? null, retest?.retestActivityId ?? null, retest?.requirementKey ?? null, retest?.skillLabel ?? null, retest?.prompt ?? null]);
}

export function emptyPracticeDraft(scope: string, fields: Partial<PracticeFields> = {}): PracticeDraft {
  return { version: 1, scope, fields: { sourceId: "", referenceSourceId: "", skillLabel: "", stem: "", answer: "", outcome: "unverified", assistance: "unknown", deliveredAssistance: "none", referenceSkipped: false, matrixMode: false, matrixKey: "multiplication", matrixVariant: 0, ...fields }, start: null, attemptId: null, observationId: null, submission: null, disputeKey: null };
}

export function parsePracticeDraft(raw: unknown, scope: string): PracticeDraft | null {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success || parsed.data.scope !== scope) return null;
  const draft = parsed.data;
  let context: unknown;
  try { context = JSON.parse(scope); } catch { return null; }
  if (!Array.isArray(context) || context.length !== 7) return null;
  const [courseId, mode, retestId, , requirementKey] = context;
  const start = draft.start;
  if (start) {
    if (!start.sessionInput && !start.createInput) return null;
    if (start.sessionInput && start.sessionInput.courseId !== courseId) return null;
    const input = start.createInput;
    if (mode === "matrix") {
      if (retestId !== null) return null;
      if (input && (!input.matrixExercise || input.matrixExercise.sourceId !== draft.fields.sourceId || input.matrixExercise.exerciseKey !== draft.fields.matrixKey || input.matrixExercise.variant !== draft.fields.matrixVariant)) return null;
      if (start.sessionInput && JSON.stringify(start.sessionInput.sourceIds) !== JSON.stringify([draft.fields.sourceId])) return null;
    } else if (mode === "ordinary") {
      if (input?.matrixExercise || input?.teachingBlock) return null;
      if (start.sessionInput && start.sessionInput.skillLabel !== draft.fields.skillLabel.trim()) return null;
      if (input?.problem && (input.problem.sourceId !== draft.fields.sourceId || input.problem.stemSnapshot !== draft.fields.stem.trim())) return null;
      if (retestId !== null && ((input && (input.requirementKey ?? null) !== requirementKey) || (start.sessionInput && (start.sessionInput.requirementKey ?? null) !== requirementKey))) return null;
    } else return null;
  }
  if (draft.attemptId && !start?.createInput) return null;
  if (draft.submission && ((draft.submission.input.retestId ?? null) !== retestId || draft.submission.input.answer !== draft.fields.answer || draft.submission.input.outcome !== draft.fields.outcome)) return null;
  return draft;
}

export function restoredPracticeAssistance(fields: Pick<PracticeFields, "assistance" | "deliveredAssistance">, delivered: DeliveredAssistance) {
  const deliveredAssistance: DeliveredAssistance = fields.deliveredAssistance === "revealed" || delivered === "revealed" ? "revealed" : fields.deliveredAssistance === "hinted" || delivered === "hinted" ? "hinted" : "none";
  return { deliveredAssistance, assistance: raiseAssistanceOnly(fields.assistance, deliveredAssistance) };
}

export function readPracticeDraft(scope: string, storage: Pick<Storage, "getItem"> | null): PracticeDraft | null {
  const cached = memory.get(scope);
  if (cached) return cached;
  if (!storage || unavailable.has(scope)) return null;
  try {
    const raw = storage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = parsePracticeDraft(JSON.parse(raw), scope);
    if (!parsed) return null;
    memory.set(scope, parsed);
    return parsed;
  } catch { unavailable.add(scope); return null; }
}

export function writePracticeDraft(draft: PracticeDraft, storage: Pick<Storage, "setItem"> | null): boolean {
  memory.set(draft.scope, draft);
  if (!storage || unavailable.has(draft.scope)) return false;
  try { storage.setItem(storageKey(draft.scope), JSON.stringify(draft)); return true; }
  catch { unavailable.add(draft.scope); return false; }
}

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}

/** Inputs/checkpoints only. Saved observation or attempt projections are never accepted as authority. */
export type DraftPatch = Partial<Omit<PracticeDraft, "scope" | "version" | "fields">> & { fields?: Partial<PracticeFields> };

/** Atomic checkpoint selection also covers two handlers before React's next render. */
export function patchPracticeDraft(scope: string, initial: Partial<PracticeFields>, change: DraftPatch | ((current: PracticeDraft) => DraftPatch), storage: Pick<Storage, "setItem"> | null) {
  const current = memory.get(scope) ?? emptyPracticeDraft(scope, initial);
  const changes = typeof change === "function" ? change(current) : change;
  const next = { ...current, ...changes, fields: { ...current.fields, ...changes.fields } };
  return { draft: next, persisted: writePracticeDraft(next, storage) };
}

export function assertPracticeAttempt(draft: PracticeDraft, attempt: LearningAttempt) {
  const [courseId, mode, retestId, , requirementKey] = JSON.parse(draft.scope) as unknown[];
  if (attempt.courseId !== courseId || (draft.attemptId && attempt.id !== draft.attemptId) || attempt.sessionId !== draft.start?.createInput?.sessionId) throw new Error("练习身份已改变，原草稿已保留。");
  if (mode === "matrix") {
    const input = draft.start?.createInput?.matrixExercise;
    if (!input || !attempt.matrixExercise || attempt.matrixExercise.exerciseKey !== input.exerciseKey || attempt.matrixExercise.variant !== input.variant || !attempt.sourceIds.includes(input.sourceId)) throw new Error("矩阵题目已改变，原答案已保留，请到课程历史核对。");
  } else if (attempt.matrixExercise || (retestId && attempt.requirementKey !== requirementKey)) throw new Error("练习要求已改变，原草稿已保留。");
}

export function usePracticeDraft(scope: string, initial: Partial<PracticeFields>) {
  const [draft, setDraft] = useState(() => emptyPracticeDraft(scope, initial));
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => {
    const stored = readPracticeDraft(scope, browserStorage());
    if (stored) { setDraft(stored); setRestored(Boolean(stored.start || stored.attemptId || stored.submission)); }
    setStorageWarning(!browserStorage() || unavailable.has(scope));
    setReady(true);
  }, [scope]);
  const patch = useCallback((change: DraftPatch | ((current: PracticeDraft) => DraftPatch)) => {
    const { draft: next, persisted } = patchPracticeDraft(scope, initial, change, browserStorage());
    if (!persisted) setStorageWarning(true);
    setDraft(next);
    return next;
  // The form is keyed by scope, so its initial values are immutable for this instance.
  }, [scope]);
  return { draft, patch, ready, restored, setRestored, storageWarning };
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
  if (id) {
    const history = await client.getObservationHistory(id);
    if (!history.revisions.some(row => row.id === history.rootObservationId && row.attemptId === attempt.id && row.sessionId === attempt.sessionId)) throw new Error("保存记录与原练习不一致，草稿已保留。");
    observation = history.revisions.find(row => row.id === history.headObservationId) ?? null;
    if (!observation || observation.revisionKind === "retract" || observation.courseId !== courseId) throw new Error("此练习记录已更新或撤回，请到课程历史核对；原草稿已保留。");
  }
  return { observation, deliveredAssistance: exposure.deliveredAssistance };
}
