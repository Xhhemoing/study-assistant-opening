import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCourseMembershipRepository, createOpeningConversationRepository, createOpeningMemoryRepository, createOpeningPrivacyRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";
import { admitTaskCandidate, assertTaskCandidateMemoryDependencies } from "../../packages/database/src/repositories/opening-task-candidate-admission";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`TRUNCATE opening_privacy_exclusions RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await f?.close(); });
async function seed() {
  const repo = createOpeningConversationRepository(f.sql);
  const c = await repo.create(f.scope, { title: "history", courseId: null });
  const append = (text: string) => repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text, mode: "hint", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const prior = await append("previous question");
  await f.sql`UPDATE opening_turns SET created_at = now() - interval '1 hour' WHERE id IN (${prior.turnId}, ${prior.assistantTurnId})`;
  await f.sql`UPDATE opening_turns SET status='complete', text='step two', context_source_refs='[]'::jsonb WHERE id=${prior.assistantTurnId}`;
  const current = await append("continue");
  return { repo, c, prior, current, append, jobs: createOpeningTutorJobsRepository(f.sql) };
}
it("loads only prior completed exchanges in the owned conversation", async () => {
  const { current, jobs, prior } = await seed();
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }]);
  expect(await jobs.loadHistory(f.otherScope, current.turnId)).toEqual([]);
  await f.sql`UPDATE opening_turns SET status='pending' WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("clears derived history when an earlier source was revoked or its cited version changed", async () => {
  const { current, jobs, prior } = await seed();
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES (${id},${f.scope.workspaceId},'a.pdf','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${id}]::uuid[], source_versions=jsonb_build_object(${id}::text,0) WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${id}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`UPDATE opening_sources SET upload_state='uploaded', version=1 WHERE id=${id}`;
  await f.sql`UPDATE opening_turns SET citations=${f.sql.json([{ sourceId: id, sourceVersion: 0 }])} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("accepts dependency metadata only in context refs and clears history on malformed citations in either turn", async () => {
  const { current, jobs, prior } = await seed();
  const memories = createOpeningMemoryRepository(f.sql);
  const active = await memories.proposeMemory(f.scope, {
    text: "Valid history dependency", sourceTurnIds: [await insertOwnedTurn(f.sql, f.scope)],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const rejected = await memories.proposeMemory(f.scope, { text: "Rejected history dependency", sourceTurnIds: [prior.turnId], expiresAt: null });
  await memories.reject(f.scope, rejected.id, rejected.version, randomUUID());
  const sourceId = await insertSource(f.sql, f.scope);
  const refs = [{ memoryDependencyIds: [active.id] }];
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json(refs)} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toMatchObject({ memoryIds: [active.id] });

  for (const turnId of [prior.assistantTurnId, prior.turnId]) {
    for (const citations of [[{ memoryDependencyIds: [rejected.id] }], { sourceId, sourceVersion: 0 }]) {
      await f.sql`UPDATE opening_turns SET citations=${f.sql.json(citations)} WHERE id=${turnId}`;
      expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toEqual({ history: [], sourceRefs: [] });
      expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
    }
    await f.sql`UPDATE opening_turns SET citations='[]'::jsonb WHERE id=${turnId}`;
  }
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
});
it("clears derived history when a referenced source is privacy-excluded", async () => {
  const { current, jobs, prior } = await seed();
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES (${id},${f.scope.workspaceId},'a.pdf','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${id}]::uuid[], source_versions=jsonb_build_object(${id}::text,0) WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${id}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});
it("clears history for an excluded current source or citation-only source, not another workspace", async () => {
  const { current, jobs, prior } = await seed();
  const currentSource = randomUUID();
  const cited = randomUUID();
  const foreign = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
    (${currentSource},${f.scope.workspaceId},'current.pdf','application/pdf',1,${'b'.repeat(64)},0,'uploaded','ready'),
    (${cited},${f.scope.workspaceId},'cited.pdf','application/pdf',1,${'c'.repeat(64)},0,'uploaded','ready'),
    (${foreign},${f.otherScope.workspaceId},'foreign.pdf','application/pdf',1,${'d'.repeat(64)},0,'uploaded','ready')`;
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${currentSource}]::uuid[] WHERE id=${current.turnId}`;
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${currentSource}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${currentSource}`;
  await f.sql`UPDATE opening_turns SET source_ids='{}', citations=${f.sql.json([{ sourceId: cited, sourceVersion: 0 }])} WHERE id=${prior.assistantTurnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${cited}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${cited}`;
  await f.sql`INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at) VALUES (${randomUUID()}, ${f.otherScope.workspaceId}, ${foreign}, NULL, now())`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toHaveLength(2);
});
it("bounds history by whole exchanges and excludes oversized recent turns", async () => {
  const { current, jobs, prior } = await seed();
  await f.sql`UPDATE opening_turns SET text=${'x'.repeat(12001)} WHERE id=${prior.turnId}`;
  expect(await jobs.loadHistory(f.scope, current.turnId)).toEqual([]);
});

it.each(["exchange count", "character budget", "current scope"] as const)(
  "preserves older course and expiry authority outside the %s",
  async limit => {
    const { sql, scope } = f;
    const { jobs, prior, current, append } = await seed();
    const courses = createCourseMembershipRepository(sql);
    const origin = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Origin", slug: randomUUID() });
    const destination = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Destination", slug: randomUUID() });
    const sourceId = await insertSource(sql, scope);
    const ref = { sourceId, sourceVersion: 0 };
    for (const course of limit === "current scope" ? [origin] : [origin, destination]) {
      await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source",
        assetId: sourceId, role: "core", visibility: "course", purpose: "teaching" });
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
      text: "Older input", sourceTurnIds: [await insertOwnedTurn(sql, scope)], expiresAt,
    });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: origin.id })} WHERE id=${prior.turnId}`;
    await sql`UPDATE opening_turns SET citations=${sql.json([ref])},
      context_source_refs=${sql.json([{ memoryDependencyIds: [memory.id] }])},
      text=${limit === "character budget" ? "x".repeat(12_000) : "Older answer"} WHERE id=${prior.assistantTurnId}`;
    const retained = limit === "exchange count" ? 20 : 1;
    for (let index = 0; index < retained; index++) {
      const derivative = await append(`Follow-up ${index}`);
      await sql`UPDATE opening_turns SET created_at=now()-make_interval(mins=>${30 - index})
        WHERE id=${derivative.turnId}`;
      await sql`UPDATE opening_turns SET status='complete',text='Derived answer',context_source_refs='[]' WHERE id=${derivative.assistantTurnId}`;
    }
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: destination.id })} WHERE id=${current.turnId}`;
    const history = await jobs.loadHistoryContext(scope, current.turnId);
    expect(history.history).toHaveLength(retained * 2);
    expect(history.sourceRefs).toEqual([]);
    expect(history.temporaryMemoryExpiresAt).toBe(expiresAt);
    expect(history.historyCourseBindings).toContainEqual({
      courseId: origin.id, materialUse: "citation", sourceIds: [sourceId], sourceRefs: [ref], memoryIds: [memory.id],
    });
    const claim = (await jobs.claim(current.jobId))!;
    const authorization = { claimToken: claim.claimToken, executionId: claim.executionId,
      contextSourceRefs: history.sourceRefs, historyCourseBindings: history.historyCourseBindings };
    await expect(jobs.assertSendAuthorized(scope, current.jobId, authorization)).resolves.toBeUndefined();
    await courses.setArchived({ ...scope, courseId: origin.id, archived: true });
    await expect(jobs.assertSendAuthorized(scope, current.jobId, authorization)).rejects.toMatchObject({ code: "CONFLICT" });
  },
);

it("preserves an earlier independent exchange at the same timestamp as the cutoff", async () => {
  const { sql, scope } = f;
  const { jobs, prior, current, append } = await seed();
  const extra = await append("Third exchange");
  const ordered = [prior, current, extra].sort((left, right) => left.turnId.localeCompare(right.turnId));
  const [earlier, invalid, target] = ordered;
  const sourceId = await insertSource(sql, scope);
  await sql`UPDATE opening_turns SET created_at='2026-01-01T12:00:00Z'
    WHERE id=ANY(${ordered.map(exchange => exchange.turnId)}::uuid[])`;
  await sql`UPDATE opening_turns SET status='complete', text='Independent same-time answer',context_source_refs='[]'
    WHERE id=${earlier!.assistantTurnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Unversioned',context_source_refs='[]',source_ids=ARRAY[${sourceId}]::uuid[]
    WHERE id=${invalid!.assistantTurnId}`;
  const history = await jobs.loadHistory(scope, target!.turnId);
  expect(history).toHaveLength(2);
  expect(history[1]).toEqual({ role: "assistant", text: "Independent same-time answer" });
});

it("keeps the independent prefix when a later exchange's backing memory loses its version", async () => {
  const { sql, scope } = f;
  const { jobs, current, append } = await seed();
  const sourceId = await insertSource(sql, scope);
  const origin = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId], contextSourceRefs: [{ sourceId, sourceVersion: 0 }],
    role: "assistant" });
  const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
    text: "Versioned backing", sourceTurnIds: [origin], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  for (const [minutes, refs] of [[45, [{ memoryDependencyIds: [memory.id] }]], [30, []]] as const) {
    const exchange = await append("Follow-up");
    await sql`UPDATE opening_turns SET created_at=now()-make_interval(mins=>${minutes}) WHERE id=${exchange.turnId}`;
    await sql`UPDATE opening_turns SET status='complete',text='Derived',context_source_refs=${sql.json(refs as never)}
      WHERE id=${exchange.assistantTurnId}`;
  }
  expect(await jobs.loadHistory(scope, current.turnId)).toHaveLength(6);
  await sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
  expect(await jobs.loadHistory(scope, current.turnId)).toEqual([
    { role: "user", text: "previous question" }, { role: "assistant", text: "step two" },
  ]);
});

it("rejects source-free metadata when the assistant's own session course is archived", async () => {
  const { sql, scope } = f;
  const { jobs, prior } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Assistant origin", slug: randomUUID() });
  const sessionId = randomUUID();
  const activity = await insertTestTeachingActivity(sql, scope, course.id);
  await sql`INSERT INTO opening_learning_sessions (id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
    VALUES (${sessionId},${scope.workspaceId},${scope.ownerUserId},${course.id},${activity},'Metadata')`;
  await sql`UPDATE opening_turns SET learning_session_id=${sessionId} WHERE id=${prior.assistantTurnId}`;
  await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${prior.jobId}`;
  const target = { scope, jobId: prior.jobId, assistantTurnId: prior.assistantTurnId };
  expect(await jobs.canAppendCompletedTurnCandidates(target)).toBe(true);
  await courses.setArchived({ ...scope, courseId: course.id, archived: true });
  const callback = vi.fn(async () => {});
  await expect(jobs.authorizeMetadataSend(target, callback)).rejects.toThrow("authorization changed");
  await expect(jobs.appendCompletedTurnCandidates({ ...target, candidates: [] })).resolves.toBe(false);
  expect(callback).not.toHaveBeenCalled();
});

it("blocks an empty-ref saved derivative from memory and task admission after origin archive", async () => {
  const { sql, scope } = f;
  const { prior, current, c } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const origin = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Origin", slug: randomUUID() });
  const destination = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Destination", slug: randomUUID() });
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: origin.id })} WHERE id=${prior.turnId}`;
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: destination.id })} WHERE id=${current.turnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Derived in destination',context_source_refs='[]'
    WHERE id=${current.assistantTurnId}`;
  const memories = createOpeningMemoryRepository(sql);
  const proposal = { courseId: destination.id, text: "Derived memory", sourceTurnIds: [current.assistantTurnId], expiresAt: null };
  const memory = await memories.proposeMemory(scope, proposal);
  await memories.confirm(scope, memory.id, memory.version, randomUUID());
  const id = randomUUID();
  await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
    VALUES (${id}, ${scope.workspaceId}, ${c.id}, ${current.assistantTurnId}, '[]',
      ${sql.json({ kind: "task", title: "Follow up", minutes: 15, dueText: null })})`;
  const admit = () => sql.begin(tx => admitTaskCandidate(tx, scope, id));
  const context = () => memories.listForContext(scope, destination.id);
  expect((await context()).map(item => item.id)).toContain(memory.id);
  await expect(admit()).resolves.toBe(current.assistantTurnId);
  await courses.setArchived({ ...scope, courseId: origin.id, archived: true });
  expect((await context()).map(item => item.id)).not.toContain(memory.id);
  await expect(memories.proposeMemory(scope, proposal)).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(admit()).rejects.toMatchObject({ code: "VALIDATION" });
});

it.each(["empty", "memory-only", "conflicting", "malformed"] as const)("omits only the exchange with %s direct assistant version evidence", async evidence => {
  const { sql, scope } = f;
  const { c, current, jobs, prior, repo } = await seed();
  const older = await repo.appendSavedTurn({ scope, conversationId: c.id, text: "Independent question", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  await sql`UPDATE opening_turns SET created_at=now()-interval '2 hours' WHERE id=${older.turnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Independent answer',context_source_refs='[]'::jsonb WHERE id=${older.assistantTurnId}`;
  const sourceId = await insertSource(sql, scope);
  const ref = { sourceId, sourceVersion: 0 };
  const refs = evidence === "memory-only" ? [{ ...ref, memoryOnly: true }]
    : evidence === "conflicting" ? [{ ...ref, sourceVersion: 1 }]
      : evidence === "malformed" ? [{ ...ref, sourceVersion: "0" }] : [];
  const pins = evidence === "conflicting" ? { [sourceId]: 0 } : {};
  if (evidence === "memory-only") {
    const memories = createOpeningMemoryRepository(sql);
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId] });
    const proposed = await memories.proposeMemory(scope, { text: "Independent memory", sourceTurnIds: [origin], expiresAt: null });
    await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
  }
  await sql`UPDATE opening_turns SET source_ids=ARRAY[${sourceId}]::uuid[],
    source_versions=${sql.json(pins)},context_source_refs=${sql.json(refs)} WHERE id=${prior.assistantTurnId}`;
  await expect(jobs.loadHistoryContext(scope, current.turnId)).resolves.toEqual({
    history: [{ role: "user", text: "Independent question" }, { role: "assistant", text: "Independent answer" }], sourceRefs: [],
  });
});

it.each([false, true])("keeps the independent prefix and fences derivatives after source replacement (pinned: %s)", async pinned => {
  const { sql, scope } = f;
  const { c, current, jobs, prior, repo } = await seed();
  const sourceId = await insertSource(sql, scope);
  await sql`UPDATE opening_turns SET source_ids=ARRAY[${sourceId}]::uuid[],
    source_versions=${sql.json(pinned ? { [sourceId]: 0 } : {})} WHERE id=${prior.assistantTurnId}`;
  for (const [text, answer, minutes] of [["Independent question", "Independent answer", 120], ["Continue that answer", "Derived from the revoked material", 30]] as const) {
    const turn = await repo.appendSavedTurn({ scope, conversationId: c.id, text, mode: "hint", clientKey: randomUUID(),
      sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
    await sql`UPDATE opening_turns SET created_at=now()-make_interval(mins=>${minutes}) WHERE id=${turn.turnId}`;
    await sql`UPDATE opening_turns SET status='complete',text=${answer},context_source_refs='[]'::jsonb WHERE id=${turn.assistantTurnId}`;
    if (minutes === 30) {
      await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${turn.jobId}`;
      const target = { scope, jobId: turn.jobId, assistantTurnId: turn.assistantTurnId };
      if (pinned) await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
      await sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
      const callback = vi.fn(async () => {});
      await expect(jobs.authorizeMetadataSend(target, callback)).rejects.toThrow("authorization changed");
      await expect(jobs.appendCompletedTurnCandidates({ ...target, candidates: [] })).resolves.toBe(false);
      expect(callback).not.toHaveBeenCalled();
    }
  }
  await expect(jobs.loadHistoryContext(scope, current.turnId)).resolves.toEqual({
    history: [{ role: "user", text: "Independent question" }, { role: "assistant", text: "Independent answer" }], sourceRefs: [],
  });
});

it.each(["archive", "detach", "mock_exam"] as const)("fences origin revocation (%s) for derived history and in-flight authorization", async change => {
  const { sql, scope } = f;
  const { current, jobs, prior, repo, c } = await seed();
  const sourceId = await insertSource(sql, scope);
  const courses = createCourseMembershipRepository(sql);
  const origin = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Origin", slug: randomUUID() });
  const destination = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Destination", slug: randomUUID() });
  for (const course of [origin, destination]) {
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source", assetId: sourceId,
      role: "core", visibility: "course", purpose: "teaching" });
  }
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: origin.id })} WHERE id=${prior.turnId}`;
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: destination.id })} WHERE id=${current.turnId}`;
  await sql`UPDATE opening_turns SET citations=${sql.json([{ sourceId, sourceVersion: 0 }])}
    WHERE id=${prior.assistantTurnId}`;
  const derivative = await repo.appendSavedTurn({ scope, conversationId: c.id, text: "A follow-up in B", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  await sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes',context_anchor=${sql.json({ courseId: destination.id })}
    WHERE id=${derivative.turnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Derived in B',context_source_refs='[]'::jsonb
    WHERE id=${derivative.assistantTurnId}`;
  const history = () => jobs.loadHistoryContext(scope, current.turnId);
  const saved = await history();
  expect(saved.sourceRefs).toEqual([{ sourceId, sourceVersion: 0 }]);
  expect(saved.history).toHaveLength(4);
  const claim = (await jobs.claim(current.jobId))!;
  const authorization = { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: saved.sourceRefs,
    historyCourseBindings: saved.historyCourseBindings };
  const callback = vi.fn(async () => {});
  await jobs.authorizeSend(scope, current.jobId, authorization, callback);
  expect(callback).toHaveBeenCalledOnce();
  callback.mockClear();
  const beforeEpoch = await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope);
  const buffered = { ...authorization, exposureReceiptId: null, privacyEpoch: beforeEpoch };
  const deliver = vi.fn();
  const legacyBuffer = { claimToken: claim.claimToken, executionId: claim.executionId,
    contextSourceRefs: saved.sourceRefs, exposureReceiptId: null, privacyEpoch: beforeEpoch };
  await expect(jobs.readStream(scope, current.jobId, legacyBuffer))
    .rejects.toMatchObject({ code: "CONFLICT", message: "stream history bindings missing" });
  await expect(jobs.readStream(scope, current.jobId, legacyBuffer, deliver))
    .rejects.toMatchObject({ code: "CONFLICT", message: "stream history bindings missing" });
  expect(deliver).not.toHaveBeenCalled();
  await expect(jobs.readStream(scope, current.jobId, buffered, deliver)).resolves.toMatchObject({ status: "running" });
  expect(deliver).toHaveBeenCalledOnce();
  deliver.mockClear();
  if (change === "archive") await courses.setArchived({ ...scope, courseId: origin.id, archived: true });
  else if (change === "detach") await sql`DELETE FROM course_asset_memberships WHERE course_id=${origin.id} AND asset_id=${sourceId}`;
  else await sql`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE course_id=${origin.id} AND asset_id=${sourceId}`;
  await expect(history()).resolves.toEqual({ history: [], sourceRefs: [], revokedDirectSourceIds: [sourceId] });
  const privacyEpoch = await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope);
  await expect(jobs.authorizeSend(scope, current.jobId, authorization, callback)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.withStreamPublication(scope, current.jobId, { ...authorization, privacyEpoch }, callback))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(privacyEpoch).toBe(beforeEpoch);
  await expect(jobs.readStream(scope, current.jobId, buffered)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.readStream(scope, current.jobId, buffered, deliver)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(deliver).not.toHaveBeenCalled();
  await expect(jobs.completeTurn({ scope, jobId: current.jobId, assistantTurnId: current.assistantTurnId,
    claimToken: claim.claimToken, text: "Derived answer", citations: [], candidates: [], contextSourceRefs: saved.sourceRefs },
  { historyCourseBindings: saved.historyCourseBindings })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(callback).not.toHaveBeenCalled();
});

it("retains an assistant-only course memory and locks its omitted backing course on every delivery path", async () => {
  const { sql, scope } = f;
  const { prior, current, append, jobs } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const createCourse = (title: string) => courses.createCourse({ workspaceId: scope.workspaceId, title, slug: randomUUID() });
  const [origin, destination, backing] = await Promise.all(["Memory scope", "Destination", "Backing course"].map(createCourse));
  const sourceId = await insertSource(sql, scope);
  for (const course of [origin!, backing!]) {
    await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source",
      assetId: sourceId, role: "core", visibility: "course", purpose: "teaching" });
  }
  const sourceTurnId = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId] });
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: backing!.id })} WHERE id=${sourceTurnId}`;
  const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
    courseId: origin!.id, text: "Scoped ancestor memory", sourceTurnIds: [sourceTurnId],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: origin!.id })},
    context_source_refs=${sql.json([{ memoryDependencyIds: [memory.id] }])} WHERE id=${prior.assistantTurnId}`;
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: origin!.id })} WHERE id=${current.turnId}`;
  expect(await jobs.loadHistoryContext(scope, current.turnId)).toMatchObject({ memoryIds: [memory.id] });

  const derivative = await append("Derivative without explicit sources");
  await sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes',
    context_anchor=${sql.json({ courseId: destination!.id })} WHERE id=${derivative.turnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Derived in destination',context_source_refs='[]'
    WHERE id=${derivative.assistantTurnId}`;
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: destination!.id })} WHERE id=${current.turnId}`;
  const history = await jobs.loadHistoryContext(scope, current.turnId);
  expect(history.history.map(turn => turn.text)).toEqual(["Derivative without explicit sources", "Derived in destination"]);
  expect(history.memoryIds).toBeUndefined();
  expect(history.historyCourseBindings).toContainEqual({
    courseId: origin!.id, materialUse: "citation", sourceIds: [], sourceRefs: [], memoryIds: [memory.id],
  });

  const claim = (await jobs.claim(current.jobId))!;
  const privacyEpoch = await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope);
  const context = { privacyEpoch, claimToken: claim.claimToken, executionId: claim.executionId,
    contextSourceRefs: history.sourceRefs, historyCourseBindings: history.historyCourseBindings };
  const start = vi.fn(async () => {});
  const deliver = vi.fn();
  await jobs.authorizeSend(scope, current.jobId, context, start);
  await jobs.readStream(scope, current.jobId, { ...context, exposureReceiptId: null }, deliver);
  expect(start).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledOnce();
  start.mockClear();
  deliver.mockClear();
  await sql`DELETE FROM course_asset_memberships WHERE course_id=${backing!.id} AND asset_id=${sourceId}`;
  await expect(jobs.authorizeSend(scope, current.jobId, context, start)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.withStreamPublication(scope, current.jobId, context, start)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.readStream(scope, current.jobId, { ...context, exposureReceiptId: null }, deliver))
    .rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.completeTurn({ scope, jobId: current.jobId, assistantTurnId: current.assistantTurnId,
    claimToken: claim.claimToken, text: "Late derivative", citations: [], candidates: [], contextSourceRefs: [] },
  { historyCourseBindings: history.historyCourseBindings })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(start).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
});

it("rechecks the first task exchange's paired user course after admission", async () => {
  const { sql, scope } = f;
  const { prior, c } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const userCourse = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Task question", slug: randomUUID() });
  const assistantCourse = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Task answer", slug: randomUUID() });
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: userCourse.id })} WHERE id=${prior.turnId}`;
  await sql`UPDATE opening_turns SET context_anchor=${sql.json({ courseId: assistantCourse.id })} WHERE id=${prior.assistantTurnId}`;
  const id = randomUUID();
  await sql`INSERT INTO opening_assistant_candidates (id, workspace_id, conversation_id, source_turn_id, source_ids, payload)
    VALUES (${id}, ${scope.workspaceId}, ${c.id}, ${prior.assistantTurnId}, '[]',
      ${sql.json({ kind: "task", title: "First exchange task", minutes: 15, dueText: null })})`;
  await sql.begin(async tx => {
    const dependency = await admitTaskCandidate(tx, scope, id);
    expect(dependency).toBe(prior.assistantTurnId);
    await expect(assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, dependency)).resolves.toBeUndefined();
  });
  await courses.setArchived({ ...scope, courseId: userCourse.id, archived: true });
  await expect(sql.begin(tx => admitTaskCandidate(tx, scope, id))).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(sql.begin(tx => assertTaskCandidateMemoryDependencies(tx, scope.workspaceId, prior.assistantTurnId)))
    .rejects.toMatchObject({ code: "VALIDATION" });
});

it.each(["mock_exam", "reference"] as const)("uses pins for assistant direct sources and enforces %s on model history and send", async purpose => {
  const { sql, scope } = f;
  const { c, current, jobs, prior } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Assistant direct material", slug: randomUUID() });
  const sourceVersion = 2;
  const sourceId = await insertSource(sql, scope, "uploaded", sourceVersion);
  await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source",
    assetId: sourceId, role: "core", visibility: "course", purpose: "teaching" });
  await sql`UPDATE opening_conversations SET course_id=${course.id} WHERE id=${c.id}`;
  await sql`UPDATE opening_turns SET source_ids=ARRAY[${sourceId}]::uuid[],source_versions=${sql.json({ [sourceId]: sourceVersion })}
    WHERE id=${prior.assistantTurnId}`;
  if (purpose === "reference") {
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ itemVersionId: randomUUID() })} WHERE id=${current.turnId}`;
  }
  const history = () => jobs.loadHistoryContext(scope, current.turnId);
  const { sourceRefs } = await history();
  expect(sourceRefs).toEqual([{ sourceId, sourceVersion }]);
  const claim = (await jobs.claim(current.jobId))!;
  const send = () => jobs.assertSendAuthorized(scope, current.jobId, { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: sourceRefs });
  await expect(send()).resolves.toBeUndefined();
  await sql`UPDATE course_asset_memberships SET purpose=${purpose} WHERE course_id=${course.id} AND asset_id=${sourceId}`;
  await expect(history()).resolves.toMatchObject({ history: [], sourceRefs: [] });
  await expect(send()).rejects.toMatchObject({ code: "CONFLICT" });
});

it.each(["anchor", "citation", "direct ref", "pin plus memory ref"] as const)("resolves a direct assistant source from %s", async evidence => {
  const { sql, scope } = f;
  const { current, jobs, prior } = await seed();
  const sourceVersion = 3;
  const sourceId = await insertSource(sql, scope, "uploaded", sourceVersion);
  const ref = { sourceId, sourceVersion };
  let refs: Array<typeof ref & { memoryOnly?: boolean }> = [];
  if (evidence === "pin plus memory ref") {
    const memories = createOpeningMemoryRepository(sql);
    const origin = await insertOwnedTurn(sql, scope, { sourceIds: [sourceId] });
    const proposed = await memories.proposeMemory(scope, { text: "Backed memory", sourceTurnIds: [origin], expiresAt: null });
    await memories.confirm(scope, proposed.id, proposed.version, randomUUID());
    refs = [{ ...ref, memoryOnly: true }];
  } else if (evidence === "direct ref") {
    refs = [ref];
  }
  await sql`UPDATE opening_turns SET source_ids=ARRAY[${sourceId}]::uuid[],
    context_anchor=${evidence === "anchor" ? sql.json(ref) : null},
    citations=${sql.json(evidence === "citation" ? [ref] : [])}, context_source_refs=${sql.json(refs)},
    source_versions=${sql.json(evidence === "pin plus memory ref" ? { [sourceId]: sourceVersion } : {})}
    WHERE id=${prior.assistantTurnId}`;
  await expect(jobs.loadHistoryContext(scope, current.turnId)).resolves.toMatchObject({
    history: [{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }], sourceRefs: [ref],
  });
});

it.each(["mock_exam", "reference"] as const)("fences citation-only history after classification as %s", async purpose => {
  const { sql, scope } = f;
  const { c, current, jobs, prior } = await seed();
  const courses = createCourseMembershipRepository(sql);
  const course = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Citation replay", slug: randomUUID() });
  const sourceId = await insertSource(sql, scope);
  await courses.addAssetMembership({ workspaceId: scope.workspaceId, courseId: course.id, assetType: "source",
    assetId: sourceId, role: "core", visibility: "course", purpose: "teaching" });
  await sql`UPDATE opening_conversations SET course_id=${course.id} WHERE id=${c.id}`;
  if (purpose === "reference") {
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ itemVersionId: randomUUID() })} WHERE id=${current.turnId}`;
  }
  const citation = { sourceId, sourceVersion: 0 };
  await sql`UPDATE opening_turns SET citations=${sql.json([citation])} WHERE id=${prior.assistantTurnId}`;
  const { history, sourceRefs } = await jobs.loadHistoryContext(scope, current.turnId);
  expect(history).toContainEqual({ role: "assistant", text: "step two" });
  expect(sourceRefs).toEqual([citation]);
  expect((await jobs.loadHistoryContext(scope, current.turnId, "record_referents")).sourceRefs).toEqual([]);
  const claim = (await jobs.claim(current.jobId))!;
  const send = { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: sourceRefs };
  const callback = vi.fn(async () => {});
  await jobs.authorizeSend(scope, current.jobId, send, callback);
  expect(callback).toHaveBeenCalledOnce();
  callback.mockClear();
  await sql`UPDATE course_asset_memberships SET purpose=${purpose} WHERE course_id=${course.id} AND asset_id=${sourceId}`;

  const privacyEpoch = await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope);
  await expect(jobs.authorizeSend(scope, current.jobId, send, callback)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.withStreamPublication(scope, current.jobId, { ...send, privacyEpoch }, callback)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(jobs.completeTurn({ scope, jobId: current.jobId, assistantTurnId: current.assistantTurnId,
    claimToken: claim.claimToken, text: "Saved answer", citations: [], candidates: [], contextSourceRefs: sourceRefs }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(callback).not.toHaveBeenCalled();
  await expect(jobs.get(scope, current.jobId)).resolves.toMatchObject({ status: "running" });
});

it("skips citation-only memory for a practice turn while keeping independent history", async () => {
  const { current, c, repo, jobs } = await seed();
  const courses = createCourseMembershipRepository(f.sql);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Purpose history", slug: randomUUID() });
  await f.sql`UPDATE opening_conversations SET course_id=${course.id} WHERE id=${c.id}`;
  const sourceId = await insertSource(f.sql, f.scope);
  await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source",
    assetId: sourceId, role: "core", visibility: "course", purpose: "reference" });
  const origin = await insertOwnedTurn(f.sql, f.scope, { sourceIds: [sourceId] });
  const memory = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: course.id, text: "Reference memory", sourceTurnIds: [origin], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await f.sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes' WHERE id=${current.turnId}`;
  await f.sql`UPDATE opening_turns SET status='complete', text='reference answer',
    context_source_refs=${f.sql.json([{ memoryDependencyIds: [memory.id] }])} WHERE id=${current.assistantTurnId}`;
  const next = await repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text: "Practice next", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  expect(await jobs.loadHistory(f.scope, next.turnId)).toHaveLength(4);
  await f.sql`UPDATE opening_turns SET context_anchor=${f.sql.json({ itemVersionId: randomUUID() })} WHERE id=${next.turnId}`;
  expect(await jobs.loadHistoryContext(f.scope, next.turnId)).toEqual({
    history: [{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }], sourceRefs: [],
    historyCourseBindings: [{ courseId: course.id, materialUse: "citation", sourceIds: [], sourceRefs: [] }],
  });

  await f.sql`UPDATE opening_memories SET expires_at=now()-interval '1 second' WHERE id=${memory.id}`;
  expect(await jobs.loadHistory(f.scope, next.turnId)).toEqual([
    { role: "user", text: "previous question" }, { role: "assistant", text: "step two" },
  ]);
});

it("tracks temporary ancestors of legacy global memory-only history", async () => {
  const { current, prior, jobs } = await seed();
  const memories = createOpeningMemoryRepository(f.sql);
  const sourceId = await insertSource(f.sql, f.scope);
  const origin = await insertOwnedTurn(f.sql, f.scope);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const temporary = await memories.proposeMemory(f.scope, { text: "Temporary fact", sourceTurnIds: [origin], expiresAt });
  const sourceRef = { sourceId, sourceVersion: 0 };
  const backingTurn = await insertOwnedTurn(f.sql, f.scope, {
    role: "assistant", contextSourceRefs: [sourceRef, { memoryDependencyIds: [temporary.id] }],
  });
  const candidate = await memories.proposeMemory(f.scope, { text: "Derived global fact", sourceTurnIds: [backingTurn], expiresAt: null });
  const backing = await memories.confirm(f.scope, candidate.id, candidate.version, randomUUID());
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json([{ ...sourceRef, memoryOnly: true }])}
    WHERE id=${prior.assistantTurnId}`;

  const active = await jobs.loadHistoryContext(f.scope, current.turnId);
  expect(active.history).toHaveLength(2);
  expect(active.memoryIds).toEqual([backing.id, temporary.id].sort());
  expect(active.temporaryMemoryExpiresAt).toBe(expiresAt);
  await f.sql`UPDATE opening_memories SET expires_at=clock_timestamp() - interval '1 second' WHERE id=${temporary.id}`;
  expect(await jobs.loadHistoryContext(f.scope, current.turnId)).toEqual({ history: [], sourceRefs: [] });
});

it("blocks metadata for a source-free derivative after the earlier exchange's memory expires", async () => {
  const { sql, scope } = f;
  const { prior, current, jobs } = await seed();
  const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
    text: "Temporary context", sourceTurnIds: [await insertOwnedTurn(sql, scope)],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await sql`UPDATE opening_turns SET context_source_refs=${sql.json([{ memoryDependencyIds: [memory.id] }])}
    WHERE id=${prior.assistantTurnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Derived answer',context_source_refs='[]'::jsonb
    WHERE id=${current.assistantTurnId}`;
  await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${current.jobId}`;
  const target = { scope, jobId: current.jobId, assistantTurnId: current.assistantTurnId };
  await expect(jobs.canAppendCompletedTurnCandidates(target)).resolves.toBe(true);
  await sql`UPDATE opening_memories SET expires_at=now()-interval '1 second' WHERE id=${memory.id}`;
  const callback = vi.fn(async () => {});
  await expect(jobs.authorizeMetadataSend(target, callback)).rejects.toThrow("authorization changed");
  await expect(jobs.appendCompletedTurnCandidates({ ...target, candidates: [] })).resolves.toBe(false);
  expect(callback).not.toHaveBeenCalled();
});

it("checks the ancestor deadline after the final metadata reread", async () => {
  const { sql, scope } = f;
  const { prior, current } = await seed();
  const now = Date.now();
  const deadline = now + 60_000;
  const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
    text: "Temporary history", sourceTurnIds: [await insertOwnedTurn(sql, scope)],
    expiresAt: new Date(deadline).toISOString(),
  });
  await sql`UPDATE opening_turns SET context_source_refs=${sql.json([{ memoryDependencyIds: [memory.id] }])}
    WHERE id=${prior.assistantTurnId}`;
  await sql`UPDATE opening_turns SET status='complete',text='Derived answer',context_source_refs='[]'
    WHERE id=${current.assistantTurnId}`;
  await sql`UPDATE opening_tutor_jobs SET status='succeeded' WHERE id=${current.jobId}`;
  let targetReads = 0;
  const time = vi.spyOn(Date, "now").mockReturnValue(now);
  const tracked = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1, debug: (_connection, query) => {
    if (/^\s*WITH candidate_target AS MATERIALIZED/.test(query) && ++targetReads === 2) time.mockReturnValue(deadline);
  } });
  try {
    const jobs = createOpeningTutorJobsRepository(tracked);
    const target = { scope, jobId: current.jobId, assistantTurnId: current.assistantTurnId };
    const start = vi.fn(async () => {});
    await expect(jobs.authorizeMetadataSend(target, start)).rejects.toThrow("authorization changed");
    expect(targetReads).toBe(2);
    expect(start).not.toHaveBeenCalled();
    time.mockReturnValue(now);
    targetReads = 0;
    await expect(jobs.appendCompletedTurnCandidates({ ...target, candidates: [{ kind: "task", title: "Late" }] })).resolves.toBe(false);
    expect(targetReads).toBe(2);
    expect(await sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${current.assistantTurnId}`).toEqual([]);
  } finally {
    time.mockRestore();
    await tracked.end({ timeout: 5 });
  }
});

it("keeps course-scoped memory history only while both turns resolve to its active course", async () => {
  const { current, jobs, prior, c, repo } = await seed();
  const courses = createCourseMembershipRepository(f.sql);
  const courseA = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "History course A", slug: "history-a" });
  const courseB = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "History course B", slug: "history-b" });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const memory = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: courseA.id, text: "Course A study preference", sourceTurnIds: [prior.turnId], expiresAt,
  });
  const [source] = await f.sql<{ id: string }[]>`INSERT INTO opening_sources
    (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${randomUUID()},${f.scope.workspaceId},'notes.txt','text/plain',1,${"a".repeat(64)},0,'uploaded','ready') RETURNING id`;
  await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: courseA.id, assetType: "source",
    assetId: source!.id, role: "core", visibility: "course", purpose: "teaching" });
  await f.sql`UPDATE opening_turns SET source_ids=ARRAY[${source!.id}]::uuid[],
    source_versions=jsonb_build_object(${source!.id}::text,0) WHERE id=${prior.turnId}`;
  const refs = [{ sourceId: source!.id, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [memory.id] }];
  await f.sql`UPDATE opening_turns SET context_source_refs=${f.sql.json(refs)} WHERE id=${prior.assistantTurnId}`;
  const anchor = async (id: string, courseId: string | null) => f.sql`UPDATE opening_turns
    SET context_anchor=${courseId === null ? null : f.sql.json({ purpose: "learning_help", courseId })} WHERE id=${id}`;
  const history = () => jobs.loadHistoryContext(f.scope, current.turnId);
  const expected = { history: [{ role: "user", text: "previous question" }, { role: "assistant", text: "step two" }],
    sourceRefs: [{ sourceId: source!.id, sourceVersion: 0 }], memoryIds: [memory.id], temporaryMemoryExpiresAt: expiresAt,
    historyCourseBindings: [{ courseId: courseA.id, materialUse: "citation", sourceIds: [source!.id],
      sourceRefs: [{ sourceId: source!.id, sourceVersion: 0 }], memoryIds: [memory.id], memoryBackings: [[memory.id]] }] };

  await anchor(prior.turnId, courseA.id.toUpperCase());
  await anchor(current.turnId, courseA.id);
  expect(await history()).toEqual(expected);
  await anchor(current.turnId, null);
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await anchor(current.turnId, courseB.id);
  expect(await history()).toEqual({ history: [], sourceRefs: [] });

  const memoryB = await createOpeningMemoryRepository(f.sql).proposeMemory(f.scope, {
    courseId: courseB.id, text: "Course B study preference", sourceTurnIds: [current.turnId], expiresAt,
  });
  await f.sql`UPDATE opening_turns SET created_at=now()-interval '30 minutes' WHERE id=${current.turnId}`;
  await f.sql`UPDATE opening_turns SET status='complete', text='Course B answer',
    context_source_refs=${f.sql.json([{ memoryDependencyIds: [memoryB.id] }])} WHERE id=${current.assistantTurnId}`;
  const third = await repo.appendSavedTurn({ scope: f.scope, conversationId: c.id, text: "Continue course B", mode: "hint",
    clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  await anchor(third.turnId, courseB.id);
  expect(await jobs.loadHistoryContext(f.scope, third.turnId)).toEqual({
    history: [{ role: "user", text: "continue" }, { role: "assistant", text: "Course B answer" }],
    sourceRefs: [], memoryIds: [memoryB.id], temporaryMemoryExpiresAt: expiresAt,
    historyCourseBindings: [
      { courseId: courseB.id, materialUse: "citation", sourceIds: [], sourceRefs: [], memoryIds: [memoryB.id] },
      { courseId: courseA.id, materialUse: "citation", sourceIds: [source!.id],
        sourceRefs: [{ sourceId: source!.id, sourceVersion: 0 }], memoryIds: [memory.id], memoryBackings: [[memory.id]] },
    ],
  });
  await f.sql`UPDATE opening_memories SET status='deleted' WHERE id=${memory.id}`;
  expect(await jobs.loadHistoryContext(f.scope, third.turnId)).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET status='active' WHERE id=${memory.id}`;

  await f.sql`UPDATE opening_conversations SET course_id=${courseA.id} WHERE id=${c.id}`;
  expect(await history()).toEqual(expected);
  await f.sql`UPDATE opening_memories SET expires_at=now() - interval '1 second' WHERE id=${memory.id}`;
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET expires_at=${expiresAt}, status='deleted' WHERE id=${memory.id}`;
  expect(await history()).toEqual({ history: [], sourceRefs: [] });
  await f.sql`UPDATE opening_memories SET status='active' WHERE id=${memory.id}`;
  await courses.setArchived({ ...f.scope, courseId: courseA.id, archived: true });
  expect(await history()).toEqual({ history: [], sourceRefs: [], revokedDirectSourceIds: [source!.id] });
});
