import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import type { Sql } from "postgres";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/attempts/route";
import { POST as startPractice } from "../../../apps/web/src/app/api/practice/[id]/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for attempt handler tests");
}

const cookieName = "aistudy_session";
const attackerPoint = "77777777-7777-4777-8777-777777777777";

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

describe("attempt handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "attempt-handler-secret-at-least-32-chars",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      practice_sessions, practice_item_versions, practice_items, syllabus_nodes, content_packages,
      learning_events, sessions, workspaces, users
      RESTART IDENTITY CASCADE`;
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

  it("requires authentication and rejects forged authority fields", async () => {
    const sessionId = randomUUID();
    const body = {
      practiceSessionId: sessionId,
      answer: "wrong",
      confidence: 5,
      errorCause: null,
      idempotencyKey: "attempt-0001",
    };
    expect((await submitAttempt(request("/api/attempts", "POST", undefined, body))).status).toBe(401);
    const { cookie } = await signedIn("invalid");
    expect(
      (await submitAttempt(request("/api/attempts", "POST", cookie, { ...body, idempotencyKey: "short" }))).status,
    ).toBe(400);
    expect(
      (
        await submitAttempt(
          request("/api/attempts", "POST", cookie, {
            ...body,
            correct: true,
            syllabusPointId: attackerPoint,
            abilitySlice: "transfer",
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("stores the item version syllabus point and ability slice, not attacker values", async () => {
    const { cookie, workspaceId } = await signedIn("persist");
    const seeded = await seedPracticeItem(sql, workspaceId);
    const started = await startPractice(
      request(`/api/practice/${seeded.itemId}`, "POST", cookie),
      { params: Promise.resolve({ id: seeded.itemId }) },
    );
    expect(started.status).toBe(201);
    const startBody = (await started.json()) as { sessionId: string; item: { answerRule?: unknown } };
    expect(startBody.item.answerRule).toBeUndefined();

    const first = await submitAttempt(
      request("/api/attempts", "POST", cookie, {
        practiceSessionId: startBody.sessionId,
        answer: "极限",
        confidence: 2,
        errorCause: null,
        idempotencyKey: "attempt-handler-001",
        correct: false,
        syllabusPointId: attackerPoint,
        abilitySlice: "transfer",
      }),
    );
    expect(first.status).toBe(400);

    const accepted = await submitAttempt(
      request("/api/attempts", "POST", cookie, {
        practiceSessionId: startBody.sessionId,
        answer: "极限",
        confidence: 2,
        errorCause: null,
        idempotencyKey: "attempt-handler-001",
      }),
    );
    const retried = await submitAttempt(
      request("/api/attempts", "POST", cookie, {
        practiceSessionId: startBody.sessionId,
        answer: "错",
        confidence: 5,
        errorCause: null,
        idempotencyKey: "attempt-handler-001",
      }),
    );
    const firstBody = (await accepted.json()) as {
      event: { syllabusPointId: string; abilitySlice: string; correct: boolean; contentVersion: number };
      status: { syllabusPointId: string; evidenceSnapshotId: string };
    };
    const retriedBody = await retried.json();
    const rows = await sql`SELECT count(*)::int AS count FROM learning_events`;

    expect(accepted.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retriedBody.event).toEqual(firstBody.event);
    expect(firstBody.event.syllabusPointId).toBe(seeded.pointId);
    expect(firstBody.event.abilitySlice).toBe("recall");
    expect(firstBody.event.correct).toBe(true);
    expect(firstBody.event.contentVersion).toBe(2);
    expect(firstBody.status.syllabusPointId).toBe(seeded.pointId);
    expect(firstBody.status.evidenceSnapshotId).toMatch(/^snap-/);
    expect(rows[0]?.count).toBe(1);
  });
});

async function seedPracticeItem(sql: Sql, workspaceId: string) {
  const packageId = randomUUID();
  const pointId = randomUUID();
  const itemId = randomUUID();
  await sql`
    INSERT INTO content_packages (id, workspace_id, title, version, status)
    VALUES (${packageId}, ${workspaceId}, ${"试点"}, 1, ${"active"})
  `;
  await sql`
    INSERT INTO syllabus_nodes (id, workspace_id, package_id, parent_id, code, title, sort_order)
    VALUES (${pointId}, ${workspaceId}, ${packageId}, null, ${"D1"}, ${"导数"}, 1)
  `;
  await sql`
    INSERT INTO practice_items (id, workspace_id, package_id, current_version)
    VALUES (${itemId}, ${workspaceId}, ${packageId}, 2)
  `;
  await sql`
    INSERT INTO practice_item_versions (
      practice_item_id, version, workspace_id, syllabus_point_id, kind, stem, options,
      answer_rule, answer_display, hints, ability_slice, estimated_minutes, source, review_status
    ) VALUES (
      ${itemId}, 2, ${workspaceId}, ${pointId}, ${"short_answer"}, ${"题干"}, null,
      ${sql.json({ type: "exact", accepted: ["极限"] })}, ${"极限"}, ${sql.json(["提示"])},
      ${"recall"}, 5, ${sql.json({})}, ${"reviewed"}
    )
  `;
  return { itemId, pointId };
}
