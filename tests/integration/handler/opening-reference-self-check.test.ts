import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { hashSessionToken } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createSessionJwt } from "../../../apps/web/src/lib/session";
import { POST as reviseObservation } from "../../../apps/web/src/app/api/opening/observations/revisions/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { GET as getAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";

let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>, otherCookie = "";

beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600,
  });
  setAuthRuntimeForTests(runtime);
  const secret = process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret";
  const sessionId = randomUUID();
  const token = await createSessionJwt({
    sub: fixture.otherScope.ownerUserId, workspaceId: fixture.otherScope.workspaceId, sid: sessionId,
  }, secret, 3600);
  await fixture.sql`INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (${sessionId}, ${fixture.otherScope.ownerUserId}, ${hashSessionToken(token)}, now() + interval '1 hour')`;
  otherCookie = `aistudy_session=${token}`;
});
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });

const reviseReq = (body: unknown, cookie = fixture.cookie) => new Request("http://localhost/api/opening/observations/revisions", {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const submitReq = (body: unknown, cookie = fixture.cookie) => new Request("http://localhost/api/opening/attempts/submit", {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const referenceCheck = (sourceId: string) => ({
  referenceSourceId: sourceId, method: "learner_self_compare 第3页", scope: "whole_answer" as const,
});

it("rejects referenceCheck that changes the answer and accepts same-answer self-compare", async () => {
  const f = await learningAttemptFixture(fixture);
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const mismatch = await reviseObservation(reviseReq({
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "对照参考核对", clientKey: randomUUID(),
    replacement: {
      answer: "different", outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: referenceCheck(f.sourceId),
    },
  }));
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({ error: { code: "VALIDATION", message: "reference check cannot change the answer" } });

  const ok = await reviseObservation(reviseReq({
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "对照参考核对", clientKey: randomUUID(),
    replacement: {
      answer: original.answer, outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: referenceCheck(f.sourceId),
    },
  }));
  expect(ok.status).toBe(201);
  const body = await ok.json();
  expect(body.observation).toMatchObject({
    answer: original.answer, verdictSource: "reference_checked",
    referenceCheck: expect.objectContaining({ method: "learner_self_compare 第3页", scope: "whole_answer" }),
  });
  expect(body.observation.eligibility.verifiedCorrect).toBe("yes");
});

it("rejects a reference source outside the session", async () => {
  const f = await learningAttemptFixture(fixture);
  const foreign = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, upload_state, parse_state)
    VALUES (${foreign}, ${fixture.scope.workspaceId}, 'foreign.pdf', 'application/pdf', 1, ${"b".repeat(64)}, 'uploaded', 'ready')`;
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const response = await reviseObservation(reviseReq({
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "对照参考核对", clientKey: randomUUID(),
    replacement: {
      answer: original.answer, outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: foreign,
      referenceCheck: { referenceSourceId: foreign, method: "learner_self_compare", scope: "whole_answer" },
    },
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "VALIDATION" } });
});

it("does not let another owner revise", async () => {
  const f = await learningAttemptFixture(fixture);
  const original = await f.submit(await f.start(), { outcome: "unverified" });
  const response = await reviseObservation(reviseReq({
    rootObservationId: original.id, revisesObservationId: original.id, expectedHead: original.id,
    revisionKind: "replace", reason: "对照参考核对", clientKey: randomUUID(),
    replacement: {
      answer: original.answer, outcome: "correct", assistance: "independent",
      verdictSource: "reference_checked", referenceSourceId: f.sourceId,
      referenceCheck: referenceCheck(f.sourceId),
    },
  }, otherCookie));
  expect(response.status).toBe(404);
});

it("floors submit assistance to delivered hinted exposure and reports deliveredAssistance", async () => {
  const f = await learningAttemptFixture(fixture);
  const attempt = await f.start();
  await f.help(attempt, "hinted");
  const get = await getAttempt(new Request("http://localhost/api/opening/attempts/" + attempt.id, {
    headers: { cookie: fixture.cookie },
  }), params(attempt.id));
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({
    attemptId: attempt.id, sessionId: f.sessionId, deliveredAssistance: "hinted",
  });
  const submitted = await submitAttempt(submitReq({
    clientKey: randomUUID(), answer: "1", outcome: "correct", assistance: "independent",
  }), params(attempt.id));
  expect(submitted.status).toBe(201);
  expect(await submitted.json()).toMatchObject({ assistance: "hinted" });
});
