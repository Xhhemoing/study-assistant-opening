import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCourseMembershipRepository, createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningMemoryRepository, createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
} from "@aistudy/database";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { insertOwnedTurn } from "./opening-memory-context-fixture";
import { closeRace, deferred, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
import { readTurnsWithActiveMemoryDependencies } from "../../packages/database/src/repositories/opening-context-provenance";
import { admitTaskCandidate, assertTaskCandidateMemoryDependencies } from "../../packages/database/src/repositories/opening-task-candidate-admission";
import { insertOpeningTaskWithOutcome } from "../../packages/database/src/repositories/opening-retest-task";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`TRUNCATE opening_memories, opening_privacy_exclusions RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await f?.close(); });

async function source() {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources
    (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${id},${f.scope.workspaceId},'secret.pdf','application/pdf',1,${"a".repeat(64)},0,'uploaded','ready')`;
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, {
    sourceId: id, sourceVersion: 0,
    chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null,
      text: "ancestor-secret-material", imageObjectKey: null }],
  });
  return id;
}
async function append(conversationId: string, sourceIds: string[] = [], text = "continue") {
  return createOpeningConversationRepository(f.sql).appendSavedTurn({
    scope: f.scope, conversationId, text, sourceIds, mode: "explain",
    clientKey: randomUUID(), learningSessionId: null, currentPage: null, chunkId: null,
  });
}
function handler(text: string, memoryText?: string) {
  const calls: ProviderInput[] = [];
  const provider = { complete: vi.fn(async (input: ProviderInput): Promise<ProviderOutput> => {
    calls.push(input);
    return { text, citedChunkIds: [], requestId: null, inputTokens: 20, outputTokens: 10,
      candidates: memoryText ? [{ kind: "memory", text: memoryText, temporary: false }] : [] };
  }) };
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const run = createTutorTurnHandler({
    tutorJobs: createOpeningTutorJobsRepository(f.sql),
    chunks: createOpeningSourceChunksRepository(f.sql),
    budget,
    retrieveContext: createOpeningMaterialRetriever(f.sql, budget, null),
    privacy: createOpeningPrivacyRepository(f.sql), provider,
    memories: { listContext: (scope, now, activeCourseId, materialUse) =>
      createOpeningMemoryRepository(f.sql).listContext(scope, now, activeCourseId ?? null, materialUse) },
    config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 256,
      inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { run, calls };
}

describe("saved tutor material provenance", () => {
  it.each(["session", "activity"] as const)("fences saved tutor reuse against material held only by the paired user %s", async origin => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const createCourse = (title: string) => courses.createCourse({ workspaceId: scope.workspaceId, title, slug: randomUUID() });
    const userCourse = await createCourse("Task user course");
    const assistantCourse = await createCourse("Task assistant course");
    const assetId = await source();
    const membership = { workspaceId: scope.workspaceId, courseId: userCourse.id, assetType: "source" as const, assetId };
    await courses.addAssetMembership({ ...membership, role: "core", visibility: "course", purpose: "teaching" });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Paired session task", courseId: null });
    const turn = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(turn.jobId))!;
    const target = { scope, jobId: turn.jobId, assistantTurnId: turn.assistantTurnId, claimToken: claim.claimToken };
    await jobs.completeTurn({ ...target, text: "Saved session answer", citations: [], candidates: [], contextSourceRefs: [] });
    for (const [courseId, turnId] of [[userCourse.id, turn.turnId], [assistantCourse.id, turn.assistantTurnId]] as const) {
      const sessionId = randomUUID();
      const activityId = await insertTestTeachingActivity(sql, scope, courseId);
      const sources = courseId === userCourse.id ? [assetId] : [];
      await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, course_id, activity_id, skill_label, source_ids)
        VALUES (${sessionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId}, ${activityId}, 'Task origin',
          ${origin === "session" ? sources : []}::uuid[])`;
      if (origin === "activity" && sources.length) {
        await sql`UPDATE opening_teaching_activities SET source_ids=${sources}::uuid[] WHERE id=${activityId}`;
      }
      await sql`UPDATE opening_turns SET learning_session_id=${sessionId},status='complete',context_source_refs='[]' WHERE id=${turnId}`;
    }
    const next = await append(conversation.id);
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: userCourse.id })} WHERE id=${next.turnId}`;
    const history = () => jobs.loadHistoryContext(scope, next.turnId);
    const memories = createOpeningMemoryRepository(sql);
    const propose = () => memories.proposeMemory(scope, {
      courseId: userCourse.id, text: "Saved session material", sourceTurnIds: [turn.turnId], expiresAt: null,
    });
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
    await expect(history()).resolves.toMatchObject({
      history: [{ role: "user", text: "continue" }, { role: "assistant", text: "Saved session answer" }],
      historyCourseBindings: expect.arrayContaining([expect.objectContaining({ courseId: userCourse.id, sourceIds: [assetId] })]),
    });
    await expect(propose()).resolves.toMatchObject({ sourceTurnIds: [turn.turnId] });
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${turn.assistantTurnId}, '[]',
        ${sql.json({ kind: "task", title: "Session task", minutes: 15, dueText: null })})`;
    const admit = () => sql.begin(async tx => {
      const dependency = await admitTaskCandidate(tx, scope, id);
      await assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, dependency);
      return dependency;
    });
    await expect(admit()).resolves.toBe(turn.assistantTurnId);
    await courses.removeAssetMembership(membership);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(sql.begin(tx => assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, turn.assistantTurnId)))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await sql`DELETE FROM opening_assistant_candidates WHERE id=${id}`;
    const startSend = vi.fn(async () => true);
    await expect(jobs.authorizeMetadataSend(target, startSend)).rejects.toThrow("tutor metadata authorization changed");
    expect(startSend).not.toHaveBeenCalled();
    await expect(history()).resolves.toMatchObject({ history: [], revokedDirectSourceIds: [assetId] });
    await expect(propose()).rejects.toMatchObject({ code: "VALIDATION" });
  }, 15_000);

  it("checks a task's paired user memory and its backing course under the user's scope", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const createCourse = (title: string) => courses.createCourse({ workspaceId: scope.workspaceId, title, slug: randomUUID() });
    const userCourse = await createCourse("Memory consumer");
    const assistantCourse = await createCourse("Task answer");
    const backingCourse = await createCourse("Memory evidence");
    const assetId = await source();
    const backing = { workspaceId: scope.workspaceId, courseId: backingCourse.id, assetType: "source" as const, assetId };
    for (const membership of [backing, { ...backing, courseId: userCourse.id }]) {
      await courses.addAssetMembership({ ...membership, role: "core", visibility: "course", purpose: "teaching" });
    }
    const memoryOrigin = await insertOwnedTurn(sql, scope, { sourceIds: [assetId] });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: backingCourse.id })} WHERE id=${memoryOrigin}`;
    const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
      courseId: userCourse.id, text: "User memory", sourceTurnIds: [memoryOrigin], expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Paired memory task", courseId: null });
    const turn = await append(conversation.id);
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: userCourse.id })},
      context_source_refs=${sql.json([{ memoryDependencyIds: [memory.id] }])} WHERE id=${turn.turnId}`;
    await sql`UPDATE opening_turns SET status='complete', context_anchor=${sql.json({ courseId: assistantCourse.id })},
      context_source_refs='[]' WHERE id=${turn.assistantTurnId}`;
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${turn.assistantTurnId}, '[]',
        ${sql.json({ kind: "task", title: "Memory task", minutes: 15, dueText: null })})`;
    const admit = () => sql.begin(async tx => {
      const dependency = await admitTaskCandidate(tx, scope, id);
      await assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, dependency);
      return dependency;
    });
    await expect(admit()).resolves.toBe(turn.assistantTurnId);
    await courses.removeAssetMembership(backing);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(sql.begin(tx => assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, turn.assistantTurnId)))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await sql`UPDATE opening_turns SET context_source_refs='[{"memoryDependencyIds":["invalid"]}]' WHERE id=${turn.turnId}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each(["assistant-source", "candidate-only"] as const)("requires saved versions for task material from %s records", async origin => {
    const { sql, scope } = f;
    const sourceId = await source();
    const conversations = createOpeningConversationRepository(sql);
    const conversation = await conversations.create(scope, { title: "Versioned task evidence", courseId: null });
    const saved = await append(conversation.id);
    const assistantIds = origin === "assistant-source" ? [sourceId] : [];
    await sql`UPDATE opening_turns SET status='complete',source_ids=${assistantIds}::uuid[],context_source_refs='[]'::jsonb
      WHERE id=${saved.assistantTurnId}`;
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, ${sql.json([sourceId])},
        ${sql.json({ kind: "task", title: "Review evidence", minutes: 15, dueText: null })})`;
    const admit = () => sql.begin(tx => admitTaskCandidate(tx, scope, id));
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    const versionOwner = origin === "assistant-source" ? saved.assistantTurnId : saved.turnId;
    await sql`UPDATE opening_turns SET source_versions=${sql.json({ [sourceId]: 0 })} WHERE id=${versionOwner}`;
    await expect(admit()).resolves.toBe(origin === "candidate-only" ? saved.assistantTurnId : null);
    await sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await sql`UPDATE opening_turns SET source_versions='{}'::jsonb WHERE id=${versionOwner}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("confirms and replays practice memory suggestions scoped by a saved turn in an unscoped conversation", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Practice suggestions", slug: randomUUID() });
    const material = await source();
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id,
      assetType: "source", assetId: material, role: "core", visibility: "course", purpose: "practice" });
    const conversations = createOpeningConversationRepository(sql);
    const conversation = await conversations.create(scope, { title: "Practice memory suggestions", courseId: null });
    const memories = createOpeningMemoryRepository(sql);
    const suggest = async (practice: boolean, ancestor?: string) => {
      const saved = await append(conversation.id);
      const anchor = { courseId: course.id, ...(practice ? { itemVersionId: randomUUID() } : {}) };
      await sql`UPDATE opening_turns SET context_anchor=${sql.json(anchor)} WHERE id=${saved.turnId}`;
      const refs = ancestor ? [{ memoryDependencyIds: [ancestor] }] : [{ sourceId: material, sourceVersion: 0 }];
      await sql`UPDATE opening_turns SET status='complete', context_source_refs=${sql.json(refs)} WHERE id=${saved.assistantTurnId}`;
      const id = randomUUID();
      await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
        VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, ${sql.json([material])},
          ${sql.json({ kind: "memory", text: `Practice preference ${id}`, temporary: false })})`;
      const input = { id, action: "confirm" as const, expectedVersion: 0, clientKey: randomUUID(), expiresAt: null };
      const confirmed = await memories.decideMemoryCandidate(scope, input);
      expect(confirmed.courseId).toBe(course.id);
      await expect(memories.decideMemoryCandidate(scope, input)).resolves.toEqual(confirmed);
      return confirmed;
    };

    const direct = await suggest(true);
    const inherited = await suggest(true, direct.id);
    await expect(suggest(false)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(suggest(false, direct.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(memories.listForContext(scope, course.id)).resolves.toEqual([]);
    await expect(memories.listForContext(scope, course.id, "practice")).resolves.toEqual([
      expect.objectContaining({ id: direct.id }), expect.objectContaining({ id: inherited.id }),
    ]);
    await courses.setArchived({ ...scope, courseId: course.id, archived: true });
    await expect(suggest(true)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("waits for removal of a task candidate's last backing-source membership and rejects acceptance", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Task source membership", slug: randomUUID() });
    const material = await source();
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id,
      assetType: "source", assetId: material, role: "core", visibility: "course", purpose: "teaching" });
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, { courseId: course.id,
      text: "Task backing material", sourceTurnIds: [origin], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Task candidate", courseId: course.id });
    const saved = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(saved.jobId))!;
    await jobs.completeTurn({ scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claim.claimToken,
      text: "Task from memory", citations: [], candidates: [], contextSourceRefs: [] }, { globalMemoryIds: [memory.id] });
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, '[]'::jsonb,
        ${sql.json({ kind: "task", title: "Practice", minutes: 15, dueText: null })})`;
    await expect(sql.begin(tx => admitTaskCandidate(tx, scope, id))).resolves.toBe(saved.assistantTurnId);

    const writer = openRaceSession();
    const reader = openRaceSession();
    const removed = deferred();
    const release = deferred();
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([writer.ready, reader.ready]);
      const removal = track(writer.sql.begin(async tx => {
        await tx`DELETE FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId} AND course_id=${course.id}
          AND asset_type='source' AND asset_id=${material}`;
        removed.resolve();
        await release.promise;
      }));
      pending.push(removal);
      await Promise.race([removed.promise, removal]);
      const admission = track(reader.sql.begin(tx => admitTaskCandidate(tx, scope, id)));
      pending.push(admission);
      await waitUntilBlocked(sql, reader.pid, writer.pid, "task source membership", /FROM course_asset_memberships/);
      release.resolve();
      await removal;
      await expect(admission).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("memory dependency") });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await Promise.all([closeRace(writer.sql), closeRace(reader.sql)]);
    }
  }, 15_000);

  it("rechecks the saved course policy for direct task material and rejects malformed citation metadata", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Direct task materials", slug: randomUUID() });
    const other = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Other course exam", slug: randomUUID() });
    const material = await source();
    const membership = { workspaceId: scope.workspaceId, courseId: course.id,
      assetType: "source" as const, assetId: material, role: "core" as const, visibility: "course" as const };
    await courses.addAssetMembership({ ...membership, purpose: "practice" });
    const otherMembership = { ...membership, courseId: other.id };
    await courses.addAssetMembership({ ...otherMembership, purpose: "mock_exam" });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Task candidate", courseId: null });
    const saved = await append(conversation.id);
    const setUse = (practice: boolean, courseId: string | null = course.id) => sql`UPDATE opening_turns
      SET context_anchor=${courseId === null ? null : sql.json({ courseId, ...(practice ? { itemVersionId: randomUUID() } : {}) })}
      WHERE id=${saved.turnId}`;
    await setUse(true);
    await sql`UPDATE opening_turns SET status='complete', context_source_refs=${sql.json([{ sourceId: material, sourceVersion: 0 }])}
      WHERE id=${saved.assistantTurnId}`;
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, ${sql.json([material])},
        ${sql.json({ kind: "task", title: "Practice", minutes: 15, dueText: null })})`;
    const accept = () => insertOpeningTaskWithOutcome(sql, scope,
      { candidateId: id, courseId: course.id, title: "Practice", minutes: 15, dueAt: null, priority: 0 });
    const admit = () => sql.begin(tx => admitTaskCandidate(tx, scope, id));
    await expect(admit()).resolves.toBe(saved.assistantTurnId);
    await setUse(false);
    await expect(admit()).resolves.toBe(saved.assistantTurnId);
    await setUse(false, other.id);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await setUse(false, null);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await setUse(false);
    await sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${course.id} AND asset_id=${material}`;
    await expect(admit()).resolves.toBe(saved.assistantTurnId);
    await setUse(true);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await courses.removeAssetMembership(membership);
    await expect(accept()).rejects.toMatchObject({ code: "VALIDATION" });
    await courses.addAssetMembership({ ...membership, purpose: "mock_exam" });
    await expect(accept()).rejects.toMatchObject({ code: "VALIDATION" });
    await courses.removeAssetMembership(membership);
    await courses.addAssetMembership({ ...membership, purpose: "practice" });
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: course.id, itemVersionId: randomUUID() })}
      WHERE id=${origin}`;
    const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, { courseId: course.id,
      text: "Practice source memory", sourceTurnIds: [origin], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const inherited = [{ sourceId: material, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [memory.id] }];
    await sql`UPDATE opening_turns SET context_source_refs=${sql.json(inherited)} WHERE id=${saved.assistantTurnId}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await courses.removeAssetMembership(otherMembership);
    await expect(admit()).resolves.toBe(saved.assistantTurnId);
    await setUse(false);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await setUse(true);
    await sql`UPDATE opening_turns SET context_source_refs=${sql.json([{ sourceId: material, sourceVersion: 0 }])}
      WHERE id=${saved.assistantTurnId}`;
    await sql`UPDATE opening_turns SET citations=${sql.json([{ memoryDependencyIds: [randomUUID()] }])} WHERE id=${saved.assistantTurnId}`;
    await expect(accept()).rejects.toMatchObject({ code: "VALIDATION" });
    const [candidate] = await sql`SELECT status FROM opening_assistant_candidates WHERE id=${id}`;
    expect(candidate?.status).toBe("pending");
    await sql`UPDATE opening_turns SET citations='[]'::jsonb WHERE id=${saved.assistantTurnId}`;
    await courses.addAssetMembership({ ...otherMembership, purpose: "mock_exam" });
    await expect(accept()).resolves.toMatchObject({ task: { title: "Practice" } });
  }, 15_000);

  it("allows a backed global memory-only task source and rejects an unbacked or directly used source", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Inherited task material", slug: randomUUID() });
    const material = await source();
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const memories = createOpeningMemoryRepository(sql);
    const proposed = await memories.proposeMemory(scope, {
      text: "Global task material", sourceTurnIds: [origin], expiresAt: null,
    });
    const memory = await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Inherited task candidate", courseId: course.id });
    const saved = await append(conversation.id);
    const id = randomUUID();
    const memoryOnlyRef = { sourceId: material, sourceVersion: 0, memoryOnly: true };
    const setRefs = (refs: typeof memoryOnlyRef[]) => sql`UPDATE opening_turns SET status='complete',
      context_source_refs=${sql.json([...refs, { memoryDependencyIds: [memory.id] }])} WHERE id=${saved.assistantTurnId}`;
    await setRefs([memoryOnlyRef]);
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, ${sql.json([material])},
        ${sql.json({ kind: "task", title: "Review", minutes: 15, dueText: null })})`;
    const admit = () => sql.begin(tx => admitTaskCandidate(tx, scope, id));
    await expect(admit()).resolves.toBe(saved.assistantTurnId);
    await sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${saved.turnId}`;
    const next = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(next.jobId))!;
    const send = () => jobs.assertSendAuthorized(scope, next.jobId, {
      claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: [memoryOnlyRef], globalMemoryIds: [memory.id],
    });
    const history = () => jobs.loadHistoryContext(scope, next.turnId);
    const context = () => memories.listForContext(scope, course.id);
    const other = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Classified elsewhere", slug: randomUUID() });
    const membership = { workspaceId: scope.workspaceId, courseId: other.id, assetType: "source" as const, assetId: material };
    await courses.addAssetMembership({ ...membership, role: "core", visibility: "course", purpose: "teaching" });
    for (const purpose of ["teaching", "reference", "practice", null] as const) {
      await sql`UPDATE course_asset_memberships SET purpose=${purpose} WHERE course_id=${other.id} AND asset_id=${material}`;
      await expect(admit()).resolves.toBe(saved.assistantTurnId);
      await expect(send()).resolves.toBeUndefined();
      await expect(history()).resolves.toMatchObject({ memoryIds: [memory.id] });
      await expect(context()).resolves.toEqual([expect.objectContaining({ id: memory.id })]);
    }
    await sql`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE course_id=${other.id} AND asset_id=${material}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(history()).resolves.toEqual({ history: [], sourceRefs: [] });
    await expect(context()).resolves.toEqual([]);
    await sql`UPDATE course_asset_memberships SET purpose='teaching' WHERE course_id=${other.id} AND asset_id=${material}`;
    await sql`UPDATE opening_turns SET source_ids=ARRAY[${material}]::uuid[] WHERE id=${saved.assistantTurnId}`;
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await sql`UPDATE opening_turns SET source_ids='{}' WHERE id=${saved.assistantTurnId}`;
    await setRefs([{ ...memoryOnlyRef, sourceId: await source() }]);
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
  }, 15_000);

  it.each(["anchor", "session", "paired user session"] as const)("blocks a classified course origin bound by %s at any ancestry depth", async binding => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const courseA = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Practice origin", slug: randomUUID() });
    const courseB = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Other course", slug: randomUUID() });
    const material = await source();
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: courseA.id, assetType: "source",
      assetId: material, role: "core", visibility: "course" });
    const conversations = createOpeningConversationRepository(sql);
    let origin: string;
    if (binding === "anchor") {
      origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
      await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: courseA.id, itemVersionId: randomUUID() })}
        WHERE id=${origin}`;
    } else {
      const sessionId = randomUUID();
      const activityId = await insertTestTeachingActivity(sql, scope, courseA.id);
      await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, course_id, activity_id, skill_label)
        VALUES (${sessionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseA.id}, ${activityId}, 'Practice origin')`;
      const unscoped = await conversations.create(scope, { title: "Session-based origin", courseId: null });
      const saved = await conversations.appendSavedTurn({ scope, conversationId: unscoped.id, text: "Review the source",
        sourceIds: [material], mode: "explain", clientKey: randomUUID(), learningSessionId: sessionId, currentPage: null, chunkId: null });
      origin = saved.turnId;
      if (binding === "paired user session") {
        origin = saved.assistantTurnId;
        await sql`UPDATE opening_turns SET status='complete', learning_session_id=NULL,
          context_source_refs=${sql.json([{ sourceId: material, sourceVersion: 0 }])} WHERE id=${origin}`;
      }
    }
    const memories = createOpeningMemoryRepository(sql);
    const proposed = await memories.proposeMemory(scope, { text: "Course-origin memory", sourceTurnIds: [origin], expiresAt: null });
    const root = await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    expect(root.courseId).toBeNull();
    const derivedTurn = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [{ memoryDependencyIds: [root.id] }] });
    const derived = await memories.proposeMemory(scope, { text: "Derived preference", sourceTurnIds: [derivedTurn], expiresAt: null });
    const descendant = await memories.confirm(scope, derived.id, derived.version, randomUUID());
    const conversation = await conversations.create(scope, { title: "Course B Tutor", courseId: courseB.id });
    const jobs = createOpeningTutorJobsRepository(sql);
    const saved = await append(conversation.id);
    const savedClaim = (await jobs.claim(saved.jobId))!;
    const target = { scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: savedClaim.claimToken };
    await jobs.completeTurn({ ...target, text: "Saved answer", citations: [], candidates: [], contextSourceRefs: [] },
      { globalMemoryIds: [descendant.id] });
    const pending = await append(conversation.id);
    const claim = (await jobs.claim(pending.jobId))!;
    const send = { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: [], globalMemoryIds: [root.id, descendant.id] };
    const context = () => memories.listForContext(scope, courseB.id);
    await expect(context()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: root.id }),
      expect.objectContaining({ id: descendant.id })]));
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).resolves.toBeUndefined();
    const id = randomUUID();
    await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
      VALUES (${id}, ${scope.workspaceId}, ${conversation.id}, ${saved.assistantTurnId}, '[]'::jsonb,
        ${sql.json({ kind: "task", title: "Review", minutes: 15, dueText: null })})`;
    const admit = () => sql.begin(tx => admitTaskCandidate(tx, scope, id));
    await expect(admit()).resolves.toBe(saved.assistantTurnId);

    await sql`UPDATE course_asset_memberships SET purpose='practice'
      WHERE workspace_id=${scope.workspaceId} AND asset_id=${material} AND course_id=${courseA.id}`;
    const startSend = vi.fn(async () => {});
    const publication = { ...send, privacyEpoch: await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope) };
    await expect(context()).resolves.toEqual([]);
    await expect(jobs.authorizeSend(scope, pending.jobId, send, startSend)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.withStreamPublication(scope, pending.jobId, publication, startSend)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.readStream(scope, pending.jobId, { ...publication, exposureReceiptId: null }, startSend))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(startSend).not.toHaveBeenCalled();
    await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
    await sql`DELETE FROM opening_assistant_candidates WHERE id=${id}`;
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(false);
    await expect(jobs.authorizeMetadataSend(target, startSend)).rejects.toThrow("tutor metadata authorization changed");
    await expect(jobs.appendCompletedTurnCandidates({ ...target,
      candidates: [{ kind: "memory", text: "Candidate", temporary: false }],
    })).resolves.toBe(false);
    expect(startSend).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects metadata dispatch and append when either saved turn has malformed citations or version pins", async () => {
    const { sql, scope } = f;
    const material = await source();
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Metadata shapes", courseId: null });
    const saved = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(saved.jobId))!;
    const target = { scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claim.claimToken };
    await jobs.completeTurn({ ...target, text: "Saved answer", citations: [], candidates: [], contextSourceRefs: [] });
    const startSend = vi.fn(async () => true);
    const appendCandidates = () => jobs.appendCompletedTurnCandidates({ ...target,
      candidates: [{ kind: "memory", text: "Candidate", temporary: false }] });
    for (const turnId of [saved.turnId, saved.assistantTurnId]) {
      const reject = async () => {
        await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(false);
        await expect(jobs.authorizeMetadataSend(target, startSend)).rejects.toThrow("tutor metadata authorization changed");
        await expect(appendCandidates()).resolves.toBe(false);
      };
      await sql`UPDATE opening_turns SET citations=${sql.json({ sourceId: material, sourceVersion: 0 })} WHERE id=${turnId}`;
      await reject();
      await sql`UPDATE opening_turns SET citations='[]'::jsonb,
        source_versions=${sql.json({ [material]: Number.MAX_SAFE_INTEGER + 1 })} WHERE id=${turnId}`;
      await reject();
      await sql`UPDATE opening_turns SET source_versions='{}'::jsonb WHERE id=${turnId}`;
    }
    expect(startSend).not.toHaveBeenCalled();
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
    await expect(jobs.authorizeMetadataSend(target, startSend)).resolves.toBe(true);
    await expect(appendCandidates()).resolves.toBe(true);
  }, 15_000);

  it.each(["unpinned", "pinned"] as const)("refuses metadata for a %s direct assistant source after replacement", async versionEvidence => {
    const { sql, scope } = f;
    const material = await source();
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Old metadata", courseId: null });
    const saved = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(saved.jobId))!;
    const target = { scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claim.claimToken };
    await jobs.completeTurn({ ...target, text: "Answer using the original source", citations: [], candidates: [], contextSourceRefs: [] });
    await sql`UPDATE opening_turns SET source_ids=ARRAY[${material}]::uuid[],
      source_versions=${sql.json(versionEvidence === "pinned" ? { [material]: 0 } : {})} WHERE id=${saved.assistantTurnId}`;
    if (versionEvidence === "pinned") {
      await expect(jobs.loadCompletedTurnForMetadata(target)).resolves.toMatchObject({ answer: "Answer using the original source" });
    }
    await sql`UPDATE opening_sources SET version=1 WHERE id=${material}`;
    await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,availability)
      VALUES (${material},0,${scope.workspaceId},'unavailable'),(${material},1,${scope.workspaceId},'available')
      ON CONFLICT (source_id,version) DO UPDATE SET availability=EXCLUDED.availability`;
    const send = vi.fn(async () => true);
    await expect(jobs.loadCompletedTurnForMetadata(target)).resolves.toBeNull();
    await expect(jobs.authorizeMetadataSend(target, send)).rejects.toThrow("tutor metadata authorization changed");
    expect(send).not.toHaveBeenCalled();
    await expect(jobs.appendCompletedTurnCandidates({ ...target, candidates: [{ kind: "memory", text: "Stale", temporary: false }] }))
      .resolves.toBe(false);
    expect(await sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${saved.assistantTurnId}`).toHaveLength(0);
  });

  it.each(["user", "assistant", "paired user"] as const)("checks ownership of the %s session before admitting classified global memory", async binding => {
    const { sql, scope, otherScope } = f;
    const courses = createCourseMembershipRepository(sql);
    const consumer = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Memory consumer", slug: randomUUID() });
    const classifier = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Material classification", slug: randomUUID() });
    const material = await source();
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Standalone origin", courseId: null });
    const saved = await append(conversation.id);
    const originId = binding === "user" ? saved.turnId : saved.assistantTurnId;
    const sessionTurnId = binding === "assistant" ? saved.assistantTurnId : saved.turnId;
    await sql`UPDATE opening_turns SET status='complete', source_ids=ARRAY[${material}]::uuid[],
      source_versions=${sql.json({ [material]: 0 })}, context_source_refs='[]'::jsonb WHERE id=${originId}`;
    const memories = createOpeningMemoryRepository(sql);
    const proposed = await memories.proposeMemory(scope, { text: "Standalone material", sourceTurnIds: [originId], expiresAt: null });
    const memory = await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: classifier.id, assetType: "source",
      assetId: material, role: "core", visibility: "course", purpose: "practice" });
    const context = () => memories.listForContext(scope, consumer.id);
    await expect(context()).resolves.toMatchObject([{ id: memory.id }]);

    const insertSession = async (sessionScope: typeof scope) => {
      const id = randomUUID();
      const activity = await insertTestTeachingActivity(sql, sessionScope);
      await sql`INSERT INTO opening_learning_sessions (id, workspace_id, owner_user_id, course_id, activity_id, skill_label)
        VALUES (${id}, ${sessionScope.workspaceId}, ${sessionScope.ownerUserId}, NULL, ${activity}, 'Course-less session')`;
      return id;
    };
    const bind = (sessionId: string) => sql`UPDATE opening_turns SET learning_session_id=${sessionId} WHERE id=${sessionTurnId}`;
    const missing = randomUUID();
    const foreignOwner = await insertSession({ ...scope, ownerUserId: otherScope.ownerUserId });
    const foreignWorkspace = await insertSession({ ...scope, workspaceId: otherScope.workspaceId });
    for (const sessionId of [missing, foreignOwner, foreignWorkspace]) {
      await bind(sessionId);
      await expect(context()).resolves.toEqual([]);
    }
    await bind(await insertSession(scope));
    await expect(context()).resolves.toMatchObject([{ id: memory.id }]);
  }, 15_000);

  it("fences bare completion against the archived saved course", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Completion course", slug: randomUUID() });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Bare completion", courseId: course.id });
    const saved = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(saved.jobId))!;
    const complete = () => jobs.completeTurn({ scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
      claimToken: claim.claimToken, text: "Saved answer", citations: [], candidates: [] });
    await courses.setArchived({ ...scope, courseId: course.id, archived: true });
    await expect(complete()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.get(scope, saved.jobId)).resolves.toMatchObject({ status: "running" });
    await courses.setArchived({ ...scope, courseId: course.id, archived: false });
    await complete();
    await expect(jobs.get(scope, saved.jobId)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("uses the saved course membership for direct metadata across unrelated exam classification", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Metadata practice", slug: randomUUID() });
    const exam = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Metadata exam", slug: randomUUID() });
    const material = await source();
    const membership = { workspaceId: scope.workspaceId, assetType: "source" as const, assetId: material,
      role: "core" as const, visibility: "course" as const };
    await courses.addAssetMembership({ ...membership, courseId: course.id, purpose: "practice" });
    await courses.addAssetMembership({ ...membership, courseId: exam.id, purpose: "mock_exam" });
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Direct metadata", courseId: null });
    const saved = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(saved.jobId))!;
    const target = { scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claim.claimToken };
    const bindCourse = (courseId: string | null) => sql`UPDATE opening_turns
      SET context_anchor=${courseId === null ? null : sql.json({ courseId })} WHERE id=${saved.turnId}`;
    await bindCourse(course.id);
    await jobs.completeTurn({ ...target, text: "Saved answer", citations: [], candidates: [],
      contextSourceRefs: [{ sourceId: material, sourceVersion: 0 }] });
    const startSend = vi.fn(async () => true);
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
    await expect(jobs.authorizeMetadataSend(target, startSend)).resolves.toBe(true);
    for (const courseId of [exam.id, null]) {
      await bindCourse(courseId);
      await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(false);
      await expect(jobs.authorizeMetadataSend(target, startSend)).rejects.toThrow("tutor metadata authorization changed");
    }
    expect(startSend).toHaveBeenCalledOnce();
    await bindCourse(course.id);
    await expect(jobs.appendCompletedTurnCandidates({ ...target,
      candidates: [{ kind: "memory", text: "Candidate", temporary: false }],
    })).resolves.toBe(true);
  });

  it("carries matching course memories through Worker completion and fences their exact IDs against the saved job", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const memories = createOpeningMemoryRepository(sql);
    const courseA = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Tutor memory course A", slug: "tutor-memory-a" });
    const courseB = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Tutor memory course B", slug: "tutor-memory-b" });
    const material = await source();
    const courseAMaterial = { workspaceId: scope.workspaceId, courseId: courseA.id, assetType: "source" as const, assetId: material };
    await courses.addAssetMembership({ ...courseAMaterial, role: "core", visibility: "course", purpose: "teaching" });
    const origin = await conversations.create(scope, { title: "Standalone origin", courseId: null });
    const evidence = await append(origin.id, [material]);
    const globalEvidence = await append(origin.id);
    const createMemory = async (courseId: string | null, sourceTurnId: string, text: string) => {
      const candidate = await memories.proposeMemory(scope, { courseId, text, sourceTurnIds: [sourceTurnId], expiresAt: null });
      return memories.confirm(scope, candidate.id, candidate.version, randomUUID());
    };
    const global = await createMemory(null, globalEvidence.turnId, "Global preference");
    const a = await createMemory(courseA.id, evidence.turnId, "Course A preference");
    const b = await createMemory(courseB.id, evidence.turnId, "Course B preference");
    const conversation = await conversations.create(scope, { title: "Use course A", courseId: courseA.id });
    const first = await append(conversation.id);
    const worker = handler("Course A response");
    await worker.run(first.jobId);
    expect(worker.calls[0]?.instruction).toContain(global.text);
    expect(worker.calls[0]?.instruction).toContain(a.text);
    expect(worker.calls[0]?.instruction).not.toContain(b.text);
    const [saved] = await sql`SELECT context_source_refs FROM opening_turns WHERE id=${first.assistantTurnId}`;
    const sourceRef = { sourceId: material, sourceVersion: 0, memoryOnly: true };
    expect(saved?.context_source_refs).toEqual([sourceRef, { memoryDependencyIds: [global.id, a.id].sort() }]);
    const completed = await jobs.get(scope, first.jobId);
    const metadataTarget = { scope, jobId: first.jobId, assistantTurnId: first.assistantTurnId, claimToken: completed?.claimToken };
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(true);

    const direct = await append(conversation.id, [material]);
    const directClaim = (await jobs.claim(direct.jobId))!;
    await jobs.completeTurn({
      scope, jobId: direct.jobId, assistantTurnId: direct.assistantTurnId, claimToken: directClaim.claimToken,
      text: "Direct course citation", citations: [], candidates: [], contextSourceRefs: [{ sourceId: material, sourceVersion: 0 }],
    });
    const directTarget = { ...metadataTarget, jobId: direct.jobId, assistantTurnId: direct.assistantTurnId, claimToken: directClaim.claimToken };
    await expect(jobs.canAppendCompletedTurnCandidates(directTarget)).resolves.toBe(true);

    const pending = await append(origin.id);
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ purpose: "learning_help", courseId: courseA.id.toUpperCase() })} WHERE id=${pending.turnId}`;
    const claim = (await jobs.claim(pending.jobId))!;
    const send = { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: [sourceRef],
      memoryLineageSourceIds: [material], globalMemoryIds: [a.id] };
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [global.id, a.id], pending.jobId)).resolves.toBeUndefined();
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [b.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).resolves.toBeUndefined();
    const idOnly = await append(conversation.id);
    const idOnlyClaim = (await jobs.claim(idOnly.jobId))!;
    await jobs.completeTurn({ scope, jobId: idOnly.jobId, assistantTurnId: idOnly.assistantTurnId,
      claimToken: idOnlyClaim.claimToken, text: "Saved memory response", citations: [], candidates: [],
      contextSourceRefs: [] }, { globalMemoryIds: [a.id] });
    const idOnlyTarget = { ...metadataTarget, jobId: idOnly.jobId, assistantTurnId: idOnly.assistantTurnId,
      claimToken: idOnlyClaim.claimToken };
    await expect(jobs.canAppendCompletedTurnCandidates(idOnlyTarget)).resolves.toBe(true);
    const checkCandidateTurn = () => readTurnsWithActiveMemoryDependencies(sql, scope.workspaceId, [idOnly.assistantTurnId]);
    await expect(checkCandidateTurn()).resolves.toEqual(new Set([idOnly.assistantTurnId]));

    const publication = { ...send, historyCourseBindings: [], privacyEpoch: await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope) };
    const publish = vi.fn(async () => {});
    const deliver = vi.fn();
    await courses.removeAssetMembership(courseAMaterial);
    await expect(jobs.canAppendCompletedTurnCandidates(directTarget)).resolves.toBe(false);
    await expect(checkCandidateTurn()).resolves.toEqual(new Set());
    await expect(jobs.canAppendCompletedTurnCandidates(idOnlyTarget)).resolves.toBe(false);
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.withStreamPublication(scope, pending.jobId, publication, publish)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.readStream(scope, pending.jobId, { ...publication, exposureReceiptId: null }, deliver))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(publish).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    const membership = { workspaceId: scope.workspaceId, courseId: courseB.id, assetType: "source" as const, assetId: material };
    for (const purpose of [null, "teaching", "mock_exam"] as const) {
      await courses.addAssetMembership({ ...membership, role: "core", purpose, visibility: "course" });
      await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(false);
      await courses.removeAssetMembership(membership);
    }
    const sameCourse = { ...membership, courseId: courseA.id };
    await courses.addAssetMembership({ ...sameCourse, role: "core", purpose: "practice", visibility: "course" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(false);
    await courses.removeAssetMembership(sameCourse);
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(false);
    await courses.addAssetMembership({ ...courseAMaterial, role: "core", visibility: "course", purpose: "teaching" });
    await jobs.withStreamPublication(scope, pending.jobId, publication, publish);
    expect(publish).toHaveBeenCalledOnce();
    await jobs.readStream(scope, pending.jobId, { ...publication, exposureReceiptId: null }, deliver);
    expect(deliver).toHaveBeenCalledOnce();
    await expect(jobs.withStreamPublication(scope, pending.jobId,
      { ...publication, privacyEpoch: publication.privacyEpoch + 1 }, publish)).rejects.toMatchObject({ code: "PRIVACY_EPOCH_MISMATCH" });
    await sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${material}`;
    await expect(jobs.canAppendCompletedTurnCandidates(idOnlyTarget)).resolves.toBe(false);
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, { ...send, contextSourceRefs: [], memoryLineageSourceIds: [] }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${material}`;
    await sql`UPDATE opening_turns SET context_anchor=NULL WHERE id=${pending.turnId}`;
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [b.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ purpose: "learning_help", courseId: courseA.id })} WHERE id=${pending.turnId}`;

    const record = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, querySystem: true,
      text: "What did I study?", mode: "explain", sourceIds: [], clientKey: randomUUID(),
      learningSessionId: null, currentPage: null, chunkId: null });
    const recordClaim = (await jobs.claim(record.jobId))!;
    const completion: Parameters<typeof jobs.completeTurn>[0] = {
      scope, jobId: record.jobId, assistantTurnId: record.assistantTurnId, claimToken: recordClaim.claimToken,
      text: "Saved record response", citations: [], candidates: [], contextSourceRefs: [],
      systemQuery: { authorization: { purpose: "system_record_lookup", workspaceId: scope.workspaceId,
        principalId: scope.ownerUserId, role: "workspace_owner", permissionRevision: "1" },
      version: "study-query-v1", asOf: new Date().toISOString(), privacyEpoch: publication.privacyEpoch,
      mode: "deterministic", status: "ok", reason: "read", results: [] },
    };
    await expect(jobs.completeTurn({ ...completion, contextSourceRefs: [sourceRef] }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.completeTurn({ ...completion, contextSourceRefs: [{ memoryDependencyIds: [a.id] }] as never }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await jobs.get(scope, record.jobId)).toMatchObject({ status: "running" });
    await expect(jobs.completeTurn(completion, { globalMemoryIds: [b.id] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.completeTurn(completion, { globalMemoryIds: [a.id] })).resolves.toBeUndefined();
    expect(await jobs.get(scope, record.jobId)).toMatchObject({ status: "succeeded" });

    await courses.setArchived({ ...scope, courseId: courseA.id, archived: true });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(false);
  }, 15_000);

  it.each(["archive", "remove membership"] as const)("rechecks metadata after a concurrent course change (%s)", async change => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const memories = createOpeningMemoryRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Metadata race", slug: randomUUID() });
    const material = await source();
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id,
      assetType: "source", assetId: material, role: "core", visibility: "course", purpose: "teaching" });
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const candidate = await memories.proposeMemory(scope, { courseId: course.id, text: "Course evidence",
      sourceTurnIds: [origin], expiresAt: null });
    const memory = await memories.confirm(scope, candidate.id, candidate.version, randomUUID());
    const conversation = await conversations.create(scope, { title: "Metadata context", courseId: course.id });
    const saved = await append(conversation.id);
    const claim = (await jobs.claim(saved.jobId))!;
    const target = { scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claim.claimToken };
    await jobs.completeTurn({ ...target, text: "Saved answer", citations: [], candidates: [], contextSourceRefs: [] },
      { globalMemoryIds: [memory.id] });

    const writer = openRaceSession();
    const metadata = openRaceSession();
    const changed = deferred();
    const release = deferred();
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([writer.ready, metadata.ready]);
      const mutation = track(writer.sql.begin(async tx => {
        if (change === "archive") {
          await tx`UPDATE courses SET archived_at=now() WHERE id=${course.id} AND workspace_id=${scope.workspaceId}`;
        } else {
          await tx`DELETE FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
            AND course_id=${course.id} AND asset_type='source' AND asset_id=${material}`;
        }
        changed.resolve();
        await release.promise;
      }));
      pending.push(mutation);
      await Promise.race([changed.promise, mutation]);
      const reader = createOpeningTutorJobsRepository(metadata.sql);
      const startSend = vi.fn(async () => true);
      const check = track(change === "archive"
        ? reader.authorizeMetadataSend(target, startSend)
        : reader.appendCompletedTurnCandidates({ ...target, candidates: [{ kind: "memory", text: "Candidate", temporary: false }] }));
      pending.push(check);
      await waitUntilBlocked(sql, metadata.pid, writer.pid, change,
        change === "archive" ? /FROM courses/ : /FROM course_asset_memberships/);
      release.resolve();
      await mutation;
      if (change === "archive") {
        await expect(check).rejects.toThrow("tutor metadata authorization changed");
        expect(startSend).not.toHaveBeenCalled();
      } else {
        await expect(check).resolves.toBe(false);
      }
      const savedCandidates = await sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${saved.assistantTurnId}`;
      expect(savedCandidates).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await Promise.all([closeRace(writer.sql), closeRace(metadata.sql)]);
    }
  }, 15_000);

  it.each(["assistant", "paired user"] as const)("requires an owned standalone %s binding for legacy memory backing", async binding => {
    const { sql, scope, otherScope } = f;
    const material = await source();
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const memories = createOpeningMemoryRepository(sql);
    const proposed = await memories.proposeMemory(scope, { text: "Independent global backing", sourceTurnIds: [origin], expiresAt: null });
    const memory = await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    const conversation = await createOpeningConversationRepository(sql).create(scope, { title: "Legacy exchange", courseId: null });
    const prior = await append(conversation.id);
    const jobs = createOpeningTutorJobsRepository(sql);
    const claim = (await jobs.claim(prior.jobId))!;
    const target = { scope, jobId: prior.jobId, assistantTurnId: prior.assistantTurnId, claimToken: claim.claimToken };
    await jobs.completeTurn({ ...target, text: "Legacy answer", citations: [], candidates: [], contextSourceRefs: [] });
    await sql`UPDATE opening_turns SET context_source_refs=${sql.json([{ sourceId: material, sourceVersion: 0, memoryOnly: true }])}
      WHERE id=${prior.assistantTurnId}`;
    await sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${prior.turnId}`;
    const next = await append(conversation.id);
    const history = () => jobs.loadHistoryContext(scope, next.turnId);
    const active = () => readTurnsWithActiveMemoryDependencies(sql, scope.workspaceId, [prior.assistantTurnId]);
    const insertSession = async (sessionScope: typeof scope) => {
      const id = randomUUID();
      const activityId = await insertTestTeachingActivity(sql, sessionScope);
      await sql`INSERT INTO opening_learning_sessions (id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
        VALUES (${id},${sessionScope.workspaceId},${sessionScope.ownerUserId},NULL,${activityId},'Course-less')`;
      return id;
    };
    const turnId = binding === "assistant" ? prior.assistantTurnId : prior.turnId;
    const bind = (id: string) => sql`UPDATE opening_turns SET learning_session_id=${id} WHERE id=${turnId}`;
    const expectUsable = async () => {
      await expect(history()).resolves.toMatchObject({ memoryIds: [memory.id] });
      await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
      await expect(active()).resolves.toEqual(new Set([prior.assistantTurnId]));
    };
    await expectUsable();
    await bind(await insertSession(scope));
    await expectUsable();
    const unresolved = [randomUUID(), await insertSession({ ...scope, ownerUserId: otherScope.ownerUserId }),
      await insertSession({ ...scope, workspaceId: otherScope.workspaceId })];
    for (const id of unresolved) {
      await bind(id);
      await expect(history()).resolves.toEqual({ history: [], sourceRefs: [] });
      await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(false);
      await expect(active()).resolves.toEqual(new Set());
    }
  }, 15_000);

  it("tracks legacy backing below a named memory across metadata, history, and memory context", async () => {
    const { sql, scope } = f;
    const memories = createOpeningMemoryRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const material = await source();
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [material] });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const temporary = await memories.proposeMemory(scope, { text: "Temporary backing", sourceTurnIds: [origin], expiresAt });
    const legacyTurn = await insertOwnedTurn(sql, scope, {
      role: "assistant", contextSourceRefs: [{ sourceId: material, sourceVersion: 0, memoryOnly: true }],
    });
    const proposed = await memories.proposeMemory(scope, { text: "Named memory", sourceTurnIds: [legacyTurn], expiresAt: null });
    const named = await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    const mockExam = await source();
    const courses = createCourseMembershipRepository(sql);
    const examCourse = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Exam material", slug: randomUUID() });
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: examCourse.id,
      assetType: "source", assetId: mockExam, role: "core", visibility: "course", purpose: "mock_exam" });
    const disallowedOrigin = await insertOwnedTurn(sql, scope, { sourceIds: [material, mockExam] });
    await sql`INSERT INTO opening_memories (id, workspace_id, kind, text, source_turn_ids)
      VALUES ('00000000-0000-4000-8000-000000000001', ${scope.workspaceId}, 'confirmed', 'Disallowed backing',
        ${sql.json([disallowedOrigin])})`;
    const conversation = await conversations.create(scope, { title: "Indirect legacy lineage", courseId: null });
    const prior = await append(conversation.id);
    const claim = (await jobs.claim(prior.jobId))!;
    await jobs.completeTurn({ scope, jobId: prior.jobId, assistantTurnId: prior.assistantTurnId, claimToken: claim.claimToken,
      text: "Answer from the named memory", citations: [], candidates: [], contextSourceRefs: [] }, { globalMemoryIds: [named.id] });
    await sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${prior.turnId}`;
    const next = await append(conversation.id);
    const target = { scope, jobId: prior.jobId, assistantTurnId: prior.assistantTurnId, claimToken: claim.claimToken };
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
    await expect(jobs.loadHistoryContext(scope, next.turnId)).resolves.toMatchObject({
      memoryIds: [temporary.id, named.id].sort(), temporaryMemoryExpiresAt: expiresAt,
    });
    await expect(memories.listContext(scope, new Date().toISOString())).resolves.toMatchObject({
      memories: expect.arrayContaining([expect.objectContaining({ id: named.id })]),
      dependencyMemoryIds: [temporary.id], temporaryMemoryExpiresAt: expiresAt,
    });
    await sql`UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${temporary.id}`;
    await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(false);
    await expect(jobs.loadHistoryContext(scope, next.turnId)).resolves.toEqual({ history: [], sourceRefs: [] });
    await expect(memories.listContext(scope, new Date().toISOString())).resolves.toEqual({ memories: [], sourceRefs: [] });
  });

  it("carries material through a memory into another conversation and filters its later history", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const memories = createOpeningMemoryRepository(f.sql);
    const firstConversation = await conversations.create(f.scope, { title: "first", courseId: null });
    // Exercise inherited provenance from material actually selected for the model.
    const first = await append(firstConversation.id, [id], "Explain ancestor material");
    const firstCall = handler("first-secret-answer", "first-secret-memory");
    await firstCall.run(first.jobId);
    expect(firstCall.calls[0]?.chunks).toEqual([expect.objectContaining({ sourceId: id, sourceVersion: 0 })]);
    const confirm = async (turnId: string) => {
      const rows = await f.sql<{ id: string }[]>`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${turnId}`;
      return memories.decideMemoryCandidate(f.scope, { id: rows[0]!.id,
        action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID() });
    };
    const firstMemory = await confirm(first.assistantTurnId);
    const secondConversation = await conversations.create(f.scope, { title: "second", courseId: null });
    const second = await append(secondConversation.id);
    const secondCall = handler("second-secret-answer", "second-secret-memory");
    await secondCall.run(second.jobId);
    expect(secondCall.calls[0]?.instruction).toContain("first-secret-memory");
    expect(secondCall.calls[0]?.history).toEqual([]);
    expect(secondCall.calls[0]?.chunks).toEqual([]);
    const secondMemory = await confirm(second.assistantTurnId);
    const refs = await f.sql<{ context_source_refs: unknown; source_ids: string[]; citations: unknown[] }[]>`
      SELECT context_source_refs, source_ids, citations FROM opening_turns WHERE id=${second.assistantTurnId}`;
    expect(refs[0]).toEqual({
      context_source_refs: [
        { sourceId: id, sourceVersion: 0, memoryOnly: true },
        { memoryDependencyIds: [firstMemory.id] },
      ],
      source_ids: [],
      citations: [],
    });
    const receipt = await memories.deleteMemory(f.scope, {
      id: secondMemory.id, expectedVersion: secondMemory.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    expect(receipt.excludedSourceIds).toEqual([id]);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${second.turnId},${second.assistantTurnId})`;
    const third = await append(secondConversation.id);
    const thirdCall = handler("safe-new-answer");
    await thirdCall.run(third.jobId);
    expect(thirdCall.calls[0]?.history).toEqual([]);
    expect(thirdCall.calls[0]?.instruction).not.toContain("secret-memory");
    expect(await memories.listContext(f.scope, new Date().toISOString())).toEqual({ memories: [], sourceRefs: [] });
    const kept = await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${second.assistantTurnId}`;
    expect(kept[0]?.text).toBe("second-secret-answer");
  });

  it("rejects candidate confirmation after an inherited source is excluded", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "pending", courseId: null });
    const first = await append(conversation.id, [id]);
    await handler("secret-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    await handler("derived", "pending-secret-memory").run(second.jobId);
    const candidates = await f.sql<{ id: string; source_ids: string[] }[]>`SELECT id,source_ids FROM opening_assistant_candidates WHERE source_turn_id=${second.assistantTurnId}`;
    expect(candidates[0]?.source_ids).toEqual([id]);
    const memories = createOpeningMemoryRepository(f.sql);
    const marker = await memories.proposeMemory(f.scope, { text: "marker", sourceTurnIds: [first.turnId], expiresAt: null });
    await memories.deleteMemory(f.scope, { id: marker.id, expectedVersion: marker.version, deleteSourceText: false, clientKey: randomUUID() });
    await expect(memories.decideMemoryCandidate(f.scope, { id: candidates[0]!.id,
      action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID() })).rejects.toThrow(/excluded/);
    expect(await memories.get(f.scope, candidates[0]!.id)).toBeNull();
  });

  it("quarantines unknown old assistant history and memories without erasing their text", async () => {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "legacy", courseId: null });
    const old = await append(conversation.id);
    await f.sql`UPDATE opening_turns SET status='complete', text='legacy-secret', context_source_refs=NULL,
      created_at=now()-interval '1 hour' WHERE id=${old.assistantTurnId}`;
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${old.turnId}`;
    const memories = createOpeningMemoryRepository(f.sql);
    const proposed = await memories.proposeMemory(f.scope, { text: "legacy-memory", sourceTurnIds: [old.assistantTurnId], expiresAt: null });
    await memories.confirm(f.scope, proposed.id, proposed.version, randomUUID());
    const follow = await append(conversation.id);
    const call = handler("fresh");
    await call.run(follow.jobId);
    expect(call.calls[0]?.history).toEqual([]);
    expect(call.calls[0]?.instruction).not.toContain("legacy-memory");
    expect((await memories.list(f.scope)).map((item) => item.text)).toContain("legacy-memory");
    expect((await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${old.assistantTurnId}`)[0]?.text).toBe("legacy-secret");
    const persisted = await f.sql<{ context_source_refs: unknown }[]>`SELECT context_source_refs FROM opening_turns WHERE id=${follow.assistantTurnId}`;
    expect(persisted[0]?.context_source_refs).toEqual([]);
  });

  it("keeps new source-free exchanges available for continuation", async () => {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "free", courseId: null });
    const first = await append(conversation.id);
    await handler("source-free-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    const next = handler("continued");
    await next.run(second.jobId);
    expect(next.calls[0]?.history).toContainEqual({ role: "assistant", text: "source-free-answer" });
  });
  it("excludes a memory derived from source-free uncited history after its ancestor is excluded", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "lineage", courseId: null });
    const first = await append(conversation.id, [id]);
    await handler("ancestor-secret-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour'
      WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    const generated = handler("inherited-answer", "inherited-secret-memory");
    await generated.run(second.jobId);
    expect(generated.calls[0]?.history).toContainEqual({ role: "assistant", text: "ancestor-secret-answer" });
    expect(generated.calls[0]?.chunks).toEqual([]);
    const candidates = await f.sql<{ id: string }[]>`SELECT id FROM opening_assistant_candidates
      WHERE source_turn_id=${second.assistantTurnId}`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.decideMemoryCandidate(f.scope, {
      id: candidates[0]!.id, action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID(),
    });
    expect((await memories.listForContext(f.scope)).map((item) => item.id)).toContain(memory.id);
    const marker = await memories.proposeMemory(f.scope, {
      text: "delete ancestor", sourceTurnIds: [first.turnId], expiresAt: null,
    });
    await memories.deleteMemory(f.scope, {
      id: marker.id, expectedVersion: marker.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    expect((await memories.listForContext(f.scope)).map((item) => item.id)).not.toContain(memory.id);
    const original = await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${first.assistantTurnId}`;
    expect(original[0]?.text).toBe("ancestor-secret-answer");
  });
});
