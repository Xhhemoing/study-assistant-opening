import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EXPLICIT_REGRADE_CONFIRMATION_VERSION, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { createOpeningExplicitRegradeRequestRepository, reviseOpeningLearningObservation } from "@aistudy/database";
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

// Synthetic loopback adapter: no Next dev server, browser, or paid provider.
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
let server: Server, httpBase: string;
const evidence: unknown[] = [];
beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const method = incoming.method ?? "GET";
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const req = new Request(httpBase + incoming.url, { method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
      const gate = middleware(new NextRequest(req.clone()));
      const response = gate.headers.get("x-middleware-next") === "1"
        ? method === "GET" ? await GET(req) : incoming.url?.startsWith("/api/opening/observations/regrade/confirm") ? await CONFIRM(req) : await POST(req)
        : gate;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ wrapperError: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no random loopback port");
  httpBase = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("PUBLIC_BASE_URL", httpBase);
});
beforeEach(() => vi.stubEnv("PUBLIC_BASE_URL", httpBase));
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (process.env.NEGATIVE_EVIDENCE) writeFileSync(process.env.NEGATIVE_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
});
async function http(method: string, suffix = "", body?: unknown, options: { cookie?: string; origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { cookie: options.cookie ?? f.cookie, "content-type": "application/json" };
  if (options.origin !== null) headers.origin = options.origin ?? httpBase;
  const response = await fetch(httpBase + "/api/opening/observations/regrade" + suffix, { method, headers,
    ...(body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}) });
  const result = { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  evidence.push({ method, suffix, ...result });
  return result;
}
const consent = (row: ExplicitRegradeRequest) => ({ requestId: row.requestId,
  confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, acceptPossibleDoubleCharge: true });
async function audit(label: string) {
  const state = await persisted();
  const counts = { jobs: state.jobs.length, outbox: state.outbox.length, reservations: state.fees.length,
    requests: state.requests.length, observations: state.observations.length };
  evidence.push({ label, counts, state });
  return state;
}
function typed(result: Awaited<ReturnType<typeof http>>, status: number, code: string) {
  expect(result.status).toBe(status); expect(result.body.error.code).toBe(code);
  if (status !== 403) expect(result.cache).toBe("no-store");
}

it("HTTP N1: auth precedes body parsing; missing/foreign Origin denies prepare AND confirm without mutation", async () => {
  const x = await seed();
  const p = (await http("POST", "", x.input)).body;
  const before = await audit("N1-before");
  typed(await http("POST", "", undefined, { cookie: "", raw: "{" }), 401, "UNAUTHENTICATED");
  typed(await http("POST", "/confirm", consent(p.request), { cookie: "" }), 401, "UNAUTHENTICATED");
  typed(await http("GET", query(x.input), undefined, { cookie: "" }), 401, "UNAUTHENTICATED");
  for (const origin of [null, "https://foreign.invalid"]) {
    typed(await http("POST", "", x.input, { origin }), 403, "FORBIDDEN");
    typed(await http("POST", "/confirm", consent(p.request), { origin }), 403, "FORBIDDEN");
  }
  expect(await audit("N1-after")).toEqual(before);
});

it("HTTP N2: real foreign consent and cross-wired owner recovery selectors are concealed without mutation", async () => {
  const x = await seed(), y = await seed();
  const a = (await http("POST", "", x.input)).body.request;
  const b = (await http("POST", "", y.input)).body.request;
  const foreign = await learningAttemptFixture({ ...f, scope: f.otherScope });
  const other = await foreign.submit(await foreign.start(), { outcome: "unverified" });
  const [r] = await f.sql`SELECT grading_operation_id FROM opening_learning_observations WHERE id=${other.id}`;
  await f.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,execution_claimed_at,outcome_unknown_at)
    VALUES(${f.otherScope.workspaceId},'grading',1,${r!.grading_operation_id},'reserved',now(),now())`;
  const input = { observationId: other.id, expectedHead: other.id, expectedGradingVersion: 0, clientKey: randomUUID() };
  const otherRequest = await createOpeningExplicitRegradeRequestRepository(f.sql).prepare(f.otherScope, input);
  const before = await audit("N2-before");
  typed(await http("POST", "", input), 404, "NOT_FOUND");
  typed(await http("POST", "/confirm", consent(otherRequest)), 404, "NOT_FOUND");
  for (const suffix of [query(input), query(input, otherRequest.requestId),
    query(x.input, b.requestId), query({ ...x.input, clientKey: y.input.clientKey }, a.requestId),
    query({ ...x.input, observationId: y.original.id }, a.requestId)]) {
    typed(await http("GET", suffix), 404, "NOT_FOUND");
  }
  expect(await audit("N2-after")).toEqual(before);
});

it("HTTP N3: clientKey recovers lost prepare AND pending-enqueue consent read-only without repairing job", async () => {
  const x = await seed();
  await http("POST", "", x.input); // response deliberately not used for recovery
  const before = await audit("N3-before-prepared-GET");
  const recovered = await http("GET", query(x.input));
  expect(recovered.status).toBe(200); expect(recovered.cache).toBe("no-store"); expect(recovered.body.kind).toBe("prepared");
  expect(await audit("N3-after-prepared-GET")).toEqual(before);
  const row = recovered.body.request;
  await f.sql`UPDATE opening_explicit_regrade_requests SET confirmed_at=now() WHERE id=${row.requestId}`;
  const pending = await audit("N3-before-pending-GET");
  for (const suffix of [query(x.input), query(x.input, row.requestId)]) {
    const result = await http("GET", suffix);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: "progress", progress: { request: { state: "confirmed", jobId: null }, status: null } });
  }
  expect(await audit("N3-after-pending-GET")).toEqual(pending);
  expect(await f.sql`SELECT id FROM opening_jobs WHERE key=${row.operationId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE request_id=${row.operationId}`).toHaveLength(0);
  expect(pending.jobs).toEqual(before.jobs); expect(pending.fees).toEqual(before.fees);
});

it("HTTP N4: concurrent duplicate confirms of SAME consent return one durable job and no new reservation", async () => {
  const x = await seed(), prepared = (await http("POST", "", x.input)).body;
  const before = await audit("N4-before");
  const responses = await Promise.all([http("POST", "/confirm", consent(prepared.request)), http("POST", "/confirm", consent(prepared.request))]);
  expect(responses.map(r => r.status)).toEqual([202, 202]);
  expect(responses[0]!.body.progress.request.jobId).toBe(responses[1]!.body.progress.request.jobId);
  const after = await audit("N4-after");
  expect(after.jobs).toHaveLength(before.jobs.length + 1); expect(after.outbox).toHaveLength(before.outbox.length + 1);
  expect(after.fees).toEqual(before.fees); expect(after.observations).toEqual(before.observations);
  const stable = await audit("N4-before-recovery");
  expect((await http("GET", query(x.input))).body.progress.status.status).toBe("queued");
  expect(await audit("N4-after-recovery")).toEqual(stable);
});

it("HTTP N5: epoch/head/photo drift with simultaneous duplicate confirms preserves zero new jobs/fees", async () => {
  for (const change of ["epoch", "head", "photo"] as const) {
    const x = await seed(change === "photo"), prepared = (await http("POST", "", x.input)).body;
    if (change === "epoch") await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    if (change === "head") await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: x.original.id,
      expectedHead: x.original.id, revisesObservationId: x.original.id, revisionKind: "replace", reason: "synthetic drift",
      clientKey: randomUUID(), replacement: { answer: "changed", outcome: "unverified", assistance: "independent" } });
    if (change === "photo") await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.workSource!.id}`;
    const before = await audit(`N5-${change}-before`);
    const replies = await Promise.all([http("POST", "/confirm", consent(prepared.request)), http("POST", "/confirm", consent(prepared.request))]);
    for (const reply of [...replies, await http("GET", query(x.input))]) {
      if (change === "epoch") typed(reply, 404, "NOT_FOUND");
      else {
        expect(reply.status).toBe(409);
        expect(reply.body.kind === "conflict" || reply.body.error?.code === "CONFLICT").toBe(true);
      }
      expect(reply.cache).toBe("no-store");
    }
    expect(await audit(`N5-${change}-after`)).toEqual(before);
    if (change === "epoch") await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch-1 WHERE id=${f.scope.workspaceId}`;
  }
});

it("HTTP N6: byte-limit and strict schema negatives across prepare/confirm/GET leave persisted consent unchanged", async () => {
  const x = await seed(), p = (await http("POST", "", x.input)).body.request;
  const before = await audit("N6-before");
  for (const suffix of ["", "/confirm"]) {
    typed(await http("POST", suffix, undefined, { raw: "{" }), 400, "VALIDATION");
    typed(await http("POST", suffix, undefined, { raw: JSON.stringify({ padding: "界".repeat(45000) }) }), 413, "VALIDATION");
    typed(await http("POST", suffix, null), 400, "VALIDATION");
  }
  for (const input of [{ ...x.input, clientKey: "x".repeat(201) }, { ...x.input, clientKey: " " },
    { ...x.input, expectedGradingVersion: "0" }, { ...x.input, expectedGradingVersion: -1 },
    { ...x.input, expectedGradingVersion: 0.5 }, { ...x.input, workSource: { id: randomUUID() } }])
    typed(await http("POST", "", input), 400, "VALIDATION");
  for (const input of [{ ...consent(p), acceptPossibleDoubleCharge: "true" }, { ...consent(p), confirmationVersion: "double-charge-v0" },
    { ...consent(p), clientKey: x.input.clientKey }]) typed(await http("POST", "/confirm", input), 400, "VALIDATION");
  for (const suffix of [query(x.input) + "&requestId=null", query(x.input) + "&unexpected=1", `?observationId=${x.original.id}&clientKey=${"x".repeat(201)}`])
    typed(await http("GET", suffix), 400, "VALIDATION");
  expect(await audit("N6-after")).toEqual(before);
});
