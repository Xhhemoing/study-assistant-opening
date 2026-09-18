import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCardRepository,
  createCourseMembershipRepository,
  createIdentityRepository,
  createLearningEventRepository,
  createSqlClient,
  type CardRepository,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LearningEventRepository,
} from "@aistudy/database";
import { defaultGoalAbilities, type GoalKind } from "@aistudy/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for card multi-goal state tests");
}

describe("card multi-goal personal SRS state", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let courses: CourseMembershipRepository;
  let cards: CardRepository;
  let events: LearningEventRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let otherWorkspaceId: string;
  let courseA: string;
  let courseB: string;
  let cardId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    identity = createIdentityRepository(sql);
    courses = createCourseMembershipRepository(sql);
    cards = createCardRepository(sql);
    events = createLearningEventRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      learning_events,
      card_review_states,
      cards,
      goal_time_windows,
      course_goals,
      course_asset_memberships,
      courses,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    const owner = await identity.createUserWithWorkspace({
      email: `card-a-${randomUUID()}@example.com`,
      displayName: "Card owner",
      passwordHash: "scrypt$not-used",
    });
    const other = await identity.createUserWithWorkspace({
      email: `card-b-${randomUUID()}@example.com`,
      displayName: "Other",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    otherWorkspaceId = other.workspace.id;
    courseA = (await courses.createCourse({ workspaceId, title: "A", slug: "course-a" })).id;
    courseB = (await courses.createCourse({ workspaceId, title: "B", slug: "course-b" })).id;

    const card = await cards.createCard({
      workspaceId,
      ownerUserId,
      front: "导数",
      back: "极限定义",
      tags: ["高数"],
    });
    cardId = card.id;

    await courses.addAssetMembership({
      workspaceId,
      courseId: courseA,
      assetType: "card",
      assetId: cardId,
      role: "core",
      visibility: "course",
    });
    await courses.addAssetMembership({
      workspaceId,
      courseId: courseB,
      assetType: "card",
      assetId: cardId,
      role: "optional",
      visibility: "course",
    });

    await insertGoal(courseA, "final-exam", 2, "2026-12-01");
    await insertGoal(courseA, "interest", 1, null);
    await insertGoal(courseB, "maintenance", 4, "2026-10-01");
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function insertGoal(
    courseId: string,
    kind: GoalKind,
    priority: number,
    examDate: string | null,
  ): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO course_goals (
        workspace_id, course_id, kind, title, priority, intensity,
        abilities, strategy_version, active, exam_date
      )
      VALUES (
        ${workspaceId}, ${courseId}, ${kind}, ${kind}, ${priority}, 0.5,
        ${sql.json(defaultGoalAbilities(kind))}, 'goal-1', true, ${examDate}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it("keeps one card and one personal state across two courses and three goals", async () => {
    const cardRows = await sql`SELECT count(*)::int AS count FROM cards`;
    expect(cardRows[0]?.count).toBe(1);

    const initial = await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 0,
        dueAt: "2026-08-15T00:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    const again = await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: { ...initial, dueAt: "2026-08-15T01:00:00.000Z", updatedAt: "2026-08-15T01:00:00.000Z" },
    });
    const stateRows = await sql`
      SELECT count(*)::int AS count FROM card_review_states
      WHERE owner_user_id = ${ownerUserId} AND card_id = ${cardId}
    `;
    expect(stateRows[0]?.count).toBe(1);
    expect(again.reps).toBe(0);

    const first = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "review-key-01",
      occurredAt: "2026-08-15T02:00:00.000Z",
      now: new Date("2026-08-15T02:00:00.000Z"),
    });
    const second = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "hard",
      idempotencyKey: "review-key-02",
      occurredAt: "2026-08-15T03:00:00.000Z",
      now: new Date("2026-08-15T03:00:00.000Z"),
    });
    expect(first.state.reps).toBe(1);
    expect(second.state.reps).toBe(2);
    expect(second.state.lastGrade).toBe("hard");

    const retried = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "easy",
      idempotencyKey: "review-key-02",
      occurredAt: "2026-08-15T04:00:00.000Z",
      now: new Date("2026-08-15T04:00:00.000Z"),
    });
    expect(retried.state).toEqual(second.state);
    expect(retried.event).toEqual(second.event);
    const eventCount = await sql`SELECT count(*)::int AS count FROM learning_events WHERE type = 'review'`;
    expect(eventCount[0]?.count).toBe(2);

    const beforeGoals = await cards.getState({ workspaceId, ownerUserId, cardId });
    await sql`UPDATE course_goals SET priority = 99, exam_date = '2027-01-15' WHERE course_id = ${courseB}`;
    const afterGoals = await cards.getState({ workspaceId, ownerUserId, cardId });
    expect(afterGoals).toEqual(beforeGoals);
  });

  it("scopes reads and grades to the workspace", async () => {
    await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 0,
        dueAt: "2026-08-15T00:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    await expect(cards.getCard({ workspaceId: otherWorkspaceId, cardId })).rejects.toThrow();
    await expect(
      cards.grade({
        workspaceId: otherWorkspaceId,
        ownerUserId,
        cardId,
        grade: "good",
        idempotencyKey: "foreign-key-01",
        occurredAt: "2026-08-15T02:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("honors auto/self-selected/free with pause archive exclude and maintain-until", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 1,
        dueAt: "2026-08-14T12:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    });

    let queue = await cards.listQueue({
      workspaceId,
      ownerUserId,
      mode: "auto",
      now,
      today: "2026-08-15",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.goalPriority).toBe(4);

    await cards.updateControls({
      workspaceId,
      cardId,
      pausedUntil: "2026-08-20T00:00:00.000Z",
    });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(await cards.listQueue({ workspaceId, ownerUserId, mode, now, today: "2026-08-15" })).toHaveLength(0);
    }

    await cards.updateControls({ workspaceId, cardId, pausedUntil: null, archived: true });
    expect(await cards.listQueue({ workspaceId, ownerUserId, mode: "free", now, today: "2026-08-15" })).toHaveLength(0);

    await cards.updateControls({
      workspaceId,
      cardId,
      archived: false,
      maintainUntil: "2026-08-14",
      excludeFromAssessment: true,
    });
    expect(await cards.listQueue({ workspaceId, ownerUserId, mode: "auto", now, today: "2026-08-15" })).toHaveLength(0);
    queue = await cards.listQueue({
      workspaceId,
      ownerUserId,
      mode: "self-selected",
      now,
      today: "2026-08-15",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.card.excludeFromAssessment).toBe(true);

    const graded = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "review-exclude-01",
      occurredAt: "2026-08-15T13:00:00.000Z",
      now: new Date("2026-08-15T13:00:00.000Z"),
    });
    expect(graded.event.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
    expect(graded.event.contentVersion).toBe(1);
    const stored = await events.get({ workspaceId, eventId: graded.event.id });
    expect(stored.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
  });

  it("rejects an idempotency key already used by another event type or card", async () => {
    const second = await cards.createCard({
      workspaceId,
      ownerUserId,
      front: "积分",
      back: "反导数",
      tags: ["高数"],
    });

    await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "collision-key-01",
      occurredAt: "2026-08-15T05:00:00.000Z",
      contentId: cardId,
      contentVersion: 1,
      syllabusPointId: randomUUID(),
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 1000,
        hintCount: 0,
        confidence: 3,
        errorCause: null,
        abilitySlice: "procedure",
      },
    });

    await expect(
      cards.grade({
        workspaceId,
        ownerUserId,
        cardId,
        grade: "good",
        idempotencyKey: "collision-key-01",
        occurredAt: "2026-08-15T06:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "shared-review-01",
      occurredAt: "2026-08-15T07:00:00.000Z",
    });
    await expect(
      cards.grade({
        workspaceId,
        ownerUserId,
        cardId: second.id,
        grade: "good",
        idempotencyKey: "shared-review-01",
        occurredAt: "2026-08-15T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const secondState = await cards.getState({
      workspaceId,
      ownerUserId,
      cardId: second.id,
    });
    expect(secondState).toMatchObject({ cardId: second.id });
  });
});
