import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createLearningEventRepository, createSqlClient } from "@aistudy/database";
import { GET as getAssessment } from "../../../apps/web/src/app/api/assessment/route";
import { POST as appendCorrection } from "../../../apps/web/src/app/api/assessment/corrections/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for assessment handler tests");
}

const cookieName = "aistudy_session";

function request(path: string, method: string, cookie?: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("assessment handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "assessment-handler-secret-at-least-32",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_events, sessions, workspaces, users RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime?.close();
    await sql.end({ timeout: 5 });
  });

  async function signedIn(label: string) {
    const response = await register(
      request("/api/auth/register", "POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    );
    const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
    const body = (await response.json()) as { user: { id: string; workspaceId: string } };
    return {
      cookie: `${cookieName}=${token}`,
      workspaceId: body.user.workspaceId,
      ownerUserId: body.user.id,
    };
  }

  async function seedAttempt(user: { workspaceId: string; ownerUserId: string }) {
    const syllabusPointId = randomUUID();
    const event = await createLearningEventRepository(sql).append({
      workspaceId: user.workspaceId,
      ownerUserId: user.ownerUserId,
      type: "attempt",
      idempotencyKey: `assess-handler-${randomUUID()}`,
      occurredAt: "2026-08-14T10:00:00.000Z",
      contentId: randomUUID(),
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 4,
        errorCause: null,
        abilitySlice: "recall",
      },
    });
    return { event, syllabusPointId };
  }

  it("requires authentication and rejects a malformed correction", async () => {
    expect((await getAssessment(request("/api/assessment", "GET"))).status).toBe(401);
    expect(
      (await appendCorrection(request("/api/assessment/corrections", "POST", undefined, {}))).status,
    ).toBe(401);
    const { cookie } = await signedIn("invalid");
    expect((await getAssessment(request("/api/assessment?syllabusPointId=not-a-uuid", "GET", cookie))).status).toBe(400);
    expect(
      (
        await appendCorrection(
          request("/api/assessment/corrections", "POST", cookie, {
            correctsEventId: "short",
            kind: "status",
            note: "x",
            idempotencyKey: "short",
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("returns own-workspace status, hides foreign targets, and replays corrections", async () => {
    const owner = await signedIn("owner");
    const other = await signedIn("other");
    const seeded = await seedAttempt(owner);
    const listed = await getAssessment(
      request(`/api/assessment?syllabusPointId=${seeded.syllabusPointId}`, "GET", owner.cookie),
    );
    const listedBody = (await listed.json()) as { statuses: Array<{ syllabusPointId: string }> };
    expect(listed.status).toBe(200);
    expect(listedBody.statuses).toHaveLength(1);
    expect(listedBody.statuses[0]?.syllabusPointId).toBe(seeded.syllabusPointId);

    const hidden = await appendCorrection(
      request("/api/assessment/corrections", "POST", other.cookie, {
        correctsEventId: seeded.event.id,
        kind: "status",
        note: "应为稳固",
        overrideStatus: "stable",
        idempotencyKey: "correction-hidden-01",
      }),
    );
    expect(hidden.status).toBe(404);

    const body = {
      correctsEventId: seeded.event.id,
      kind: "status" as const,
      note: "应为稳固",
      overrideStatus: "stable" as const,
      idempotencyKey: "correction-owner-01",
    };
    const first = await appendCorrection(request("/api/assessment/corrections", "POST", owner.cookie, body));
    const retried = await appendCorrection(request("/api/assessment/corrections", "POST", owner.cookie, body));
    const firstBody = (await first.json()) as { event: { id: string }; status: { status: string } };
    const retriedBody = (await retried.json()) as { event: { id: string } };
    expect(first.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retriedBody.event.id).toBe(firstBody.event.id);
    expect(firstBody.status.status).toBe("stable");
  });
});
