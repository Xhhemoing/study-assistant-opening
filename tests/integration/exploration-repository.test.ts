import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createExplorationRepository,
  createSqlClient,
  type ExplorationRepository,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for exploration repository tests");

const ownerA = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();

describe("exploration repository", () => {
  const sql = createSqlClient(databaseUrl);
  let repository: ExplorationRepository;

  beforeAll(async () => {
    await applyMigrations(sql);
    repository = createExplorationRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE exploration_blocks, exploration_branches, explorations, course_asset_memberships, courses, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${ownerA}, ${`owner-${randomUUID()}@example.com`}, 'Owner A', 'test')`;
    await sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceA}, ${ownerA}), (${workspaceB}, ${ownerA})`;
  });

  afterAll(async () => sql.end({ timeout: 5 }));

  it("creates a goal-free exploration with one stable root branch", async () => {
    const created = await repository.createExploration({
      workspaceId: workspaceA,
      ownerUserId: ownerA,
      title: "Understand queues",
    });
    const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId: created.id });

    expect(created.courseId).toBeNull();
    expect(created.goalId).toBeNull();
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]).toMatchObject({ explorationId: created.id, parentBranchId: null });
  });

  it("persists all block kinds and creates branches without copying parent blocks", async () => {
    const exploration = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Branch test" });
    const root = exploration.rootBranch;
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "scratch", content: "scratch", position: 0 });
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "hypothesis", content: "hypothesis", position: 1 });
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "open_question", content: "question", position: 2 });
    const branch = await repository.createBranch({ workspaceId: workspaceA, explorationId: exploration.id, parentBranchId: root.id, title: "Alternative" });
    const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId: exploration.id });

    expect(branch.parentBranchId).toBe(root.id);
    expect(detail.branches).toHaveLength(2);
    expect(detail.blocks).toHaveLength(3);
    expect(detail.blocks.every((block) => block.branchId === root.id)).toBe(true);
  });

  it("supports close and resume while rejecting invalid content and cross-workspace access", async () => {
    const exploration = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Lifecycle" });
    await expect(repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: exploration.rootBranch.id, kind: "scratch", content: " ", position: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    const closed = await repository.setStatus({ workspaceId: workspaceA, explorationId: exploration.id, status: "closed" });
    expect(closed.status).toBe("closed");
    await expect(repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: exploration.rootBranch.id, kind: "scratch", content: "blocked while closed" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(repository.createBranch({ workspaceId: workspaceA, explorationId: exploration.id, parentBranchId: exploration.rootBranch.id, title: "Blocked" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const resumed = await repository.setStatus({ workspaceId: workspaceA, explorationId: exploration.id, status: "open" });
    expect(resumed.status).toBe("open");
    await expect(repository.listExplorations({ workspaceId: workspaceB })).resolves.toEqual([]);
    await expect(repository.getExploration({ workspaceId: workspaceB, explorationId: exploration.id })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(repository.createBranch({ workspaceId: workspaceB, explorationId: exploration.id, title: "Denied" })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(repository.setStatus({ workspaceId: workspaceB, explorationId: exploration.id, status: "closed" })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });
});
