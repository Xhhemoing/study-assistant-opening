import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCourseMembershipRepository,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LibraryRepository,
} from "@aistudy/database";
import {
  computeEffectiveRequirements,
  defaultGoalAbilities,
  getRequirementProfile,
  type GoalKind,
  type GoalRequirement,
  type TimeWindow,
} from "@aistudy/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for multi-goal course tests");
}

const GOAL_KINDS: GoalKind[] = [
  "final-exam",
  "entrance-exam",
  "interest",
  "maintenance",
];

function weightsSum(abilities: GoalRequirement["abilities"]): number {
  return (
    abilities.recognition +
    abilities.recall +
    abilities.procedural +
    abilities.transfer +
    abilities.expression +
    abilities.timed
  );
}

describe("multi-goal course with time windows", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let courses: CourseMembershipRepository;
  let library: LibraryRepository;
  let workspaceId: string;
  let courseId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    identity = createIdentityRepository(sql);
    courses = createCourseMembershipRepository(sql);
    library = createLibraryRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      goal_time_windows,
      course_goals,
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    const userA = await identity.createUserWithWorkspace({
      email: `goal-a-${randomUUID()}@example.com`,
      displayName: "Goal A",
      passwordHash: "scrypt$not-used",
    });
    const userB = await identity.createUserWithWorkspace({
      email: `goal-b-${randomUUID()}@example.com`,
      displayName: "Goal B",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = userA.workspace.id;
    otherWorkspaceId = userB.workspace.id;

    const course = await courses.createCourse({
      workspaceId,
      title: "Mathematics 2026",
      slug: "math-2026",
    });
    courseId = course.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function insertGoal(
    kind: GoalKind,
    overrides: Partial<{ priority: number; intensity: number; active: boolean }> = {},
  ): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO course_goals (
        workspace_id, course_id, kind, title, priority, intensity,
        abilities, strategy_version, active
      )
      VALUES (
        ${workspaceId}, ${courseId}, ${kind}, ${kind}, ${overrides.priority ?? 0},
        ${overrides.intensity ?? 0.5}, ${sql.json(defaultGoalAbilities(kind))}, 'goal-1',
        ${overrides.active ?? true}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it("persists four goal kinds on one course and enforces kind uniqueness", async () => {
    for (const kind of GOAL_KINDS) {
      await insertGoal(kind);
    }
    const rows = await sql`
      SELECT kind, active, intensity
      FROM course_goals
      WHERE course_id = ${courseId}
      ORDER BY priority, kind
    `;
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.kind)).toEqual(GOAL_KINDS);

    await expect(insertGoal("final-exam")).rejects.toThrow();
  });

  it("rejects cross-workspace goal/course links", async () => {
    await expect(
      sql`
        INSERT INTO course_goals (workspace_id, course_id, kind, title, abilities, strategy_version)
        VALUES (${otherWorkspaceId}, ${courseId}, 'final-exam', 'foreign', ${sql.json(defaultGoalAbilities("final-exam"))}, 'goal-1')
      `,
    ).rejects.toThrow();
  });

  it("merges persisted goals deterministically with a time-window modifier and user override", async () => {
    await insertGoal("final-exam", { priority: 2, intensity: 0.5 });
    await insertGoal("entrance-exam", { priority: 3, intensity: 0.6 });
    await insertGoal("interest", { priority: 1, intensity: 0.3 });
    await insertGoal("maintenance", { priority: 0, intensity: 0.2 });

    const goalRows = await sql<{
      id: string;
      kind: GoalKind;
      priority: number;
      intensity: number;
      active: boolean;
      abilities: GoalRequirement["abilities"];
      strategy_version: string;
    }[]>`
      SELECT id, kind, priority, intensity, active, abilities, strategy_version
      FROM course_goals
      WHERE course_id = ${courseId}
    `;
    const goals: GoalRequirement[] = goalRows.map((row) => ({
      goalId: row.id,
      kind: row.kind,
      abilities: row.abilities,
      priority: row.priority,
      intensity: row.intensity,
      active: row.active,
      strategyVersion: row.strategy_version,
    }));

    const entrance = goalRows.find((row) => row.kind === "entrance-exam")!;
    await sql`
      INSERT INTO goal_time_windows (
        workspace_id, goal_id, phase, starts_at, ends_at, modifier
      )
      VALUES (
        ${workspaceId}, ${entrance.id}, 'rehearsal',
        '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
        ${sql.json({ timed: 30 })}
      )
    `;

    const baseline = getRequirementProfile("mathematical-procedural", "basic");
    const now = new Date("2026-08-13T08:00:00.000Z");
    const first = computeEffectiveRequirements({
      baseline,
      goals,
      timeWindows: [
        {
          goalId: entrance.id,
          phase: "rehearsal",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-09-01T00:00:00.000Z",
          modifier: { timed: 30 },
        } satisfies TimeWindow,
      ],
      now,
      userOverride: { abilities: { recall: 60 } },
    });
    const second = computeEffectiveRequirements({
      baseline,
      goals,
      timeWindows: [
        {
          goalId: entrance.id,
          phase: "rehearsal",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-09-01T00:00:00.000Z",
          modifier: { timed: 30 },
        } satisfies TimeWindow,
      ],
      now,
      userOverride: { abilities: { recall: 60 } },
    });

    expect(first).toEqual(second);
    expect(weightsSum(first.abilities)).toBe(100);
    expect(first.abilities.timed).toBeGreaterThan(baseline.abilities.timed);
    expect(first.abilities.recall).toBeGreaterThan(baseline.abilities.recall);
    expect(first.sources).toContain("window:rehearsal");
    expect(first.sources).toContain("override:abilities");
  });

  it("shares one asset identity across goals without duplicating history", async () => {
    const document = await library.createDocument({
      workspaceId,
      title: "Linear algebra note",
      blocks: [
        { id: randomUUID(), type: "paragraph", content: { text: "shared" } },
      ],
    });
    await courses.addAssetMembership({
      workspaceId,
      courseId,
      assetType: "document",
      assetId: document.id,
      role: "core",
      sortOrder: 0,
      visibility: "course",
    });

    await insertGoal("final-exam");
    await insertGoal("maintenance");

    const count = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM library_documents
      WHERE id = ${document.id}
    `;
    expect(count[0]?.n).toBe(1);

    const memberships = await courses.listCourseAssets({
      workspaceId,
      courseId,
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.assetId).toBe(document.id);
  });

  it("enforces time-window ordering and phase values", async () => {
    const goalId = await insertGoal("entrance-exam");
    await expect(
      sql`
        INSERT INTO goal_time_windows (
          workspace_id, goal_id, phase, starts_at, ends_at, modifier
        )
        VALUES (
          ${workspaceId}, ${goalId}, 'rehearsal',
          '2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
          ${sql.json({ timed: 10 })}
        )
      `,
    ).rejects.toThrow();

    await expect(
      sql`
        INSERT INTO goal_time_windows (
          workspace_id, goal_id, phase, starts_at, ends_at, modifier
        )
        VALUES (
          ${workspaceId}, ${goalId}, 'invalid-phase',
          '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
          ${sql.json({ timed: 10 })}
        )
      `,
    ).rejects.toThrow();
  });
});
