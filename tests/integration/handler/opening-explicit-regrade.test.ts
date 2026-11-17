import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EXPLICIT_REGRADE_CONFIRMATION_VERSION, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { createOpeningAiGradingRepository, createOpeningBudgetRepository, createOpeningExplicitRegradeRequestRepository,
  createOpeningJobRepository, reviseOpeningLearningObservation } from "@aistudy/database";
import { createModelGateway } from "../../../packages/ai/src/opening/model-gateway";
import { OpeningProviderError } from "../../../packages/ai/src/opening/provider";
import { createGradeObservationHandler } from "../../../apps/worker/src/jobs/grade-observation";
import { runJob } from "../../../apps/worker/src/runtime/run-job";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { middleware } from "../../../apps/web/src/middleware";
import { GET, POST } from "../../../apps/web/src/app/api/opening/observations/regrade/route";
import { POST as CONFIRM } from "../../../apps/web/src/app/api/opening/observations/regrade/confirm/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";
import { backupRows } from "../opening-backup-records-fixture";
import { useTutorModelFixture } from "./tutor-model-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
useTutorModelFixture();
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => { await f.reset(); await f.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
const originForTest = new URL(process.env.PUBLIC_BASE_URL ?? "http://localhost").origin;
const base = `${originForTest}/api/opening/observations/regrade`;
function request(method = "GET", body?: unknown, query = "", cookie = f.cookie, origin = originForTest) {
  return new Request(`${base}${query}`, { method, headers: { cookie, origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function post(body: unknown) { return POST(request("POST", body)); }
async function confirm(row: ExplicitRegradeRequest, extra = {}) {
  return CONFIRM(request("POST", { requestId: row.requestId, confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION,
    acceptPossibleDoubleCharge: true, ...extra }, "/confirm"));
}
const query = (input: { observationId: string; clientKey: string }, requestId?: string) =>
  `?${new URLSearchParams({ observationId: input.observationId, clientKey: input.clientKey, ...(requestId ? { requestId } : {}) })}`;
async function seed(photo = false) {
  const fixture = await learningAttemptFixture(f), attempt = await fixture.start();
  let workSource = null;
  if (photo) {
    const id = await backupRows(f.sql, f.scope).source();
    await f.sql`UPDATE opening_sources SET mime='image/png',parse_state='not_started' WHERE id=${id}`;
    workSource = { id, version: 1, physicalPage: 1 };
  }
  const original = photo ? await fixture.learning.insertObservation(f.scope, { attemptId: attempt.id,
    sessionId: fixture.sessionId, courseId: fixture.courseId, skillLabel: "fractions", sourceIds: [fixture.sourceId],
    answer: "见图", outcome: "unverified", assistance: "independent", clientKey: randomUUID() }, { workSource: workSource! })
    : await fixture.submit(attempt, { outcome: "unverified" });
  const [row] = await f.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${original.id}`;
  const operation = String(row!.grading_operation_id);
  await f.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${f.scope.workspaceId},'grading',9,${operation},'reserved',now(),now())`;
  return { fixture, original, operation, workSource, input: { observationId: original.id, expectedHead: original.id,
    expectedGradingVersion: 0, clientKey: randomUUID() } };
}
async function persisted() {
  return { jobs: [...await f.sql`SELECT * FROM opening_jobs ORDER BY id`],
    outbox: [...await f.sql`SELECT * FROM opening_outbox ORDER BY id`],
    fees: [...await f.sql`SELECT * FROM opening_budget_reservations ORDER BY id`],
    observations: [...await f.sql`SELECT * FROM opening_learning_observations ORDER BY id`],
    requests: [...await f.sql`SELECT * FROM opening_explicit_regrade_requests ORDER BY id`],
    versions: [...await f.sql`SELECT * FROM opening_source_versions ORDER BY source_id,version`] };
}
it("authenticates, validates strict inputs, denies CSRF through existing middleware and conceals foreign requests", async () => {
  const x = await seed(), before = await persisted();
  expect((await POST(request("POST", x.input, "", ""))).status).toBe(401);
  expect((await GET(request("GET", undefined, query(x.input), ""))).status).toBe(401);
  for (const body of [{ ...x.input, operationId: "invented" }, { ...x.input, workSourceId: randomUUID() }, { ...x.input, expectedHead: "bad" }])
    expect((await post(body)).status).toBe(400);
  const csrf = middleware(new NextRequest(request("POST", x.input, "", f.cookie, "https://foreign.invalid")));
  expect(csrf.status).toBe(403);
  expect(middleware(new NextRequest(request("POST", x.input))).headers.get("x-middleware-next")).toBe("1");
  expect(await persisted()).toEqual(before);
  const prepared = await (await post(x.input)).json();
  const snapshot = await (await GET(request("GET", undefined, `?observationId=${x.original.id}`))).json();
  expect(snapshot.snapshot).toMatchObject({ rootObservationId: x.original.id, expectedHead: x.original.id,
    answerRevision: 1, privacyEpoch: 0, previousGradingVersion: 0, oldStatus: "unknown_cost" });
  // Actual foreign observation and consent, not a guessed missing UUID.
  const foreign = await learningAttemptFixture({ ...f, scope: f.otherScope }), other = await foreign.submit(await foreign.start(), { outcome: "unverified" });
  expect((await GET(request("GET", undefined, `?observationId=${other.id}`))).status).toBe(404);
  const [otherRow] = await f.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${other.id}`;
  await f.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${f.otherScope.workspaceId},'grading',1,${otherRow!.grading_operation_id},'reserved',now(),now())`;
  const foreignInput = { observationId: other.id, expectedHead: other.id, expectedGradingVersion: 0, clientKey: randomUUID() };
  const foreignRequest = await createOpeningExplicitRegradeRequestRepository(f.sql).prepare(f.otherScope, foreignInput);
  expect((await GET(request("GET", undefined, query(foreignInput, foreignRequest.requestId)))).status).toBe(404);
  expect((await GET(request("GET", undefined, query(foreignInput)))).status).toBe(404);
  expect((await confirm(foreignRequest)).status).toBe(404);
  expect((await createOpeningExplicitRegradeRequestRepository(f.sql).read(f.otherScope, prepared.request.requestId).catch(e => e)).code).toBe("NOT_FOUND");
  for (const extra of [{ acceptPossibleDoubleCharge: false }, { confirmationVersion: "wrong" }, { operationId: "invented" }])
    expect((await confirm(prepared.request, extra)).status).toBe(400);
});

it.each(["correct", "unverified"] as const)("real authenticated POST/GET → budget/gateway/worker → %s result, without paid network", async outcome => {
  const x = await seed(), before = await persisted();
  const preparedResponse = await post(x.input), prepared = await preparedResponse.json();
  expect(preparedResponse.status).toBe(200); expect(preparedResponse.headers.get("Cache-Control")).toBe("no-store");
  expect(prepared).toMatchObject({ kind: "prepared", request: { state: "prepared", jobId: null } });
  expect(prepared.estimateCents).toBeGreaterThan(0); expect(prepared.estimate).toContain((prepared.estimateCents / 100).toFixed(2));
  const afterPrepare = await persisted();
  expect(afterPrepare.jobs).toEqual(before.jobs); expect(afterPrepare.fees).toEqual(before.fees);
  const recovered = await GET(request("GET", undefined, query(x.input)));
  expect(await recovered.json()).toEqual(prepared); expect(await persisted()).toEqual(afterPrepare);
  const confirmedResponse = await confirm(prepared.request), confirmed = await confirmedResponse.json();
  expect(confirmedResponse.status).toBe(202);
  expect(confirmed).toMatchObject({ kind: "progress", snapshot: { previousGradingVersion: 1, oldStatus: "queued" },
    progress: { request: { state: "confirmed" }, status: { status: "queued", retryable: false } } });
  const row = confirmed.progress.request as ExplicitRegradeRequest;
  expect((await (await confirm(row)).json()).progress.request.jobId).toBe(row.jobId);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE key=${row.operationId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_outbox WHERE job_id=${row.jobId}`).toHaveLength(1);
  await expect(createOpeningAiGradingRepository(f.sql).apply(f.scope, { observationId: x.original.id }, {
    outcome: "correct", confidence: .95, questionMatch: true, feedback: "late old result",
    criteria: [{ label: "sum", verdict: "correct", feedback: "late" }],
  }, "synthetic")).rejects.toMatchObject({ code: "CONFLICT" });
  const complete = vi.fn(async () => ({ text: JSON.stringify({ outcome, confidence: .95, questionMatch: true,
    feedback: "synthetic", criteria: [{ label: "sum", verdict: outcome === "correct" ? "correct" : "unverified", feedback: "checked" }] }),
    inputTokens: 10, outputTokens: 10, citedChunkIds: [], requestId: null, candidates: [] }));
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete }, modelSnapshot: {
    id: "synthetic", providerId: "fixture", modelName: "synthetic", inputCentsPerMillion: 100, outputCentsPerMillion: 100 },
    inputCentsPerMillion: 100, outputCentsPerMillion: 100 }) });
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100000 }), queue = createOpeningJobRepository(f.sql);
  const handler = createGradeObservationHandler({ repository: createOpeningAiGradingRepository(f.sql), gateway,
    budget: scope => ({ reserve: input => budget.reserve(scope, input), release: (...args) => budget.release(scope, ...args),
      claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args),
      markUnknown: id => budget.markUnknown(scope, id) }), images: async () => [] });
  expect(await runJob(queue, row.jobId!, handler)).toBe(true);
  expect((await queue.get(f.scope, row.jobId!)).state).toBe("succeeded");
  expect(await runJob(queue, row.jobId!, handler)).toBe(false);
  expect(complete).toHaveBeenCalledTimes(1);
  const result = await (await GET(request("GET", undefined, query(x.input, row.requestId)))).json();
  expect(result.progress.status).toMatchObject({ status: outcome === "correct" ? "graded" : "needs_manual", retryable: false, jobId: row.jobId });
  expect(result.progress.request.resultObservationId).not.toBeNull();
  expect(result.progress.status.headObservationId).toBe(outcome === "correct" ? result.progress.request.resultObservationId : row.expectedHead);
  const repositoryStatus = await createOpeningExplicitRegradeRequestRepository(f.sql).read(f.scope, row.requestId);
  expect(repositoryStatus).toMatchObject({ ledger: "completed", jobState: "succeeded", status: outcome === "correct" ? "graded" : "needs_manual" });
  // Fee uncertainty outranks even a real published result.
  await f.sql`UPDATE opening_budget_reservations SET state='reserved',outcome_unknown_at=now() WHERE request_id=${row.operationId}`;
  const unknown = await (await GET(request("GET", undefined, query(x.input, row.requestId)))).json();
  expect(unknown.progress.status).toMatchObject({ status: "unknown_cost", retryable: false, headObservationId: row.expectedHead });
  expect((await createOpeningExplicitRegradeRequestRepository(f.sql).read(f.scope, row.requestId)).status).toBe("unknown_cost");
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE request_id=${row.operationId}`).toHaveLength(1);
  expect([...await f.sql`SELECT * FROM opening_budget_reservations WHERE request_id=${x.operation}`]).toEqual(before.fees);
});

it.each([false, true])("treats the primary estimate as non-cap while a not-sent fallback still obeys the worker budget (capped %s)", async capped => {
  const x = await seed(), before = await persisted();
  const catalog = JSON.parse(process.env.OPENING_MODEL_CATALOG!);
  vi.stubEnv("OPENING_MODEL_CATALOG", JSON.stringify([...catalog, { ...catalog[0], id: "expensive-backup", modelName: "expensive-backup",
    inputCentsPerMillion: 1000000, outputCentsPerMillion: 1000000 }]));
  await f.sql`UPDATE workspace_preferences SET ai_settings=jsonb_set(COALESCE(ai_settings,'{}'::jsonb),'{taskRoutes}',
    ${f.sql.json({ "practice.grade-text": { primary: "handler-model", fallback: "expensive-backup" } })}) WHERE workspace_id=${f.scope.workspaceId}`;
  const prepared = await (await post(x.input)).json();
  expect(prepared.estimateCents).toBeGreaterThan(0);
  expect(prepared.estimate).toContain("当前预估预留");
  expect(prepared.estimate).toContain("不是费用上限");
  expect(prepared.estimate).toContain("备用模型可能改变费用");
  expect(prepared.estimate).toContain("旧请求仍可能另行收费");
  expect(prepared.request.confirmationText).toContain("两次都可能收费");
  const confirmed = await (await confirm(prepared.request)).json(), row = confirmed.progress.request as ExplicitRegradeRequest;
  const primary = vi.fn(async () => { throw new OpeningProviderError("PROVIDER_AUTH", "synthetic not sent", false, false); });
  const backup = vi.fn(async () => ({ text: JSON.stringify({ outcome: "correct", confidence: .95, questionMatch: true, feedback: "synthetic backup",
    criteria: [{ label: "sum", verdict: "correct", feedback: "checked" }] }), inputTokens: 10, outputTokens: 10,
    citedChunkIds: [], requestId: null, candidates: [] }));
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete: primary }, modelSnapshot: { id: "handler-model",
    providerId: "fixture", modelName: "handler-model", inputCentsPerMillion: 100, outputCentsPerMillion: 100 },
    inputCentsPerMillion: 100, outputCentsPerMillion: 100 }),
  resolveFallback: async () => ({ provider: { complete: backup }, modelSnapshot: { id: "expensive-backup", providerId: "fixture",
    modelName: "expensive-backup", inputCentsPerMillion: 1000000, outputCentsPerMillion: 1000000 }, inputCentsPerMillion: 1000000, outputCentsPerMillion: 1000000 }) });
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: capped ? 20 : 100000 }), queue = createOpeningJobRepository(f.sql);
  const handler = createGradeObservationHandler({ repository: createOpeningAiGradingRepository(f.sql), gateway,
    budget: scope => ({ reserve: input => budget.reserve(scope, input), release: (...args) => budget.release(scope, ...args),
      claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args), markUnknown: id => budget.markUnknown(scope, id) }), images: async () => [] });
  expect(await runJob(queue, row.jobId!, handler)).toBe(true);
  expect(primary).toHaveBeenCalledOnce();
  expect((await queue.get(f.scope, row.jobId!)).state).toBe(capped ? "failed" : "succeeded");
  expect(backup).toHaveBeenCalledTimes(capped ? 0 : 1);
  const [released] = await f.sql`SELECT state,release_reason FROM opening_budget_reservations WHERE request_id=${row.operationId}`;
  expect(released).toMatchObject({ state: "released", release_reason: "not_sent" });
  const fallback = await f.sql`SELECT * FROM opening_budget_reservations WHERE request_id=${`${row.operationId}:fallback`}`;
  if (capped) expect(fallback).toHaveLength(0);
  else {
    expect(fallback).toHaveLength(1); expect(fallback[0]!.state).toBe("completed");
    expect(Number(fallback[0]!.amount_cents)).toBeGreaterThan(prepared.estimateCents);
    expect(Number(fallback[0]!.reserved_amount_cents)).toBeGreaterThan(prepared.estimateCents);
  }
  expect([...await f.sql`SELECT * FROM opening_budget_reservations WHERE request_id=${x.operation}`]).toEqual(before.fees);
  expect(await runJob(queue, row.jobId!, handler)).toBe(false); expect(primary).toHaveBeenCalledOnce();
});

it("cross-tab confirmation consumes one successor and GET/confirm never retries its unknown operation", async () => {
  const x = await seed(), a = await (await post(x.input)).json(), b = await (await post({ ...x.input, clientKey: randomUUID() })).json();
  const responses = await Promise.all([confirm(a.request), confirm(b.request)]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies.filter(body => body.kind === "progress")).toHaveLength(1);
  const winner = bodies.find(body => body.kind === "progress").progress.request as ExplicitRegradeRequest;
  const key = winner.requestId === a.request.requestId ? x.input.clientKey : (await f.sql`SELECT client_key FROM opening_explicit_regrade_requests WHERE id=${winner.requestId}`)[0]!.client_key;
  await f.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${f.scope.workspaceId},'grading',1,${winner.operationId},'reserved',now(),now())`;
  const before = await persisted();
  const read = await (await GET(request("GET", undefined, query({ observationId: x.original.id, clientKey: key }, winner.requestId)))).json();
  expect(read.progress.status.status).toBe("unknown_cost");
  expect((await (await confirm(winner)).json()).progress.status.status).toBe("unknown_cost");
  expect(await persisted()).toEqual(before);
  const nextInput = { ...x.input, clientKey: randomUUID(), expectedGradingVersion: 1 };
  const next = await (await post(nextInput)).json(); expect(next.request.gradingVersion).toBe(2);
  expect((await confirm(next.request)).status).toBe(202);
  expect((await (await GET(request("GET", undefined, query({ observationId: x.original.id, clientKey: key }, winner.requestId)))).json()).kind).toBe("conflict");
  expect((await createOpeningExplicitRegradeRequestRepository(f.sql).read(f.scope, winner.requestId)).ledger).toBe("unknown");
});

it("reports the actual running job and rechecks changed budget before consuming consent", async () => {
  const x = await seed(), prepared = await (await post(x.input)).json();
  expect(prepared.estimateCents).toBeGreaterThan(0);
  vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "1");
  expect((await confirm(prepared.request)).status).toBe(409);
  expect((await f.sql`SELECT confirmed_at FROM opening_explicit_regrade_requests WHERE id=${prepared.request.requestId}`)[0]!.confirmed_at).toBeNull();
  vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "100000");
  const confirmed = await (await confirm(prepared.request)).json();
  const row = confirmed.progress.request as ExplicitRegradeRequest;
  await createOpeningJobRepository(f.sql).claim(row.jobId!);
  const running = await (await GET(request("GET", undefined, query(x.input)))).json();
  expect(running.progress.status).toMatchObject({ status: "grading", jobId: row.jobId });
  expect(running.snapshot.oldStatus).toBe("grading");
});

it("keeps GET recovery read-only even while another tab holds the history write lock", async () => {
  const x = await seed(), prepared = await (await post(x.input)).json(), before = await persisted();
  await f.sql.begin(async tx => {
    await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId} FOR UPDATE`;
    const response = await GET(request("GET", undefined, query(x.input)));
    expect(response.status).toBe(200);
    expect((await response.json()).request.requestId).toBe(prepared.request.requestId);
  });
  expect(await persisted()).toEqual(before);
});

it("pins a sealed photo and refuses a later privacy exclusion without leaking its old request", async () => {
  const x = await seed(true);
  vi.stubEnv("OPENING_MODEL_CATALOG", JSON.stringify([{ id: "handler-model", label: "Handler fixture", providerId: "fixture",
    providerLabel: "Fixture", modelName: "gpt-6-luna", apiKeyEnv: "OPENING_HANDLER_MODEL_KEY", baseUrl: "https://handler-model.invalid/v1",
    inputCentsPerMillion: 100, outputCentsPerMillion: 100, supportsVision: true,
    mediaInputTokenUpperBound: 10000, mediaMaxInputBytes: 3000000, mediaInputCentsPerMillion: 100 }]));
  const prepared = await (await post(x.input)).json();
  expect(prepared.request.workSource).toEqual(x.workSource);
  expect(prepared.estimateCents).toBeGreaterThan(0);
  const confirmed = await (await confirm(prepared.request)).json();
  expect(confirmed.progress.status).toMatchObject({ status: "queued", workSource: x.workSource });
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${x.workSource!.id})`;
  expect((await GET(request("GET", undefined, query(x.input)))).status).toBe(404);
});

it.each(["revision", "epoch", "privacy", "source", "photo"] as const)("rejects stale %s on confirm and read without new jobs or fees", async change => {
  const x = await seed(change === "photo"), prepared = await (await post(x.input)).json();
  if (change === "revision") await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: x.original.id,
    expectedHead: x.original.id, revisesObservationId: x.original.id, revisionKind: "replace", reason: "changed",
    clientKey: randomUUID(), replacement: { answer: "changed", outcome: "unverified", assistance: "independent" } });
  if (change === "epoch") await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
  if (change === "privacy") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${x.fixture.sourceId})`;
  if (change === "source") await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.fixture.sourceId}`;
  if (change === "photo") await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.workSource!.id}`;
  if (change === "revision") {
    const latest = await (await GET(request("GET", undefined, `?observationId=${x.original.id}`))).json();
    expect(latest.snapshot).toMatchObject({ answerRevision: 2, previousGradingVersion: 0, oldStatus: "needs_manual" });
    expect(latest.snapshot.expectedHead).not.toBe(x.original.id);
  }
  const before = await persisted();
  const response = await confirm(prepared.request), body = await response.json();
  expect(response.status === 404 || response.status === 409 || body.kind === "conflict").toBe(true);
  const read = await GET(request("GET", undefined, query(x.input, prepared.request.requestId))), readBody = await read.json();
  expect(read.status === 404 || read.status === 409 || readBody.kind === "conflict").toBe(true);
  expect(await persisted()).toEqual(before);
  if (change === "epoch") await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch-1 WHERE id=${f.scope.workspaceId}`;
});

it("missing estimates cannot confirm, requestId:null uses clientKey read only, stage-one confirmation reports null job status", async () => {
  const x = await seed();
  vi.stubEnv("OPENING_MODEL_CATALOG", "[]");
  const prepared = await (await post(x.input)).json(); expect(prepared.estimate).toBeNull();
  const before = await persisted();
  // HTTP omits null query values; the service also accepts the adapter's null input.
  const { getExplicitRegradeService } = await import("../../../apps/web/src/features/opening/learning/explicit-regrade-runtime");
  expect((await getExplicitRegradeService(f.sql).read(f.scope, { observationId: x.original.id, clientKey: x.input.clientKey, requestId: null })).kind).toBe("prepared");
  expect((await confirm(prepared.request)).status).toBe(409); expect(await persisted()).toEqual(before);
  await f.sql`UPDATE opening_explicit_regrade_requests SET confirmed_at=now() WHERE id=${prepared.request.requestId}`;
  const confirmed = await (await GET(request("GET", undefined, query(x.input)))).json();
  expect(confirmed).toMatchObject({ kind: "progress", progress: { status: null, request: { state: "confirmed", jobId: null } } });
  expect(await f.sql`SELECT id FROM opening_jobs WHERE key=${prepared.request.operationId}`).toHaveLength(0);
});
