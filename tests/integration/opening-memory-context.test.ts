import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningMemoryRepository } from "@aistudy/database";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { insertMemory, insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";
import { lockAndReadMemoryOrigins, lockOwnedWorkspace } from "../../packages/database/src/repositories/opening-memory-admission";

let fixture: OpeningFixture;
let memories: ReturnType<typeof createOpeningMemoryRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  memories = createOpeningMemoryRepository(fixture.sql);
});

beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_memories, opening_privacy_exclusions, opening_turns, opening_conversations RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await fixture?.close();
});

describe("opening memory context admission", () => {
  it("loads a confirmed memory whose owned user turn has no sources", async () => {
    const turnId = await insertOwnedTurn(fixture.sql, fixture.scope);
    const id = await insertMemory(fixture.sql, fixture.scope, "source-less fact", [turnId]);
    const loaded = await memories.listForContext(fixture.scope, null);
    expect(loaded.map((item) => item.id)).toEqual([id]);
  });

  it("projects locked material from a named memory ancestor of a legacy source-free turn", async () => {
    const { sql, scope } = fixture;
    const sourceId = await insertSource(sql, scope, "uploaded", 3);
    const original = await insertOwnedTurn(sql, scope);
    const activity = await insertTestTeachingActivity(sql, scope);
    const session = randomUUID();
    await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, activity_id, skill_label, source_ids)
      VALUES (${session}, ${scope.workspaceId}, ${scope.ownerUserId}, ${activity}, 'Memory origin', ${[sourceId]}::uuid[])`;
    await sql`UPDATE opening_turns SET learning_session_id=${session} WHERE id=${original}`;
    const ancestorId = await insertMemory(sql, scope, "Session memory", [original]);
    const legacy = await insertOwnedTurn(sql, scope, {
      role: "assistant", contextSourceRefs: [{ memoryDependencyIds: [ancestorId] }],
    });
    const derivedId = await insertMemory(sql, scope, "Derived memory", [legacy]);

    await sql.begin(async tx => {
      await lockOwnedWorkspace(tx, scope);
      const origins = await lockAndReadMemoryOrigins(tx, scope,
        [{ id: derivedId, excludedId: derivedId, course_id: null, turn_ids: [legacy] }],
        { materialUse: "citation", includeSourceRefs: true });
      expect(origins.get(derivedId)).toMatchObject({
        ids: new Set([ancestorId]), sourceRefs: [{ sourceId, sourceVersion: 3 }],
      });
    });
  });

  it("selects memory text and provenance at the same eligibility instant", async () => {
    const sourceId = await insertSource(fixture.sql, fixture.scope);
    const sourceTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [sourceId] });
    const temporary = await insertMemory(fixture.sql, fixture.scope, "temporary", [sourceTurn]);
    await fixture.sql`UPDATE opening_memories SET kind='temporary', expires_at='2026-10-01T00:00:00Z' WHERE id=${temporary}`;
    const before = await memories.listContext(fixture.scope, "2026-09-30T23:59:59Z");
    expect(before.memories.map((item) => item.id)).toEqual([temporary]);
    expect(before.sourceRefs).toEqual([{ sourceId, sourceVersion: 0 }]);
    expect(await memories.listContext(fixture.scope, "2026-10-01T00:00:00Z")).toEqual({ memories: [], sourceRefs: [] });
    await fixture.sql`UPDATE opening_memories SET kind='candidate', expires_at=NULL WHERE id=${temporary}`;
    expect(await memories.listContext(fixture.scope, "2026-09-30T23:59:59Z")).toEqual({ memories: [], sourceRefs: [] });
  });

  it("filters archived and foreign course memories while keeping global context", async () => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory context A", slug: "memory-context-a" });
    const foreign = await courses.createCourse({ workspaceId: fixture.otherScope.workspaceId, title: "Foreign memory context", slug: "memory-context-foreign" });
    const origin = await insertOwnedTurn(sql, scope);
    const global = await insertMemory(sql, scope, "global memory", [origin]);
    const matching = await insertMemory(sql, scope, "scoped memory", [origin]);
    const wrongWorkspace = await insertMemory(sql, scope, "foreign course memory", [origin]);
    await sql`UPDATE opening_memories SET course_id=${course.id} WHERE id=${matching}`;
    await sql`UPDATE opening_memories SET course_id=${foreign.id} WHERE id=${wrongWorkspace}`;
    const ids = async (courseId: string | null) => (await memories.listForContext(scope, courseId)).map(row => row.id);
    expect((await ids(course.id.toUpperCase())).sort()).toEqual([global, matching].sort());
    expect(await ids(null)).toEqual([global]);
    expect(await ids(foreign.id)).toEqual([global]);
    await courses.setArchived({ ...scope, courseId: course.id, archived: true });
    expect(await ids(course.id)).toEqual([global]);
  });

  it.each(["pin", "citation"] as const)("requires and carries an assistant origin's saved %s before replacement", async evidence => {
    const { sql, scope } = fixture;
    const sourceId = await insertSource(sql, scope);
    const sourceRef = { sourceId, sourceVersion: 0 };
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId], role: "assistant", contextSourceRefs: [] });
    const memoryId = await insertMemory(sql, scope, "assistant evidence", [origin]);
    const load = () => memories.listContext(scope, new Date().toISOString());
    await sql`UPDATE opening_turns SET source_versions='{}'::jsonb WHERE id=${origin}`;
    await expect(load()).resolves.toEqual({ memories: [], sourceRefs: [] });
    await expect(memories.proposeMemory(scope, { text: "unversioned suggestion", sourceTurnIds: [origin], expiresAt: null }))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await sql`UPDATE opening_turns SET source_versions=${sql.json(evidence === "pin" ? { [sourceId]: 0 } : {})},
      citations=${sql.json(evidence === "citation" ? [sourceRef] : [])} WHERE id=${origin}`;
    await expect(load()).resolves.toMatchObject({ memories: [{ id: memoryId }], sourceRefs: [sourceRef] });
    await sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
    await expect(load()).resolves.toEqual({ memories: [], sourceRefs: [] });
  });

  it("filters memories when source purpose or course membership no longer allows their material", async () => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory materials", slug: "memory-materials" });
    const sourceId = await insertSource(sql, scope);
    const turnId = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId] });
    const scoped = await insertMemory(sql, scope, "Course evidence", [turnId]);
    const global = await insertMemory(sql, scope, "Workspace evidence", [turnId]);
    await sql`UPDATE opening_memories SET course_id=${course.id} WHERE id=${scoped}`;
    const membership = { workspaceId: scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
    const ids = async (use: "citation" | "practice" = "citation") =>
      (await memories.listContext(scope, new Date().toISOString(), course.id, use)).memories.map(memory => memory.id);
    expect(await ids()).toEqual([global]);
    await courses.addAssetMembership({ ...membership, role: "core", visibility: "course", purpose: "teaching" });
    expect(await ids()).toEqual([scoped, global]);
    await sql`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${scope.workspaceId} AND asset_id=${sourceId}`;
    expect(await ids()).toEqual([scoped, global]);
    expect(await ids("practice")).toEqual([global]);
    await sql`UPDATE course_asset_memberships SET purpose='practice' WHERE workspace_id=${scope.workspaceId} AND asset_id=${sourceId}`;
    expect(await ids()).toEqual([global]);
    expect(await ids("practice")).toEqual([scoped, global]);
    await sql`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE workspace_id=${scope.workspaceId} AND asset_id=${sourceId}`;
    expect(await ids()).toEqual([]);
    await courses.removeAssetMembership(membership);
    expect(await ids()).toEqual([global]);
  });

  it("requires the source membership in both the saved origin and the memory's destination", async () => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const originCourse = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Origin", slug: randomUUID() });
    const destination = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Destination", slug: randomUUID() });
    const sourceId = await insertSource(sql, scope);
    const membership = { workspaceId: scope.workspaceId, assetType: "source" as const, assetId: sourceId };
    for (const course of [originCourse, destination]) await courses.addAssetMembership({
      ...membership, courseId: course.id, role: "core", visibility: "course", purpose: "teaching",
    });
    const turnId = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId] });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: originCourse.id })} WHERE id=${turnId}`;
    const proposal = { courseId: destination.id, text: "Shared source", sourceTurnIds: [turnId], expiresAt: null };
    const memory = await memories.proposeMemory(scope, proposal);
    await memories.confirm(scope, memory.id, memory.version, randomUUID());
    const context = () => memories.listContext(scope, new Date().toISOString(), destination.id);
    expect((await context()).memories.map(item => item.id)).toContain(memory.id);
    await courses.removeAssetMembership({ ...membership, courseId: originCourse.id });
    expect((await context()).memories.map(item => item.id)).not.toContain(memory.id);
    await expect(memories.proposeMemory(scope, proposal)).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("rejects explicit ancestry that crosses an intermediate turn outside the memory's course", async () => {
    const { sql, scope } = fixture;
    const courses = createCourseMembershipRepository(sql);
    const courseA = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory course A", slug: randomUUID() });
    const courseB = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory course B", slug: randomUUID() });
    const makeMemory = async (text: string, turnId: string) => {
      const id = await insertMemory(sql, scope, text, [turnId]);
      await sql`UPDATE opening_memories SET course_id=${courseA.id} WHERE id=${id}`;
      return id;
    };
    const citeMemory = async (courseId: string, memoryId: string) => {
      const turnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [{ memoryDependencyIds: [memoryId] }] });
      await sql`UPDATE opening_conversations SET course_id=${courseId} WHERE id=(
        SELECT conversation_id FROM opening_turns WHERE id=${turnId})`;
      return turnId;
    };
    const original = await makeMemory("Course A evidence", await insertOwnedTurn(sql, scope));
    const courseBTurn = await citeMemory(courseB.id, original);
    const crossed = await makeMemory("Derived from a course B turn", courseBTurn);
    await insertMemory(sql, scope, "Global memory derived from a scoped dependency", [courseBTurn]);
    await makeMemory("Derived from the crossed memory", await citeMemory(courseA.id, crossed));
    expect((await memories.listContext(scope, new Date().toISOString(), courseA.id)).memories.map(memory => memory.id))
      .toEqual([original]);
  });

  it("hides memories with a missing or foreign turn and a foreign conversation owner", async () => {
    const missing = await insertMemory(fixture.sql, fixture.scope, "missing turn", [randomUUID()]);
    const foreignTurn = await insertOwnedTurn(fixture.sql, fixture.otherScope);
    const foreign = await insertMemory(fixture.sql, fixture.scope, "foreign turn", [foreignTurn]);
    const conversationId = randomUUID();
    const turnId = randomUUID();
    await fixture.sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${fixture.scope.workspaceId}, ${fixture.otherScope.ownerUserId}, 'foreign owner')`;
    await fixture.sql`
      INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status)
      VALUES (${turnId}, ${fixture.scope.workspaceId}, ${conversationId}, 'user', 'x', 'explain', 'complete')`;
    const foreignOwner = await insertMemory(fixture.sql, fixture.scope, "foreign owner", [turnId]);
    const ids = (await memories.listForContext(fixture.scope, null)).map((item) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining([missing, foreign, foreignOwner]));
    const listed = (await memories.list(fixture.scope)).map((item) => item.id);
    expect(listed).toEqual(expect.arrayContaining([missing, foreign, foreignOwner]));
  });

  it("fail-closes excluded, revoked, citation-only, and version-drifted sources", async () => {
    const excludedId = await insertSource(fixture.sql, fixture.scope);
    const excludedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [excludedId] });
    const excluded = await insertMemory(fixture.sql, fixture.scope, "excluded", [excludedTurn]);
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${excludedId}, NULL, now())`;

    const revokedId = await insertSource(fixture.sql, fixture.scope, "rejected");
    const revokedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [revokedId] });
    const revoked = await insertMemory(fixture.sql, fixture.scope, "revoked", [revokedTurn]);

    const citedId = await insertSource(fixture.sql, fixture.scope);
    const citationTurn = await insertOwnedTurn(fixture.sql, fixture.scope, {
      citations: [{ sourceId: citedId, sourceVersion: 0 }],
    });
    const citation = await insertMemory(fixture.sql, fixture.scope, "citation only", [citationTurn]);
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.scope.workspaceId}, ${citedId}, NULL, now())`;

    const driftedId = await insertSource(fixture.sql, fixture.scope, "uploaded", 2);
    const driftedTurn = await insertOwnedTurn(fixture.sql, fixture.scope, {
      citations: [{ sourceId: driftedId, sourceVersion: 1 }],
    });
    const drifted = await insertMemory(fixture.sql, fixture.scope, "drifted", [driftedTurn]);

    const ids = (await memories.listForContext(fixture.scope, null)).map((item) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining([excluded, revoked, citation, drifted]));
  });

  it("does not let another workspace exclusion or a deleted sibling hide a legal memory", async () => {
    const shared = await insertSource(fixture.sql, fixture.scope);
    const legalTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [shared] });
    const legal = await insertMemory(fixture.sql, fixture.scope, "legal", [legalTurn]);
    const siblingTurn = await insertOwnedTurn(fixture.sql, fixture.scope, { sourceIds: [shared] });
    const sibling = await insertMemory(fixture.sql, fixture.scope, "sibling", [siblingTurn]);
    await fixture.sql`
      UPDATE opening_memories SET status = 'deleted' WHERE id = ${sibling}`;
    await fixture.sql`
      INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
      VALUES (${randomUUID()}, ${fixture.otherScope.workspaceId}, ${shared}, ${sibling}, now())`;

    expect((await memories.listForContext(fixture.scope, null)).map((item) => item.id)).toEqual([legal]);
    expect((await memories.list(fixture.scope)).map((item) => item.id)).toEqual([legal]);
  });

  it("keeps an empty sourceTurnIds memory visible in list but out of context", async () => {
    const id = await insertMemory(fixture.sql, fixture.scope, "no evidence", []);
    expect((await memories.list(fixture.scope)).map((item) => item.id)).toEqual([id]);
    expect(await memories.listForContext(fixture.scope, null)).toEqual([]);
  });
});
