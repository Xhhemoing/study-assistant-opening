import { randomUUID } from "node:crypto";
import type { LearningObservation } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { createSpanDelayedRetestService } from "./delayed-retest-service";

const dependencies = vi.hoisted(() => ({
  history: vi.fn(), evidence: vi.fn(), save: vi.fn(), lockCandidate: vi.fn(), lockHistory: vi.fn(),
  preferences: vi.fn(), revision: vi.fn(), accept: vi.fn(),
}));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningRepository: () => ({ observationHistory: dependencies.history }),
  createOpeningRetestRepository: (db: Sql) => ({ saveCandidates: (...args: unknown[]) => db.begin(() => dependencies.save(...args)) }),
  readOpeningLearningEvidenceContext: dependencies.evidence,
  lockOpeningRetestReviewCandidate: dependencies.lockCandidate,
  lockWorkspaceLearningHistory: dependencies.lockHistory,
  lockLearningPreferences: dependencies.preferences,
  nextWorkspaceLearningHistoryRevision: dependencies.revision,
}));
vi.mock("../../learning/retest-service", () => ({
  createOpeningRetestService: (db: Sql) => ({ accept: (...args: unknown[]) => db.begin(() => dependencies.accept(...args)) }),
}));
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const head = {
  id: randomUUID(), rootObservationId: randomUUID(), courseId: randomUUID(), skillLabel: SPAN_SKILL_LABEL,
  requirementKey: SPAN_REQUIREMENT_KEY, attemptId: randomUUID(), revisionKind: "original",
  sourceIds: [randomUUID()], submittedAt: "2026-10-01T12:00:00.000Z", recordedAt: "2026-10-01T12:00:01.000Z",
  serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "correct" },
} as LearningObservation;
const request = { observationId: head.id, clientKey: "span-delayed-test" };
const dueAt = "2026-10-04T12:00:01.000Z";
function harness(options: { existing?: boolean; status?: string; accepted?: boolean; taskId?: string | null; protocol?: object } = {}) {
  let payload: Record<string, unknown> = { id: randomUUID(), courseId: head.courseId, skillLabel: SPAN_SKILL_LABEL,
    requirementKey: SPAN_REQUIREMENT_KEY, prompt: "隔天重做原题", sourceIds: [randomUUID()], dueAt: "2026-10-03T00:00:00.000Z",
    evidenceObservationIds: [randomUUID()], evidenceRootIds: [randomUUID()], accepted: options.accepted ?? false, kind: "task",
    ...(options.protocol ? { spanDelayedProtocol: options.protocol } : {}) };
  let activity = { id: randomUUID(), status: options.status ?? "proposed", task_id: options.taskId ?? null, not_before_at: null as string | null,
    accepted_at: null as string | null, learning_protocol: null as Record<string, unknown> | null,
    candidate_reference_id: null as string | null, accept_client_key: null as string | null };
  let jobPresent = true;
  let exists = options.existing ?? true;
  const calls: string[] = [];
  const savepoint = vi.fn(async (work: (tx: TransactionSql) => Promise<unknown>) => work(sql as unknown as TransactionSql));
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim(); calls.push(query);
    if (query.startsWith("SELECT r.id AS replay_activity_id")) return Promise.resolve(activity.accept_client_key === values[2] ? [{
      replay_activity_id: activity.id, ...activity, course_id: head.courseId, replay_task_id: activity.task_id,
      baseline_id: activity.learning_protocol?.baselineObservationId, baseline_root_id: activity.learning_protocol?.baselineRootId,
      submitted_at: head.submittedAt, recorded_at: head.recordedAt,
    }] : []);
    if (query.startsWith("SELECT id AS replay_candidate_id")) return Promise.resolve(payload.acceptClientKey === request.clientKey ? [{ replay_candidate_id: payload.id, payload }] : []);
    if (query.startsWith("SELECT candidate_id")) return Promise.resolve(exists && ["proposed", "accepted", "in_progress"].includes(activity.status) ? [{ candidate_id: jobPresent ? payload.id : null }] : []);
    if (query.startsWith("SELECT id,status,task_id")) return Promise.resolve([activity]);
    if (query.startsWith("UPDATE opening_jobs")) { payload = structuredClone(values[0]) as typeof payload; return Promise.resolve([]); }
    if (query.startsWith("UPDATE opening_retest_activities SET learning_protocol")) {
      activity = { ...activity, learning_protocol: structuredClone(values[0]) as Record<string, unknown>,
        candidate_reference_id: values[1] as string, accept_client_key: values[2] as string };
      return Promise.resolve([activity]);
    }
    if (query.startsWith("UPDATE opening_retest_activities")) { activity.not_before_at = values[0] as string; return Promise.resolve([]); }
    if (query.startsWith("SELECT id,not_before_at")) return Promise.resolve([activity]);
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as Sql & { savepoint: typeof savepoint };
  sql.json = ((value: unknown) => value) as Sql["json"];
  sql.savepoint = savepoint;
  sql.begin = (async (work: (tx: TransactionSql) => Promise<unknown>) => {
    const previous = structuredClone({ payload, activity, exists, jobPresent });
    try { return await work(sql as unknown as TransactionSql); }
    catch (error) { ({ payload, activity, exists, jobPresent } = previous); throw error; }
  }) as Sql["begin"];
  dependencies.lockCandidate.mockImplementation(async () => payload);
  dependencies.save.mockImplementation(async (_scope: unknown, candidates: Record<string, unknown>[]) => {
    payload = candidates[0]!; exists = true; return candidates;
  });
  dependencies.accept.mockImplementation(async () => {
    const taskId = activity.task_id ?? randomUUID();
    payload.accepted = true; payload.acceptClientKey = request.clientKey;
    if (activity.status === "proposed") activity = { ...activity, status: "accepted", task_id: taskId, accepted_at: "2026-10-01T13:00:00.000Z" };
    return { taskId };
  });
  return { sql, savepoint, calls, restore: () => { jobPresent = false; }, finish: (status: string) => { activity.status = status; }, state: () => structuredClone({ payload, activity, exists, jobPresent }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  dependencies.history.mockResolvedValue({ headObservationId: head.id, revisions: [head] });
  dependencies.evidence.mockResolvedValue({ context: { version: { applicability: "exact" } } });
  dependencies.preferences.mockResolvedValue({ retestSuggestionsEnabled: true });
});

it("converts the scanner's proposed candidate to the explicit baseline before accepting, and replays without rewriting", async () => {
  const h = harness(), original = h.state();
  const service = createSpanDelayedRetestService(h.sql);
  const first = await service.schedule(scope, request);
  expect(first).toMatchObject({ candidateId: original.payload.id, notBeforeAt: dueAt });
  expect(h.state().payload).toMatchObject({ sourceIds: head.sourceIds, evidenceObservationIds: [head.id], evidenceRootIds: [head.rootObservationId],
    dueAt, accepted: true, spanDelayedProtocol: { protocolId: "span-delayed-3d-v1", baselineObservationId: head.id, baselineRootId: head.rootObservationId, priorAnswerPolicy: "require_unseen_problem" } });
  expect(h.state().payload.prompt).not.toBe(original.payload.prompt);
  const stable = h.state();
  expect(await service.schedule(scope, request)).toEqual(first);
  expect(h.state()).toEqual(stable);
  expect(dependencies.save).not.toHaveBeenCalled();
  expect(dependencies.revision).toHaveBeenCalledTimes(2);
  expect(h.savepoint).toHaveBeenCalledTimes(1);
  expect(dependencies.lockHistory.mock.invocationCallOrder[0]).toBeLessThan(dependencies.history.mock.invocationCallOrder[0]!);
});

it("creates and accepts a new candidate using nested savepoints of the same transaction", async () => {
  const h = harness({ existing: false });
  const result = await createSpanDelayedRetestService(h.sql).schedule(scope, request);
  expect(result).toMatchObject({ candidateId: head.id, notBeforeAt: dueAt });
  expect(dependencies.save).toHaveBeenCalledTimes(1);
  expect(h.savepoint).toHaveBeenCalledTimes(2);
});

it.each(["completed", "cancelled"])("replays the original acceptance after the activity is %s", async status => {
  const h = harness(), service = createSpanDelayedRetestService(h.sql);
  const first = await service.schedule(scope, request);
  h.finish(status);
  const before = h.state();
  expect(await service.schedule(scope, request)).toEqual(first);
  expect(h.state()).toEqual(before);
  expect(dependencies.save).not.toHaveBeenCalled();
  expect(dependencies.revision).toHaveBeenCalledTimes(2);
});

it.each([
  { status: "accepted", accepted: true, taskId: randomUUID() },
  { status: "in_progress", accepted: true, taskId: randomUUID() },
  { status: "proposed", accepted: true },
  { status: "proposed", taskId: randomUUID() },
  { protocol: { protocolId: "span-delayed-3d-v1", baselineObservationId: randomUUID() } },
])("refuses to reinterpret an already consumed or different protocol candidate: %j", async options => {
  const h = harness(options), before = h.state();
  await expect(createSpanDelayedRetestService(h.sql).schedule(scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(h.state()).toEqual(before);
  expect(dependencies.accept).not.toHaveBeenCalled();
});

it.each(["changed_needs_check", "unavailable", "privacy_excluded", "version_unknown"])("refuses a %s baseline before candidate mutation", async applicability => {
  const h = harness(), before = h.state();
  dependencies.evidence.mockResolvedValue({ context: { version: { applicability } } });
  await expect(createSpanDelayedRetestService(h.sql).schedule(scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(h.state()).toEqual(before); expect(h.calls.every(query => query.startsWith("SELECT r.id AS replay_activity_id"))).toBe(true);
});

it.each([{ revisionKind: "retract" }, { id: randomUUID() }, { submittedAt: null }, { recordedAt: null }])("requires the current sealed baseline with trusted timing: %j", async change => {
  const h = harness(), record = { ...head, ...change };
  dependencies.history.mockResolvedValue({ headObservationId: record.id, revisions: [record] });
  await expect(createSpanDelayedRetestService(h.sql).schedule(scope, request)).rejects.toThrow();
  expect(dependencies.accept).not.toHaveBeenCalled(); expect(h.calls.every(query => query.startsWith("SELECT r.id AS replay_activity_id"))).toBe(true);
});

it("rolls back conversion when acceptance rejects an already-used client key", async () => {
  const h = harness(), before = h.state();
  dependencies.accept.mockRejectedValue(Object.assign(new Error("clientKey payload differs"), { code: "CONFLICT" }));
  await expect(createSpanDelayedRetestService(h.sql).schedule(scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(h.state()).toEqual(before);
});

it("does not convert a proposal after retest suggestions are disabled", async () => {
  const h = harness(), before = h.state();
  dependencies.preferences.mockResolvedValue({ retestSuggestionsEnabled: false });
  await expect(createSpanDelayedRetestService(h.sql).schedule(scope, request)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(h.state()).toEqual(before); expect(dependencies.accept).not.toHaveBeenCalled();
});

it("replays a restored acceptance without jobs or imported scoring authority, using the stable activity URL", async () => {
  const h = harness(), service = createSpanDelayedRetestService(h.sql);
  const first = await service.schedule(scope, request);
  expect(first.href).toBe(`/opening/courses/${head.courseId}/study/span?retest=${first.activityId}`);
  h.restore(); dependencies.history.mockRejectedValue(new Error("imported evaluation is unknown"));
  const before = h.state(), historyReads = dependencies.history.mock.calls.length;
  expect(await service.schedule(scope, request)).toEqual(first);
  expect(h.state()).toEqual(before);
  expect(dependencies.history).toHaveBeenCalledTimes(historyReads);
  expect(dependencies.accept).toHaveBeenCalledOnce();
  await expect(service.schedule(scope, { ...request, observationId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
});
