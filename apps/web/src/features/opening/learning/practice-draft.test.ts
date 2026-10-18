import { describe, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import type { createOpeningLearningClient } from "../client/learning-client";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { assertPracticeAttempt, emptyPracticeDraft, parsePracticeDraft, patchPracticeDraft, practiceScope, readPracticeDraft, readPracticeRecord, restoredPracticeAssistance, runPracticeRequest, writePracticeDraft } from "./practice-draft";

const courseId = "33333333-3333-4333-8333-333333333333";
const sessionId = "22222222-2222-4222-8222-222222222222";
const attemptId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const retestId = "66666666-6666-4666-8666-666666666666";
const attempt: LearningAttempt = { id: attemptId, workspaceId: courseId, sessionId, courseId, skillLabel: "矩阵", requirementKey: null, problemId: null, itemVersionId: null, sourceIds: [], sourceVersions: {}, startedAt: "2026-10-18T00:00:00.000Z", submittedAt: null, observationId: null, historyRevision: 0 };
type Client = ReturnType<typeof createOpeningLearningClient>;

function checkpoint(scope = practiceScope(courseId, "ordinary")) {
  return { ...emptyPracticeDraft(scope, { skillLabel: "矩阵", answer: "[[1,2]]" }), attemptId,
    start: { clientKey: "start-original-key", sessionId, sessionInput: { courseId, skillLabel: "矩阵", sourceIds: [] }, createInput: { sessionId, clientKey: "start-original-key" } },
    submission: { attemptId, input: { clientKey: "answer-original-key", answer: "[[1,2]]", assistance: "independent" as const, outcome: "unverified" as const } } };
}

it("restores unsent input and frozen request identities without accepting stored server results", () => {
  const draft = checkpoint();
  expect(parsePracticeDraft(JSON.parse(JSON.stringify(draft)), draft.scope)).toEqual(draft);
  expect(parsePracticeDraft({ ...draft, recorded: learningObservation }, draft.scope)).toBeNull();
  expect(parsePracticeDraft({ ...draft, submission: { ...draft.submission, input: { ...draft.submission.input, answer: "changed" } } }, draft.scope)).toBeNull();
  expect(parsePracticeDraft({ ...draft, start: { ...draft.start, createInput: { sessionId, clientKey: "different-key" } } }, draft.scope)).toBeNull();
});

it("isolates course, retest content/requirement and exercise modes before any resumed write", () => {
  const draft = checkpoint();
  const otherCourse = "77777777-7777-4777-8777-777777777777";
  expect(parsePracticeDraft({ ...draft, start: { ...draft.start, sessionInput: { ...draft.start.sessionInput, courseId: otherCourse } } }, draft.scope)).toBeNull();
  const retest = { retestId, skillLabel: "矩阵", prompt: "原题", requirementKey: "req-v1" };
  const scope = practiceScope(courseId, "ordinary", retest);
  expect(scope).not.toBe(practiceScope(courseId, "ordinary", { ...retest, prompt: "新题" }));
  expect(scope).not.toBe(practiceScope(courseId, "ordinary", { ...retest, requirementKey: "req-v2" }));
  expect(scope).not.toBe(practiceScope(courseId, "matrix"));
  expect(parsePracticeDraft({ ...draft, scope }, scope)).toBeNull();
  const proper = { ...draft, scope, start: { ...draft.start, sessionInput: { ...draft.start.sessionInput, requirementKey: "req-v1" }, createInput: { ...draft.start.createInput, requirementKey: "req-v1" } }, submission: { ...draft.submission, input: { ...draft.submission.input, retestId } } };
  expect(parsePracticeDraft(proper, scope)).toEqual(proper);
});

it("rejects a matrix request changed to a different variant or material", () => {
  const scope = practiceScope(courseId, "matrix");
  const draft = { ...emptyPracticeDraft(scope, { sourceId, matrixVariant: 2 }), start: { clientKey: "matrix-start-key", sessionId, sessionInput: { courseId, skillLabel: "矩阵乘法", sourceIds: [sourceId] }, createInput: { sessionId, clientKey: "matrix-start-key", matrixExercise: { sourceId, exerciseKey: "multiplication" as const, variant: 2 } } } };
  expect(parsePracticeDraft(draft, scope)).toEqual(draft);
  expect(parsePracticeDraft({ ...draft, fields: { ...draft.fields, matrixVariant: 3 } }, scope)).toBeNull();
});

it("keeps the newest document checkpoint when storage writes fail but old reads still succeed", () => {
  const scope = practiceScope(courseId, "ordinary", { retestId, skillLabel: "quota-test", prompt: crypto.randomUUID() });
  const stale = emptyPracticeDraft(scope, { answer: "old" });
  const current = emptyPracticeDraft(scope, { answer: "latest unsent answer" });
  const storage = { getItem: vi.fn(() => JSON.stringify(stale)), setItem: vi.fn(() => { throw new Error("quota"); }) };
  expect(writePracticeDraft(current, storage)).toBe(false);
  expect(readPracticeDraft(scope, storage)?.fields.answer).toBe("latest unsent answer");
  expect(storage.getItem).not.toHaveBeenCalled();
});

it("joins an existing in-flight request during route remount and retains its identity", async () => {
  let resolve!: (value: string) => void;
  const operation = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const key = crypto.randomUUID();
  const first = runPracticeRequest(key, operation);
  const resumed = runPracticeRequest(key, operation);
  expect(operation).toHaveBeenCalledTimes(1);
  resolve("same server attempt");
  await expect(Promise.all([first, resumed])).resolves.toEqual(["same server attempt", "same server attempt"]);
});

it("selects one start and submission key synchronously before the next React render", () => {
  const scope = practiceScope(courseId, "ordinary", { retestId, skillLabel: "atomic", prompt: crypto.randomUUID() });
  const selectStart = () => patchPracticeDraft(scope, {}, current => ({ start: current.start ?? { sessionId: null, clientKey: crypto.randomUUID(), createInput: null, sessionInput: { courseId, skillLabel: "matrix", sourceIds: [] } } }), null).draft;
  const first = selectStart();
  expect(selectStart().start?.clientKey).toBe(first.start?.clientKey);
  const selectSubmit = () => patchPracticeDraft(scope, {}, current => ({ attemptId, submission: current.submission ?? { attemptId, input: { clientKey: crypto.randomUUID(), answer: "original", outcome: "unverified", assistance: "unknown" } } }), null).draft;
  const submitted = selectSubmit();
  expect(selectSubmit().submission).toEqual(submitted.submission);
});

it("rejects canonical matrix identities that no longer match the frozen question", () => {
  const scope = practiceScope(courseId, "matrix");
  const draft = { ...emptyPracticeDraft(scope, { sourceId }), start: { clientKey: "matrix-start-key", sessionId, sessionInput: null, createInput: { sessionId, clientKey: "matrix-start-key", matrixExercise: { sourceId, exerciseKey: "multiplication" as const, variant: 0 } } } };
  expect(() => assertPracticeAttempt(draft, attempt)).toThrow("矩阵题目");
  expect(() => assertPracticeAttempt(draft, { ...attempt, sourceIds: [sourceId], matrixExercise: { kind: "matrix_arithmetic", specVersion: "matrix-arithmetic-v1", exerciseKey: "multiplication", variant: 1, matrixA: [[1]] } })).toThrow("矩阵题目");
  expect(() => assertPracticeAttempt(draft, { ...attempt, sourceIds: [sourceId], matrixExercise: { kind: "matrix_arithmetic", specVersion: "matrix-arithmetic-v1", exerciseKey: "multiplication", variant: 0, matrixA: [[1]] } })).not.toThrow();
});

it("rejects an old request result after the same draft has begun a different attempt in the same session", () => {
  const saved = checkpoint();
  expect(() => assertPracticeAttempt(saved, attempt, saved.start.clientKey)).not.toThrow();
  const next = { ...saved, attemptId: null, submission: null, start: { ...saved.start, clientKey: "new-repeat-key", createInput: { ...saved.start.createInput, clientKey: "new-repeat-key" } } };
  expect(() => assertPracticeAttempt(next, attempt, saved.start.clientKey)).toThrow("身份");
});

it("raises restored help without changing a frozen submission's original payload", () => {
  const draft = checkpoint();
  const raised = restoredPracticeAssistance(draft.fields, "revealed");
  expect(raised).toEqual({ assistance: "revealed", deliveredAssistance: "revealed" });
  expect(restoredPracticeAssistance(raised, "none")).toEqual(raised);
  expect(draft.submission.input.assistance).toBe("independent");
  expect(parsePracticeDraft({ ...draft, fields: { ...draft.fields, ...raised } }, draft.scope)).not.toBeNull();
});

describe("authoritative practice restoration", () => {
  const original = { ...learningObservation, id: "88888888-8888-4888-8888-888888888888", courseId, sessionId, attemptId, assistance: "independent" as const };
  const revised = { ...original, id: "99999999-9999-4999-8999-999999999999", revisionKind: "replace" as const, answer: "corrected answer", referenceCheck: undefined };
  function client(head: LearningObservation = revised): Client {
    return { getAttempt: vi.fn(async () => ({ attemptId, sessionId, deliveredAssistance: "revealed" })),
      listObservations: vi.fn(async () => [original]),
      getObservationHistory: vi.fn(async () => ({ rootObservationId: original.id, headObservationId: head.id, revisions: [original, head] })),
    } as unknown as Client;
  }
  it("reads current effective history rather than replaying a stale original observation", async () => {
    const result = await readPracticeRecord(client(), courseId, attempt);
    expect(result.observation).toEqual(revised);
    expect(result.deliveredAssistance).toBe("revealed");
    expect(result.observation?.assistance).toBe("independent"); // Preserve evidence at original submit; later exposure does not rewrite it.
  });
  it("fails closed on retraction, mismatched session or inaccessible history", async () => {
    await expect(readPracticeRecord(client({ ...revised, revisionKind: "retract" }), courseId, attempt)).rejects.toThrow("撤回");
    const mismatch = client();
    mismatch.getAttempt = vi.fn(async () => ({ attemptId, sessionId: courseId, deliveredAssistance: "none" as const }));
    await expect(readPracticeRecord(mismatch, courseId, attempt)).rejects.toThrow("身份");
    const unavailable = client();
    unavailable.getObservationHistory = vi.fn(async () => { throw new Error("unavailable"); });
    await expect(readPracticeRecord(unavailable, courseId, attempt)).rejects.toThrow("unavailable");
  });
  it("uses the saved observation identity only as a lookup and rejects a different attempt's history", async () => {
    const saved = client();
    saved.listObservations = vi.fn(async () => []);
    expect((await readPracticeRecord(saved, courseId, attempt, original.id)).observation).toEqual(revised);
    saved.getObservationHistory = vi.fn(async () => ({ rootObservationId: original.id, headObservationId: revised.id, revisions: [{ ...original, attemptId: courseId }, revised] }));
    await expect(readPracticeRecord(saved, courseId, attempt, original.id)).rejects.toThrow("不一致");
  });
});
