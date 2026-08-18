import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createCard, PATCH as updateCard } from "../../../apps/web/src/app/api/cards/route";
import { GET as listReviews, POST as gradeReview } from "../../../apps/web/src/app/api/reviews/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for review handler tests");
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

describe("review handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "review-handler-secret-at-least-32-chars",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_events, card_review_states, cards, sessions, workspaces, users RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime?.close();
    await sql.end({ timeout: 5 });
  });

  async function user(label: string) {
    const response = await register(
      request("/api/auth/register", "POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    );
    const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
    return `${cookieName}=${token}`;
  }

  it("requires authentication and validates the review payload", async () => {
    expect((await gradeReview(request("/api/reviews", "POST", undefined, { cardId: randomUUID(), grade: "good", idempotencyKey: "review-key-01" }))).status).toBe(401);
    const cookie = await user("invalid");
    expect(
      (await gradeReview(request("/api/reviews", "POST", cookie, { cardId: randomUUID(), grade: "good", idempotencyKey: "short" }))).status,
    ).toBe(400);
    expect((await listReviews(request("/api/reviews?mode=manual", "GET", cookie))).status).toBe(400);
  });

  it("creates a card, grades it once, and replays the same idempotency key", async () => {
    const cookie = await user("persist");
    const created = await createCard(
      request("/api/cards", "POST", cookie, { front: "导数", back: "极限定义", tags: ["高数"] }),
    );
    const createdBody = await created.json() as { card: { id: string } };
    expect(created.status).toBe(201);
    const autoQueue = await listReviews(request("/api/reviews?mode=auto", "GET", cookie));
    expect(autoQueue.status).toBe(200);
    expect(((await autoQueue.json()) as { items: Array<{ card: { id: string } }> }).items.map((item) => item.card.id)).toEqual([
      createdBody.card.id,
    ]);

    const body = {
      cardId: createdBody.card.id,
      grade: "good",
      idempotencyKey: "review-handler-001",
      occurredAt: "2026-08-15T12:00:00.000Z",
    };
    const first = await gradeReview(request("/api/reviews", "POST", cookie, body));
    const retried = await gradeReview(request("/api/reviews", "POST", cookie, { ...body, grade: "easy" }));
    const firstBody = await first.json();
    const retriedBody = await retried.json();
    const eventCount = await sql`SELECT count(*)::int AS count FROM learning_events WHERE type = 'review'`;
    const stateCount = await sql`SELECT count(*)::int AS count FROM card_review_states`;

    expect(first.status).toBe(201);
    expect(retried.status).toBe(201);
    expect(retriedBody.event.id).toBe(firstBody.event.id);
    expect(retriedBody.state.reps).toBe(1);
    expect(firstBody.event.payload.excludeFromAssessment).toBe(false);
    expect(eventCount[0]?.count).toBe(1);
    expect(stateCount[0]?.count).toBe(1);

    const queue = await listReviews(request("/api/reviews?mode=free", "GET", cookie));
    const queueBody = await queue.json() as { items: Array<{ card: { id: string } }> };
    expect(queue.status).toBe(200);
    expect(queueBody.items.map((item) => item.card.id)).toEqual([createdBody.card.id]);
  });

  it("scopes grades to the session workspace", async () => {
    const owner = await user("owner");
    const stranger = await user("stranger");
    const created = await createCard(
      request("/api/cards", "POST", owner, { front: "积分", back: "反导数", tags: ["高数"] }),
    );
    const cardId = ((await created.json()) as { card: { id: string } }).card.id;
    const forbidden = await gradeReview(
      request("/api/reviews", "POST", stranger, {
        cardId,
        grade: "good",
        idempotencyKey: "review-foreign-001",
      }),
    );
    expect(forbidden.status).toBe(404);
    const strangerQueue = await listReviews(request("/api/reviews?mode=free", "GET", stranger));
    expect(((await strangerQueue.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("archives a card through PATCH and rejects control updates from another workspace", async () => {
    const owner = await user("controls");
    const stranger = await user("controls-stranger");
    const created = await createCard(
      request("/api/cards", "POST", owner, { front: "极限", back: "逼近", tags: ["高数"] }),
    );
    const cardId = ((await created.json()) as { card: { id: string } }).card.id;
    const archived = await updateCard(request("/api/cards", "PATCH", owner, { cardId, archived: true }));
    expect(archived.status).toBe(200);
    const queue = await listReviews(request("/api/reviews?mode=free", "GET", owner));
    expect(((await queue.json()) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await updateCard(request("/api/cards", "PATCH", stranger, { cardId, archived: false }))).status,
    ).toBe(404);
  });

  it("rejects an idempotency key already used by another card", async () => {
    const cookie = await user("collision");
    const first = await createCard(
      request("/api/cards", "POST", cookie, { front: "一", back: "A", tags: ["高数"] }),
    );
    const second = await createCard(
      request("/api/cards", "POST", cookie, { front: "二", back: "B", tags: ["高数"] }),
    );
    const firstId = ((await first.json()) as { card: { id: string } }).card.id;
    const secondId = ((await second.json()) as { card: { id: string } }).card.id;
    expect(
      (
        await gradeReview(
          request("/api/reviews", "POST", cookie, {
            cardId: firstId,
            grade: "good",
            idempotencyKey: "review-shared-key-01",
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await gradeReview(
          request("/api/reviews", "POST", cookie, {
            cardId: secondId,
            grade: "good",
            idempotencyKey: "review-shared-key-01",
          }),
        )
      ).status,
    ).toBe(409);
  });
});
