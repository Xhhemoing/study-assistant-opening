import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningLearningRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as directObservation } from "../../../apps/web/src/app/api/opening/observations/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => { await f.reset(); await f.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
const req = (body: unknown, cookie = f.cookie) => new Request("http://localhost/api/opening/attempts", {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function input() {
  const base = await learningAttemptFixture(f);
  const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, {
    courseId: base.courseId, sourceIds: [base.sourceId], skillLabel: "矩阵标量乘法",
  });
  return { base, body: { sessionId: session.id, clientKey: randomUUID(), matrixExercise: { sourceId: base.sourceId, exerciseKey: "scalar", variant: 0 } } };
}
it("uses real authenticated create/submit handlers and rejects forged verdicts before writing", async () => {
  const { body } = await input();
  expect((await createAttempt(req(body, ""))).status).toBe(401);
  expect((await createAttempt(req({ ...body, matrixExercise: { ...body.matrixExercise, matrixA: [[1]] } }))).status).toBe(400);
  const started = await createAttempt(req(body)); expect(started.status).toBe(201);
  const attempt = await started.json();
  const answer = { clientKey: randomUUID(), answer: '[["1/2",-1],["3/2",0]]', outcome: "incorrect", assistance: "independent" };
  expect((await submitAttempt(req({ ...answer, verdictSource: "deterministic" }), params(attempt.id))).status).toBe(400);
  expect((await submitAttempt(req({ ...answer, serverEvaluation: { outcome: "correct" } }), params(attempt.id))).status).toBe(400);
  const submitted = await submitAttempt(req(answer), params(attempt.id)); expect(submitted.status).toBe(201);
  const observation = await submitted.json();
  expect(observation).toMatchObject({ outcome: "correct", verdictSource: "deterministic", eligibility: { verifiedCorrect: "yes" }, serverEvaluation: { decision: "correct", observationId: observation.id } });
  expect(await (await submitAttempt(req(answer), params(attempt.id))).json()).toMatchObject({ id: observation.id });
  expect((await submitAttempt(req({ ...answer, answer: "[[0]]" }), params(attempt.id))).status).toBe(409);
});
it("rejects a fake automatic observation and keeps the ordinary unstructured path usable", async () => {
  const { base } = await input();
  const ordinary = { sessionId: base.sessionId, courseId: base.courseId, skillLabel: "fractions", sourceIds: [base.sourceId],
    answer: "1", outcome: "correct", assistance: "independent", clientKey: randomUUID() };
  expect((await directObservation(req({ ...ordinary, verdictSource: "deterministic" }))).status).toBe(400);
  expect((await directObservation(req({ ...ordinary, serverEvaluation: {} }))).status).toBe(400);
  const response = await directObservation(req(ordinary)); expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ outcome: "correct", verdictSource: "self_report", eligibility: { verifiedCorrect: "unknown" } });
});
