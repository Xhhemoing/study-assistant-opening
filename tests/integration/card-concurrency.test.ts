import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCardRepository,
  createIdentityRepository,
  createSqlClient,
  type CardRepository,
  type IdentityRepository,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for card concurrency tests");
}

describe("card concurrent grading", () => {
  const sqlA = createSqlClient(databaseUrl);
  const sqlB = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let cardsA: CardRepository;
  let cardsB: CardRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let cardId: string;

  beforeAll(async () => {
    await applyMigrations(sqlA);
    identity = createIdentityRepository(sqlA);
    cardsA = createCardRepository(sqlA);
    cardsB = createCardRepository(sqlB);
  });

  beforeEach(async () => {
    await sqlA`TRUNCATE learning_events, card_review_states, cards, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    const owner = await identity.createUserWithWorkspace({
      email: `card-conc-${randomUUID()}@example.com`,
      displayName: "Card owner",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    cardId = (
      await cardsA.createCard({
        workspaceId,
        ownerUserId,
        front: "导数",
        back: "极限定义",
      })
    ).id;
  });

  afterAll(async () => {
    await sqlB.end({ timeout: 5 });
    await sqlA.end({ timeout: 5 });
  });

  function gradeInput(idempotencyKey: string, occurredAt: string) {
    return {
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good" as const,
      idempotencyKey,
      occurredAt,
      now: new Date(occurredAt),
    };
  }

  it("applies two different keys as two review events and two reps", async () => {
    const [first, second] = await Promise.all([
      cardsA.grade(gradeInput("card-conc-key-a", "2026-08-15T12:00:00.000Z")),
      cardsB.grade(gradeInput("card-conc-key-b", "2026-08-15T12:00:01.000Z")),
    ]);
    const rows = await sqlA`SELECT count(*)::int AS count FROM learning_events WHERE type = 'review'`;
    const state = await cardsA.getState({ workspaceId, ownerUserId, cardId });
    expect(first.created && second.created).toBe(true);
    expect(first.event.id).not.toBe(second.event.id);
    expect(rows[0]?.count).toBe(2);
    expect(state?.reps).toBe(2);
  });

  it("replays the same idempotency key as one event and one transition", async () => {
    const [first, second] = await Promise.all([
      cardsA.grade(gradeInput("card-conc-same", "2026-08-15T12:00:00.000Z")),
      cardsB.grade(gradeInput("card-conc-same", "2026-08-15T12:00:00.000Z")),
    ]);
    const rows = await sqlA`SELECT count(*)::int AS count FROM learning_events WHERE type = 'review'`;
    const state = await cardsA.getState({ workspaceId, ownerUserId, cardId });
    expect(first.event.id).toBe(second.event.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
    expect(state?.reps).toBe(1);
  });

  it("commits neither event nor state when append fails after the next state is calculated", async () => {
    await expect(
      cardsA.grade({
        ...gradeInput("card-conc-fail", "not-an-iso-datetime"),
        now: new Date("2026-08-15T12:00:00.000Z"),
      }),
    ).rejects.toThrow();
    const rows = await sqlA`SELECT count(*)::int AS count FROM learning_events`;
    const state = await cardsA.getState({ workspaceId, ownerUserId, cardId });
    expect(rows[0]?.count).toBe(0);
    expect(state?.reps).toBe(0);
    expect(state?.lastGrade).toBeNull();
  });
});
