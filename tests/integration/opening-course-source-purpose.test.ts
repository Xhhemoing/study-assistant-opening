import { randomUUID } from "node:crypto";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCourseMembershipRepository, createOpeningSourceRepository, createOpeningKnowledgeRepository, createOpeningJobRepository, createOpeningConversationRepository, createOpeningTutorJobsRepository, createOpeningSourceChunksRepository, createOpeningBudgetRepository, createOpeningStudyContextRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { POST, PATCH } from "../../apps/web/src/app/api/courses/[id]/memberships/route";
import { GET as GET_ASSETS } from "../../apps/web/src/app/api/courses/[id]/assets/route";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { createBuildCourseKnowledgeHandler } from "../../apps/worker/src/jobs/build-course-knowledge";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { courseSourcePurposeAllows } from "../../packages/contracts/src/opening/sources";
import { listReadySourceIdsForCourse, createOpeningCourseReadySourcesRepository } from "../../packages/database/src/repositories/opening-course-ready-sources";
import { readOpeningLearnerSnapshotCourses } from "../../packages/database/src/repositories/opening-learner-snapshot-read";
import { assertOpeningTeachingSourcePurposes } from "../../packages/database/src/repositories/opening-teaching-activities";
import { readCourseRouteMaterials, readCourseRouteSourceChunks } from "../../packages/database/src/repositories/opening-course-route-read";
import { resolveOpeningStudyContext } from "../../packages/database/src/repositories/opening-study-context";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { openRaceSession, closeRace, track, waitUntilBlocked } from "./opening-race-helpers";

// Uses the real contiguous migration chain via createOpeningFixture. Do not
// inject a placeholder 0109, apply 0110 in isolation, or weaken migration guards.
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

async function setup() {
  const courses = createCourseMembershipRepository(f.sql);
  const source = await createOpeningSourceRepository(f.sql).create(f.scope, {
    name: "purpose.pdf", mime: "application/pdf", bytes: 12, sha256: "a".repeat(64),
  });
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Purpose course", slug: randomUUID() });
  const input = { workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: source.id };
  const membership = await courses.addAssetMembership({ ...input, role: "optional", sortOrder: 7, visibility: "private" });
  return { courses, source, course, input, membership };
}

async function ready(sourceId: string) {
  await f.sql`UPDATE opening_sources SET upload_state='uploaded',parse_state='ready' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${sourceId},0,1,'Synthetic purpose material')`;
}

const callerConfig = { maxContextCharacters: 5000, maxOutputTokens: 256, reservedCents: 10,
  inputCentsPerMillion: 1, outputCentsPerMillion: 1 };
type CallerBarrier = "pre-send" | "stream" | "final" | "privacy-send" | "privacy-stream" | "delivery-stream" | "learner-send";
const callerOutput: ProviderOutput = { requestId: "purpose-test-provider", text: "Synthetic material answer", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1 };

async function callerFixture(kind: "saved" | "ephemeral", purpose: "teaching" | "reference" | "practice" | "mock_exam", mutatePurpose = true) {
  const seeded = await setup();
  await ready(seeded.source.id);
  const membership = await seeded.courses.updateAssetMembership({ ...seeded.input, purpose,
    expectedUpdatedAt: seeded.membership.updatedAt.toISOString() });
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100000 });
  const retrieveContext = createOpeningMaterialRetriever(f.sql, budget, null);
  const provider = { complete: vi.fn(async (_input: ProviderInput, _signal?: AbortSignal,
    _delta?: (text: string) => void | Promise<void>): Promise<ProviderOutput> => callerOutput) };
  const changePurpose = vi.fn(async () => {
    if (mutatePurpose) await seeded.courses.updateAssetMembership({ ...seeded.input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
  });
  const released = vi.fn(async (_text: string) => {});
  const learnerContext = {
    read: async () => ({ courseId: seeded.course.id, title: "Purpose learner", asOf: new Date().toISOString(),
      privacyEpoch: 0, sourceRefs: [], goal: { description: "", targetDate: null, weeklyMinutes: null },
      weaknesses: [], recentMistakes: [], observationIds: [] }),
    assertCurrent: async () => { await changePurpose(); },
  };
  const selected = { provider, modelSnapshot: { id: "test", providerId: "test", modelName: "test",
    inputCentsPerMillion: 1, outputCentsPerMillion: 1 }, inputCentsPerMillion: 1, outputCentsPerMillion: 1 };
  if (kind === "saved") {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "Purpose caller", courseId: seeded.course.id });
    const saved = await conversations.appendSavedTurn({ scope: f.scope, conversationId: conversation.id,
      text: "Explain this selected passage", mode: "explain", clientKey: randomUUID(), sourceIds: [seeded.source.id],
      learningSessionId: null, currentPage: null, chunkId: null });
    const jobs = createOpeningTutorJobsRepository(f.sql);
    return { ...seeded, provider, changePurpose, released, run: async (stage?: CallerBarrier, selector?: string) => {
      if (selector) throw new Error("saved course must come from its persisted conversation");
      if (stage === "stream" || stage === "final") provider.complete.mockImplementation(async (_input, _signal, delta) => {
        await changePurpose(); if (stage === "stream") await delta?.("must not release"); return callerOutput;
      });
      const append = vi.fn(async (_workspace: string, _job: string, text: string) => { await released(text); return 1; });
      let epochReads = 0;
      const handler = createTutorTurnHandler({ tutorJobs: jobs, chunks, budget, provider, retrieveContext, config: callerConfig,
        ...(stage === "pre-send" ? { resolveModel: async () => { await changePurpose(); return selected; } } : {}),
        ...(stage === "learner-send" ? { learnerContext } : {}),
        ...(stage === "privacy-send" ? { privacy: { getWorkspaceEpoch: async () => {
          if (++epochReads === 2) await changePurpose(); return 0;
        }, listExcludedSourceIds: async () => [] } } : {}),
        ...(stage === "stream" ? { stream: { begin: async () => {}, append } } : {}) });
      await handler(saved.jobId);
      return { append, stored: await f.sql`SELECT status,text FROM opening_turns WHERE id=${saved.assistantTurnId}` };
    }, getStored: () => f.sql`SELECT status,text FROM opening_turns WHERE id=${saved.assistantTurnId}` };
  }
  return { ...seeded, provider, changePurpose, released, run: async (stage?: CallerBarrier, selector?: string) => {
    if (stage === "stream" || stage === "final") provider.complete.mockImplementation(async (_input, _signal, delta) => {
      await changePurpose(); if (stage === "stream") await delta?.("must not release"); return callerOutput;
    });
    if (stage === "privacy-stream" || stage === "delivery-stream") provider.complete.mockImplementation(async (_input, _signal, delta) => {
      await delta?.("must not release"); return callerOutput;
    });
    let epochReads = 0;
    const append = released;
    const service = createEphemeralTutorService({ retrieveContext, chunks, provider, config: callerConfig,
      ...(stage === "learner-send" ? { learnerContext } : {}),
      sources: { listOwnedIds: async (scope, ids) => (await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${scope.workspaceId} AND id=ANY(${ids}::uuid[])`).map(row => String(row.id)) },
      privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => {
        const read = ++epochReads;
        if (stage === "privacy-send" && read === 1 || stage === "privacy-stream" && read === 2) await changePurpose();
        return 0;
      } },
      budget: { reserve: input => budget.reserve(f.scope, input), release: (id, reason) => budget.release(f.scope, id, reason),
        claimExecution: id => budget.claimExecution(f.scope, id), settle: (...args) => budget.settle(f.scope, ...args), markUnknown: id => budget.markUnknown(f.scope, id) },
      ...(stage === "delivery-stream" ? { studyContext: createOpeningStudyContextRepository(f.sql), exposures: {
        deliver: async (scope, input) => {
          const receipt = await createOpeningStudyExposureRepository(f.sql).deliver(scope, input);
          await changePurpose();
          return receipt;
        },
      } } : {}),
      ...(stage === "pre-send" ? { resolveModel: async () => { await changePurpose(); return selected; } } : {}) });
    await service.replyEphemeral(f.scope, { text: "Explain this selected passage", courseId: selector ?? seeded.course.id,
      sourceIds: [seeded.source.id], history: [], mode: "explain", clientKey: randomUUID(),
      ...(stage === "delivery-stream" ? { contextAnchor: { purpose: "material_read" as const, courseId: seeded.course.id, sourceId: seeded.source.id } } : {}) },
      undefined, stage === "stream" || stage === "privacy-stream" || stage === "delivery-stream" ? append : undefined);
    return { append, stored: [] };
  }, getStored: async () => [] };
}

describe("course source purpose storage and concurrency", () => {
  it.each(["saved", "ephemeral"] as const)("uses actual owned course membership for the %s caller and rejects explicit mock material", async kind => {
    const allowed = await callerFixture(kind, "reference");
    const result = await allowed.run();
    expect(allowed.provider.complete).toHaveBeenCalledOnce();
    expect(allowed.provider.complete.mock.calls[0]![0].chunks.map(chunk => chunk.sourceId)).toEqual([allowed.source.id]);
    if (kind === "saved") expect(result.stored[0]).toMatchObject({ status: "complete" });
    const blocked = await callerFixture(kind, "mock_exam");
    await expect(blocked.run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(blocked.provider.complete).not.toHaveBeenCalled();
    expect((await blocked.getStored())[0]?.status).not.toBe("complete");
    const practice = await callerFixture(kind, "practice");
    await practice.run();
    expect(practice.provider.complete).toHaveBeenCalledOnce();
    expect(practice.provider.complete.mock.calls[0]![0].chunks.map(chunk => chunk.sourceId)).toEqual([practice.source.id]);
  });

  it.each([
    { kind: "saved", stage: "privacy-send" },
    { kind: "saved", stage: "learner-send" },
    { kind: "ephemeral", stage: "privacy-send" },
    { kind: "ephemeral", stage: "learner-send" },
    { kind: "ephemeral", stage: "privacy-stream" },
    { kind: "ephemeral", stage: "delivery-stream" },
  ] as const)("allows unchanged membership through the real $kind/$stage await boundary", async ({ kind, stage }) => {
    const caller = await callerFixture(kind, "teaching", false);
    const result = await caller.run(stage);
    // The same barrier hooks as the race cases ran, but admission did not change.
    expect(caller.changePurpose).toHaveBeenCalledOnce();
    expect(caller.provider.complete).toHaveBeenCalledOnce();
    expect(caller.provider.complete.mock.calls[0]![0].chunks.map(chunk => chunk.sourceId)).toEqual([caller.source.id]);
    if (kind === "saved") expect(result.stored[0]).toMatchObject({ status: "complete", text: callerOutput.text });
    if (stage === "privacy-stream" || stage === "delivery-stream") expect(caller.released).toHaveBeenCalledOnce();
    if (stage === "delivery-stream") expect(await f.sql`SELECT id FROM opening_help_exposures
      WHERE workspace_id=${f.scope.workspaceId} AND context_anchor->>'sourceId'=${caller.source.id}
        AND released_at IS NOT NULL`).toHaveLength(1);
  });

  it.each(["saved", "ephemeral"] as const)("rejects the %s caller after membership removal despite its saved source selection", async kind => {
    const caller = await callerFixture(kind, "teaching");
    await caller.courses.removeAssetMembership(caller.input);
    await expect(caller.run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).not.toHaveBeenCalled();
    expect(caller.released).not.toHaveBeenCalled();
    expect((await caller.getStored())[0]?.status).not.toBe("complete");
  });

  it.each((["saved", "ephemeral"] as const).flatMap(kind => (["pre-send", "stream", "final"] as const).map(stage => ({ kind, stage }))))("blocks %s caller output after the original purpose pin changes: $kind/$stage", async ({ kind, stage }) => {
    const caller = await callerFixture(kind, "teaching");
    await expect(caller.run(stage)).rejects.toMatchObject({ code: "CONFLICT" });
    if (stage === "pre-send") expect(caller.provider.complete).not.toHaveBeenCalled();
    else expect(caller.provider.complete).toHaveBeenCalledOnce();
    expect((await caller.getStored())[0]?.status).not.toBe("complete");
    expect(caller.released).not.toHaveBeenCalled();
  });

  it.each(["saved", "ephemeral"] as const)("rechecks the same pin after the %s privacy await even when epoch stays unchanged", async kind => {
    const caller = await callerFixture(kind, "teaching");
    await expect(caller.run("privacy-send")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).not.toHaveBeenCalled();
    expect(caller.released).not.toHaveBeenCalled();
    expect((await caller.getStored())[0]?.status).not.toBe("complete");
  });

  it.each(["saved", "ephemeral"] as const)("rechecks the original pin after the %s learner-context await", async kind => {
    const caller = await callerFixture(kind, "teaching");
    await expect(caller.run("learner-send")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).not.toHaveBeenCalled();
    expect(caller.released).not.toHaveBeenCalled();
  });

  it("blocks an ephemeral delta when purpose changes inside the stream privacy await without epoch drift", async () => {
    const caller = await callerFixture("ephemeral", "teaching");
    await expect(caller.run("privacy-stream")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).toHaveBeenCalledOnce();
    expect(caller.released).not.toHaveBeenCalled();
  });

  it("rechecks the same pin after real ephemeral deliverHelp commits before releasing any delta", async () => {
    const caller = await callerFixture("ephemeral", "teaching");
    await expect(caller.run("delivery-stream")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).toHaveBeenCalledOnce();
    expect(caller.released).not.toHaveBeenCalled();
    expect(await f.sql`SELECT id FROM opening_help_exposures WHERE workspace_id=${f.scope.workspaceId}
      AND context_anchor->>'sourceId'=${caller.source.id} AND released_at IS NOT NULL`).toHaveLength(1);
  });

  it.each(["purpose-first", "completion-first"] as const)("serializes real completion with purpose updates under the same workspace lock: %s", async order => {
    const seeded = await setup(); await ready(seeded.source.id);
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { courseId: seeded.course.id, title: "Completion barrier" });
    const saved = await conversations.appendSavedTurn({ scope: f.scope, conversationId: conversation.id, text: "Explain passage",
      mode: "explain", clientKey: randomUUID(), sourceIds: [seeded.source.id], learningSessionId: null, currentPage: null, chunkId: null });
    const jobs = createOpeningTutorJobsRepository(f.sql);
    const claimed = await jobs.claim(saved.jobId);
    if (!claimed) throw new Error("expected claimed real tutor job");
    const pin = await createOpeningCourseReadySourcesRepository(f.sql).readMaterialPurposePin(f.scope, {
      courseId: seeded.course.id, materialUse: "citation", sourceIds: [seeded.source.id],
    });
    const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100000 });
    const reservation = await budget.reserve(f.scope, { requestId: `purpose-completion:${saved.jobId}`, purpose: "tutor", amountCents: 10 });
    await budget.settle(f.scope, reservation.id, 1, { resultRef: `opening_turn:${saved.assistantTurnId}` });
    const spendBefore = await f.sql`SELECT id,state,amount_cents FROM opening_budget_reservations WHERE id=${reservation.id}`;
    const first = await openRaceSession().ready, second = await openRaceSession().ready;
    let entered = () => {}, release = () => {};
    const opened = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const input = { scope: f.scope, jobId: saved.jobId, assistantTurnId: saved.assistantTurnId, claimToken: claimed.claimToken,
      text: "Complete only if still authorized", citations: [], candidates: [{ sourceIds: [seeded.source.id], payload: { kind: "memory", text: "candidate", temporary: false } }] };
    const complete = (sql: typeof f.sql) => createOpeningTutorJobsRepository(sql).completeTurn(input, { materialPurposePin: pin });
    const update = (sql: typeof f.sql) => createCourseMembershipRepository(sql).updateAssetMembership({ ...seeded.input,
      purpose: "mock_exam", expectedUpdatedAt: seeded.membership.updatedAt.toISOString() });
    const hold = track(first.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE`;
      if (order === "purpose-first") await tx`UPDATE course_asset_memberships SET purpose='mock_exam',updated_at=clock_timestamp() WHERE id=${seeded.membership.id}`;
      entered(); await gate;
    }));
    let pending: Promise<unknown> | undefined;
    try {
      await opened;
      if (order === "purpose-first") {
        pending = track(complete(second.sql));
        await waitUntilBlocked(f.sql, second.pid, first.pid, "completion workspace lock barrier");
        release(); await hold;
        await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await f.sql`SELECT status FROM opening_turns WHERE id=${saved.assistantTurnId}`)[0]!.status).toBe("pending");
        expect((await jobs.get(f.scope, saved.jobId))?.status).toBe("running");
        expect(await f.sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${saved.assistantTurnId}`).toHaveLength(0);
      } else {
        release(); await hold;
        // Hold the actual candidate INSERT after completeTurn has acquired its
        // workspace lock and asserted the original pin. No fake publication tx.
        const blocker = await openRaceSession().ready;
        let readyLock = () => {}, finish = () => {};
        const hasLock = new Promise<void>(resolve => { readyLock = resolve; });
        const finishGate = new Promise<void>(resolve => { finish = resolve; });
        const locked = track(blocker.sql.begin(async tx => {
          await tx`LOCK TABLE opening_assistant_candidates IN SHARE MODE`;
          readyLock(); await finishGate;
        }));
        let completion: Promise<unknown> | undefined;
        try {
          await hasLock;
          completion = track(complete(first.sql));
          await waitUntilBlocked(f.sql, first.pid, blocker.pid, "actual completion candidate insert after pin assertion");
          pending = track(update(second.sql));
          await waitUntilBlocked(f.sql, second.pid, first.pid, "purpose update behind actual completion transaction");
          finish(); await locked; await completion; await pending;
        } finally {
          finish(); await Promise.allSettled([locked, ...(completion ? [completion] : []), ...(pending ? [pending] : [])]);
          await closeRace(blocker.sql);
        }
        expect((await jobs.get(f.scope, saved.jobId))?.status).toBe("succeeded");
        expect(await f.sql`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${saved.assistantTurnId}`).toHaveLength(1);
      }
      expect(await f.sql`SELECT id,state,amount_cents FROM opening_budget_reservations WHERE id=${reservation.id}`).toEqual(spendBefore);
    } finally {
      release(); await Promise.allSettled([hold, ...(pending ? [pending] : [])]);
      await closeRace(first.sql); await closeRace(second.sql);
    }
  });

  it("treats an ephemeral course id only as a selector, rejecting foreign and unlinked courses", async () => {
    const caller = await callerFixture("ephemeral", "reference");
    const foreign = await createCourseMembershipRepository(f.sql).createCourse({ workspaceId: f.otherScope.workspaceId,
      title: "Foreign selector", slug: randomUUID() });
    const unlinked = await caller.courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Unlinked", slug: randomUUID() });
    for (const course of [foreign, unlinked]) await expect(caller.run(undefined, course.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(caller.provider.complete).not.toHaveBeenCalled();
  });

  it("exposes real POST/PATCH/GET with CAS, rejects metadata mutation and retains authorization", async () => {
    const runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
    setAuthRuntimeForTests(runtime);
    try {
      const { courses, source, course, input } = await setup();
      await courses.removeAssetMembership(input);
      const context = { params: Promise.resolve({ id: course.id }) };
      const request = (method: string, body?: unknown, cookie = f.cookie) => new Request(`http://localhost/api/courses/${course.id}/memberships`, {
        method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const post = await POST(request("POST", { assetType: "source", assetId: source.id, purpose: "reference", role: "optional", visibility: "private" }), context);
      expect(post.status).toBe(201);
      const created = (await post.json()).membership;
      expect(created).toMatchObject({ purpose: "reference", courseId: course.id, assetId: source.id });
      expect(created.updatedAt).toMatch(/\.\d{3}Z$/);
      const patchBody = { assetType: "source", assetId: source.id, purpose: "practice", expectedUpdatedAt: created.updatedAt };
      expect((await PATCH(request("PATCH", { ...patchBody, role: "archive" }), context)).status).toBe(400);
      expect((await PATCH(request("PATCH", patchBody, ""), context)).status).toBe(401);
      const patch = await PATCH(request("PATCH", patchBody), context);
      expect(patch.status).toBe(200);
      expect((await patch.json()).membership).toMatchObject({ purpose: "practice", role: "optional", visibility: "private" });
      const stale = await PATCH(request("PATCH", patchBody), context);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "CONFLICT" } });
      const assets = await GET_ASSETS(request("GET"), context);
      expect(assets.status).toBe(200);
      const [asset] = (await assets.json()).assets;
      expect(asset).toMatchObject({ courseId: course.id, purpose: "practice", assetId: source.id });
      expect(asset.updatedAt).toMatch(/\.\d{3}Z$/);
      expect(asset.source).not.toHaveProperty("purpose");
      expect(asset.source).not.toHaveProperty("courseId");
      const foreign = await createCourseMembershipRepository(f.sql).createCourse({ workspaceId: f.otherScope.workspaceId, title: "Private", slug: randomUUID() });
      const forbidden = await PATCH(request("PATCH", patchBody), { params: Promise.resolve({ id: foreign.id }) });
      expect(forbidden.status).toBe(404);
      expect((await courses.getMembership(input)).purpose).toBe("practice");
    } finally { setAuthRuntimeForTests(null); await runtime.close(); }
  });

  it.each([null, "teaching", "practice", "reference", "mock_exam"] as const)("enforces %s across teaching pools, explicit selections, context and planning", async purpose => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    if (purpose !== null) await courses.updateAssetMembership({ ...input, purpose, expectedUpdatedAt: membership.updatedAt.toISOString() });
    const teaching = purpose === null || purpose === "teaching";
    expect(await listReadySourceIdsForCourse(f.sql, f.scope, course.id)).toEqual(teaching ? [source.id] : []);
    const pool = createOpeningCourseReadySourcesRepository(f.sql);
    for (const use of ["teaching", "practice", "citation"] as const) {
      expect(await pool.admitSourceIds(f.scope, course.id, [source.id], use))
        .toEqual(courseSourcePurposeAllows(purpose, use) ? [source.id] : []);
    }
    const checkTeaching = () => f.sql.begin(tx => assertOpeningTeachingSourcePurposes(tx, f.scope, course.id, [source.id]));
    if (teaching) await expect(checkTeaching()).resolves.toBeUndefined();
    else await expect(checkTeaching()).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await readCourseRouteMaterials(f.sql, f.scope, course.id)).map(row => row.sourceId)).toEqual(teaching ? [source.id] : []);
    expect((await readCourseRouteSourceChunks(f.sql, f.scope, course.id)).map(row => row.sourceId)).toEqual(teaching ? [source.id] : []);
    const snapshot = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id);
    expect(snapshot?.hasUsableMaterials).toBe(teaching);
    const context = { purpose: "material_read" as const, courseId: course.id, sourceId: source.id };
    if (purpose === "mock_exam") await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context))).rejects.toMatchObject({ code: "CONFLICT" });
    else await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context))).resolves.toMatchObject({ sourceId: source.id });
    await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context, { sourceAccess: "human_read" })))
      .resolves.toMatchObject({ sourceId: source.id });
  });

  it("filters knowledge evidence and stale reads without changing the confirmed graph lifecycle", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const chunks = await knowledge.listAuthorizedChunks(f.scope, course.id);
    expect(chunks).toHaveLength(1);
    const nodeId = randomUUID();
    const sourceVersions = { [source.id]: 0 };
    const saved = await knowledge.replace(f.scope, course.id, { expectedVersion: 0, sourceVersions,
      snapshot: { courseId: course.id, version: 1, nodes: [{ id: nodeId, courseId: course.id,
        label: "Synthetic", kind: "concept", status: "needs_check", evidenceChunkIds: [chunks[0]!.id] }], edges: [] } });
    await knowledge.confirmNode(f.scope, course.id, nodeId, { expectedVersion: saved.version, sourceVersions });
    const before = await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${course.id}`;
    const confirmations = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`;
    const changed = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    expect(await knowledge.listAuthorizedChunks(f.scope, course.id)).toEqual([]);
    expect(await knowledge.get(f.scope, course.id)).toBeNull();
    expect(await knowledge.getForRebuild(f.scope, course.id)).toEqual({ version: saved.version + 1,
      snapshot: { courseId: course.id, version: saved.version + 1, nodes: [], edges: [] }, sourceVersions: {}, nodeDefinitions: {} });
    await expect(knowledge.assertExtractionBatch(f.scope, course.id, chunks)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${course.id}`).toEqual(before);
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toEqual(confirmations);
    await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: changed.updatedAt.toISOString() });
    expect((await knowledge.get(f.scope, course.id))?.snapshot.nodes[0]?.status).toBe("supported");
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toEqual(confirmations);
  });

  it.each(["practice", "reference", "mock_exam"] as const)("rebuilds A+B to B using the real CAS version after A becomes %s", async purpose => {
    const { courses, source: a, course, input, membership } = await setup();
    const b = await createOpeningSourceRepository(f.sql).create(f.scope, {
      name: "allowed-b.pdf", mime: "application/pdf", bytes: 12, sha256: "b".repeat(64),
    });
    await courses.addAssetMembership({ ...input, assetId: b.id, role: "core", visibility: "private" });
    await ready(a.id); await ready(b.id);
    await f.sql`UPDATE opening_source_chunks SET text='Restricted A definition' WHERE source_id=${a.id}`;
    await f.sql`UPDATE opening_source_chunks SET text='Allowed B definition' WHERE source_id=${b.id}`;
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const chunks = await knowledge.listAuthorizedChunks(f.scope, course.id);
    const aChunk = chunks.find(chunk => chunk.sourceId === a.id)!;
    const bChunk = chunks.find(chunk => chunk.sourceId === b.id)!;
    const aNodeId = randomUUID(), bNodeId = randomUUID();
    const versions = { [a.id]: 0, [b.id]: 0 };
    const original = await knowledge.replace(f.scope, course.id, { expectedVersion: 0, sourceVersions: versions,
      snapshot: { courseId: course.id, version: 1, nodes: [
        { id: aNodeId, courseId: course.id, label: "Restricted A", kind: "concept", status: "needs_check", evidenceChunkIds: [aChunk.id] },
        { id: bNodeId, courseId: course.id, label: "Allowed B", kind: "concept", status: "needs_check", evidenceChunkIds: [bChunk.id] },
      ], edges: [] } });
    const confirmedA = await knowledge.confirmNode(f.scope, course.id, aNodeId, { expectedVersion: original.version, sourceVersions: versions });
    const confirmed = await knowledge.confirmNode(f.scope, course.id, bNodeId, { expectedVersion: confirmedA.version, sourceVersions: versions });
    const receipts = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`;
    expect(receipts).toHaveLength(2);
    const changed = await courses.updateAssetMembership({ ...input, purpose, expectedUpdatedAt: membership.updatedAt.toISOString() });
    const safe = await knowledge.getForRebuild(f.scope, course.id);
    expect(safe?.version).toBe(confirmed.version);
    expect(safe?.snapshot.nodes.map(node => node.id)).toEqual([bNodeId]);
    expect(Object.keys(safe!.nodeDefinitions)).toEqual([bNodeId]);
    expect(JSON.stringify(safe)).not.toContain("Restricted A");
    expect(safe?.sourceVersions).toEqual({ [b.id]: 0 });
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toEqual(receipts);
    const provider = { complete: vi.fn(async (_input: ProviderInput) => ({ text: JSON.stringify({ nodes: [{ label: "Allowed B", kind: "concept",
      evidenceChunkIds: [bChunk.id], status: "supported" }], edges: [] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1 })) };
    const replace = vi.fn(knowledge.replace.bind(knowledge));
    const handler = createBuildCourseKnowledgeHandler({
      get: (scope, id) => knowledge.getForRebuild(scope, id),
      listAuthorizedChunks: (scope, id) => knowledge.listAuthorizedChunks(scope, id),
      listReferencedNodeIds: (scope, id) => knowledge.listReferencedNodeIds(scope, id),
      replace, provider,
    });
    const queued = await knowledge.enqueueRebuild(f.scope, course.id, { clientKey: randomUUID() });
    const job = await createOpeningJobRepository(f.sql).claim(queued.jobId);
    if (!job) throw new Error("Expected real rebuild job claim");
    const rebuilt = await handler(job, job.payload);
    expect(provider.complete).toHaveBeenCalledOnce();
    const sent = provider.complete.mock.calls[0]!;
    expect(JSON.stringify(sent)).not.toContain("Restricted A");
    expect(JSON.stringify(sent)).not.toContain(aChunk.id);
    expect(JSON.stringify(sent)).toContain("Allowed B definition");
    expect(replace.mock.calls[0]![2].expectedVersion).toBe(confirmed.version);
    expect(rebuilt.version).toBe(confirmed.version + 1);
    expect(rebuilt.snapshot.nodes).toHaveLength(1);
    expect(rebuilt.snapshot.nodes[0]).toMatchObject({ id: bNodeId, label: "Allowed B", evidenceChunkIds: [bChunk.id], status: "needs_check" });
    expect((await knowledge.get(f.scope, course.id))?.sourceVersions).toEqual({ [b.id]: 0 });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toHaveLength(0);
    await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: changed.updatedAt.toISOString() });
    expect((await knowledge.get(f.scope, course.id))?.snapshot.nodes).toEqual(rebuilt.snapshot.nodes);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toHaveLength(0);
    await expect(knowledge.replace(f.scope, course.id, { expectedVersion: 0, sourceVersions: { [b.id]: 0 },
      snapshot: rebuilt.snapshot })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([null, "teaching", "practice", "reference", "mock_exam"] as const)("retrieves explicit material only for admitted course/use: %s", async purpose => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    if (purpose !== null) await courses.updateAssetMembership({ ...input, purpose, expectedUpdatedAt: membership.updatedAt.toISOString() });
    const [row] = await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${source.id}`;
    const chunk = { id: String(row!.id), sourceId: source.id, sourceVersion: 0, page: 1,
      text: "Synthetic purpose material", startMs: null, endMs: null, imageObjectKey: null };
    const retrieve = createOpeningMaterialRetriever(f.sql, {} as never, null);
    for (const materialUse of ["teaching", "practice", "citation"] as const) {
      const query = { sourceIds: [source.id], chunks: [chunk], query: "purpose", maxCharacters: 1000,
        operationId: randomUUID(), courseContext: { courseId: course.id, materialUse } };
      if (courseSourcePurposeAllows(purpose, materialUse)) expect((await retrieve(f.scope, query)).chunks).toHaveLength(1);
      else await expect(retrieve(f.scope, query)).rejects.toMatchObject({ code: "CONFLICT" });
    }
    const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Independent", slug: randomUUID() });
    await courses.addAssetMembership({ ...input, courseId: other.id, purpose: "teaching", role: "core", visibility: "private" });
    expect((await retrieve(f.scope, { sourceIds: [source.id], chunks: [chunk], query: "purpose", maxCharacters: 1000,
      operationId: randomUUID(), courseContext: { courseId: other.id, materialUse: "teaching" } })).chunks).toHaveLength(1);
    await expect(retrieve(f.scope, { sourceIds: [source.id], chunks: [chunk], query: "purpose", maxCharacters: 1000,
      operationId: randomUUID(), courseContext: { courseId: null, materialUse: "citation" } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("retains the original retrieval pin until provider send, including changed-back purpose", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const [row] = await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${source.id}`;
    const chunk = { id: String(row!.id), sourceId: source.id, sourceVersion: 0, page: 1,
      text: "Synthetic purpose material", startMs: null, endMs: null, imageObjectKey: null };
    const result = await createOpeningMaterialRetriever(f.sql, {} as never, null)(f.scope, {
      sourceIds: [source.id], chunks: [chunk], query: "purpose", maxCharacters: 1000, operationId: randomUUID(),
      courseContext: { courseId: course.id, materialUse: "teaching" },
    });
    await expect(result.assertCurrent()).resolves.toBeUndefined();
    const changed = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    await expect(result.assertCurrent()).rejects.toMatchObject({ code: "CONFLICT" });
    await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: changed.updatedAt.toISOString() });
    await expect(result.assertCurrent()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("admits explicit standalone unclassified material but rejects unknown context and later classification", async () => {
    const { source } = await setup();
    await ready(source.id);
    const pool = createOpeningCourseReadySourcesRepository(f.sql);
    await expect(pool.readMaterialPurposePin(f.scope, { courseId: undefined, materialUse: "teaching", sourceIds: [source.id] } as never))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const pin = await pool.readMaterialPurposePin(f.scope, { courseId: null, materialUse: "citation", sourceIds: [source.id] });
    await expect(pool.assertMaterialPurposePin(f.scope, pin)).resolves.toBeUndefined();
    await f.sql`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE asset_id=${source.id}`;
    await expect(pool.assertMaterialPurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(pool.readMaterialPurposePin(f.otherScope, { courseId: null, materialUse: "citation", sourceIds: [source.id] }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("pins exact membership timestamps and rejects changed-back purposes and source versions", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const activityId = await insertTestTeachingActivity(f.sql, f.scope, course.id);
    await f.sql`UPDATE opening_teaching_activities SET source_ids=${[source.id]} WHERE id=${activityId}`;
    await f.sql`UPDATE course_asset_memberships SET updated_at='2026-01-01T00:00:00.123456Z' WHERE id=${membership.id}`;
    const pool = createOpeningCourseReadySourcesRepository(f.sql);
    const pin = await pool.readSourcePurposePin(f.scope, { activityId });
    expect(pin).toMatchObject({ activityId, courseId: course.id, materialUse: "teaching", sources: [{
      sourceId: source.id, sourceVersion: 0, membershipId: membership.id, purpose: null,
      purposeRevision: "2026-01-01T00:00:00.123456Z",
    }] });
    await expect(f.sql.begin(tx => pool.assertSourcePurposePin(f.scope, pin, tx))).resolves.toBeUndefined();
    const current = await courses.getMembership(input);
    const changed = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: current.updatedAt.toISOString() });
    await expect(pool.assertSourcePurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
    await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: changed.updatedAt.toISOString() });
    await expect(pool.assertSourcePurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
    const fresh = await pool.readSourcePurposePin(f.scope, { activityId });
    await f.sql`UPDATE opening_sources SET version=1 WHERE id=${source.id}`;
    await expect(pool.assertSourcePurposePin(f.scope, fresh)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(pool.readSourcePurposePin(f.otherScope, { activityId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("holds a final pin assertion through commit against concurrent purpose updates", async () => {
    const { source, course, input, membership } = await setup();
    await ready(source.id);
    const activityId = await insertTestTeachingActivity(f.sql, f.scope, course.id);
    const pin = await createOpeningCourseReadySourcesRepository(f.sql).readSourcePurposePin(f.scope, { activityId, sourceIds: [source.id] });
    const publisher = await openRaceSession().ready;
    const writer = await openRaceSession().ready;
    let signal = () => {}, release = () => {};
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const publication = track(publisher.sql.begin(async tx => {
      await createOpeningCourseReadySourcesRepository(publisher.sql).assertSourcePurposePin(f.scope, pin, tx);
      signal();
      await gate;
    }));
    let update: Promise<unknown> | undefined;
    try {
      await entered;
      update = track(createCourseMembershipRepository(writer.sql).updateAssetMembership({
        ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString(),
      }));
      await waitUntilBlocked(f.sql, writer.pid, publisher.pid, "purpose writer behind final publication pin");
      release();
      await publication;
      await update;
      await expect(createOpeningCourseReadySourcesRepository(f.sql).assertSourcePurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      release();
      await Promise.allSettled([publication, ...(update ? [update] : [])]);
      await closeRace(publisher.sql); await closeRace(writer.sql);
    }
  });

  it("rejects a pin after unlink/relink even when purpose and timestamp are copied", async () => {
    const { courses, source, course, input } = await setup();
    await ready(source.id);
    const activityId = await insertTestTeachingActivity(f.sql, f.scope, course.id);
    const pool = createOpeningCourseReadySourcesRepository(f.sql);
    const pin = await pool.readSourcePurposePin(f.scope, { activityId, sourceIds: [source.id] });
    await courses.removeAssetMembership(input);
    const replacement = await courses.addAssetMembership({ ...input, role: "core", visibility: "private" });
    await f.sql`UPDATE course_asset_memberships SET updated_at=${pin.sources[0]!.purposeRevision!}::timestamptz WHERE id=${replacement.id}`;
    await expect(pool.assertSourcePurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("invalidates material revision on purpose changes even when both states admit teaching", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const before = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id)!;
    await courses.updateAssetMembership({ ...input, purpose: "teaching", expectedUpdatedAt: membership.updatedAt.toISOString() });
    const after = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id)!;
    expect(before.hasUsableMaterials).toBe(true);
    expect(after.hasUsableMaterials).toBe(true);
    expect(after.materialRevision).not.toBe(before.materialRevision);
  });

  it("retains unknown null and independently classifies one source in different courses", async () => {
    const { courses, source, input, membership } = await setup();
    expect(membership.purpose).toBeNull();
    const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Other purpose course", slug: randomUUID() });
    await courses.addAssetMembership({ ...input, courseId: other.id, purpose: "teaching", role: "core", visibility: "course" });
    const before = await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`;
    const updated = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    expect(updated).toMatchObject({ purpose: "mock_exam", role: "optional", visibility: "private", sortOrder: 7 });
    expect((await courses.getMembership({ ...input, courseId: other.id })).purpose).toBe("teaching");
    expect(await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`).toEqual(before);
    const cleared = await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: updated.updatedAt.toISOString() });
    expect(cleared.purpose).toBeNull();
  });

  it("accepts the returned millisecond token for a legacy microsecond timestamp, then rejects its reuse", async () => {
    const { courses, input, membership } = await setup();
    await f.sql`UPDATE course_asset_memberships SET updated_at='2026-01-01T00:00:00.123456Z' WHERE id=${membership.id}`;
    const current = await courses.getMembership(input);
    const changed = await courses.updateAssetMembership({ ...input, purpose: "practice", expectedUpdatedAt: current.updatedAt.toISOString() });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: "reference", expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await courses.getMembership(input)).purpose).toBe("practice");
  });

  it("allows exactly one concurrent purpose writer and preserves unrelated metadata changes", async () => {
    const { courses, input, membership } = await setup();
    const expectedUpdatedAt = membership.updatedAt.toISOString();
    const outcomes = await Promise.allSettled([
      courses.updateAssetMembership({ ...input, purpose: "teaching", expectedUpdatedAt }),
      courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    const current = await courses.getMembership(input);
    const metadata = await courses.updateAssetMembership({ ...input, role: "archive", sortOrder: 19 });
    expect(metadata).toMatchObject({ role: "archive", sortOrder: 19, visibility: "private", purpose: current.purpose });
    expect(metadata.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces enum and source-only purpose in PostgreSQL, not just request parsing", async () => {
    const { membership } = await setup();
    await expect(f.sql`UPDATE course_asset_memberships SET purpose='unknown' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(f.sql`UPDATE course_asset_memberships SET asset_type='document',purpose='teaching' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    const [row] = await f.sql`SELECT asset_type,purpose FROM course_asset_memberships WHERE id=${membership.id}`;
    expect(row).toMatchObject({ asset_type: "source", purpose: null });
  });
});
