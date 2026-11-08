import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createOpeningCourseReadySourcesRepository,
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository, readOpeningBackupRecords } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { admitOpeningReservedCandidate, readOpeningReservedSupply, reserveOpeningCourseQuestion, issueOpeningReservedQuestion } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import { produceReservedQuestion } from "../../packages/ai/src/opening/reserved-question-producer";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { readCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });
async function setup() {
  const sourceId = await backupRows(f.sql, f.scope).source("uploaded", 1), chunkId = randomUUID(), courseId = randomUUID();
  await f.sql`UPDATE opening_sources SET mime='text/plain' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'Arithmetic operations on rational numbers.')`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Arithmetic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "Arithmetic", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "Independent arithmetic" });
  const definition: CourseRouteRequirementInput = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null,
    requirementKey: "arithmetic", title: "Arithmetic", position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "exact", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed" };
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const confirmed = await route.confirm(f.scope, courseId, { expectedRevisions: [], requirements: [definition], confirmScope: true });
  const requirement = confirmed.requirements[0]!.requirement;
  const activity = await route.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirement.id,
    expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (activity.kind !== "ready") throw new Error("activity not ready");
  const input = { scope: f.scope, courseId, requirementId: requirement.id, requirementRevision: 1, sourceVersions: { [sourceId]: 1 },
    requirementText: "rational arithmetic", evidence: { chunks: [] } };
  const purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: activity.activity.id, sourceIds: [sourceId], materialUse: "teaching" });
  const admission = { assertPinnedContext: (tx: TransactionSql) => purposes.assertSourcePurposePin(f.scope, pin, tx) };
  const admit = async (candidate: Parameters<Parameters<typeof produceReservedQuestion>[1]["admitAndPersist"]>[0]) => {
    const { scope, text, interaction, answer, ...pinned } = candidate;
    return admitOpeningReservedCandidate(f.sql, scope, activity.activity.id, pinned, { text, interaction, answer }, admission);
  };
  return { sourceId, chunkId, courseId, requirement, activityId: activity.activity.id, input, admit, admission };
}
const candidate = { text: "137*19", interaction: { kind: "numeric" as const }, answer: "2603" };
it.each([
  ["137*19", "Example: 137 · 19"], ["$137*19$", "137*19"], ["137*19", "$137*19$"],
  ["\\(137 \\times 19\\)", "137*19"],
  ["$137*19 = ?$", "137*19"], ["137*19", "$137*19 = ?$"],
])("real consumer never reserves exposed alias %s from %s", async (text, history) => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, text }), admitAndPersist: x.admit });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "ready", available: 1 });
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,${history})`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
    text, interaction: candidate.interaction, familyId: "arithmetic:*" })).toMatchObject({ coverage: "complete", exactExposed: true });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "missing", available: 0 });
  await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId} AND state<>'available'`).toHaveLength(0);
});
it.each(["Example: 137 · 19 +", "137*19 if x>0", "See (137+2)*19 in figure", "Example: x+1"])("keeps unresolved history unknown with zero reservation: %s", async history => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,${history})`;
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "unknown", available: 0 });
  await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId} AND state<>'available'`).toHaveLength(0);
});
it("does not launder a legacy incomplete descriptor through a successful current rescan", async () => {
  const x = await setup();
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  // Actual old grammar's output for Example: 137 · 19. Original history remains
  // present for a real rescan; the immutable legacy omission must still fail closed.
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${x.sourceId},1,2,'Example: 137 · 19')`;
  await f.sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'legacy-middle-dot','teaching',
      ${f.sql.json({ complete: true, expressions: [], families: [] })},'{}',0)`;
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "unknown", available: 0 });
  const [legacy] = await f.sql`SELECT exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND surface_key='legacy-middle-dot'`;
  expect(legacy!.exact_content).toEqual({ complete: true, expressions: [], families: [] });
  await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects the original private pin after purpose changes back without inserting a candidate", async () => {
  const x = await setup();
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await f.sql`UPDATE course_asset_memberships SET purpose=NULL,updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("rejects a purpose writer committed before the admission pin lock", async () => {
  const x = await setup();
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(x.admit({ ...x.input, ...candidate })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("holds original purpose locks until candidate INSERT commit, using PG writer barriers", async () => {
  const x = await setup();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  // Delegate every statement to real PG. Hold the real transaction AFTER its
  // INSERT has completed but BEFORE begin commits, not just inside the pin callback.
  const commitBarrierSql = new Proxy(f.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (run: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await run(tx);
      expect(await tx`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
      entered(); await held;
      return result;
    });
  } });
  const admission = admitOpeningReservedCandidate(commitBarrierSql, f.scope, x.activityId, x.input, candidate, x.admission);
  await ready;
  try {
    expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    await expect(f.sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
        AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await admission; }
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
    AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
});
it("fails closed without the server-only admission capability, including the legacy batch API", async () => {
  const x = await setup();
  const { saveOpeningReservedCandidates } = await import("../../packages/database/src/repositories/opening-course-reserved-selection");
  // Runtime calls can omit a required TypeScript parameter; neither public entry may bypass it.
  // @ts-expect-error intentionally missing server-only capability
  await expect(admitOpeningReservedCandidate(f.sql, f.scope, x.activityId, x.input, candidate)).rejects.toMatchObject({ code: "CONFLICT" });
  // @ts-expect-error intentionally missing server-only capability
  await expect(saveOpeningReservedCandidates(f.sql, f.scope, x.activityId, [candidate])).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("generates into authoritative private admission, never a public block/config/backup", async () => {
  const x = await setup();
  const result = await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  expect(result.kind).toBe("persisted");
  if (result.kind !== "persisted") throw new Error("private candidate not persisted");
  const [row] = await f.sql`SELECT * FROM opening_course_reserved_questions WHERE id=${result.privateRefId}`;
  expect(row).toMatchObject({ state: "available", question_json: { text: candidate.text }, key_json: { answer: candidate.answer },
    identity_json: { reservedQuestionId: result.privateRefId, requirementId: x.requirement.id, requirementRevision: 1, familyId: "arithmetic:*" } });
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  const backup = JSON.stringify(await readOpeningBackupRecords(f.sql, f.scope));
  expect(backup).not.toContain(candidate.text); expect(backup).not.toContain(candidate.answer);
  expect(JSON.stringify(result)).not.toContain(candidate.answer);
});
it("rejects a plausible wrong key and concurrent generation admits only one exact question", async () => {
  const x = await setup();
  expect(await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, answer: "1" }), admitAndPersist: x.admit }))
    .toEqual({ kind: "unavailable", reason: "not_admitted" });
  const results = await Promise.all([1, 2].map(() => produceReservedQuestion(x.input, {
    generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit,
  })));
  expect(results.filter(row => row.kind === "persisted")).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
});
it("proves real generated supply through coverage, racing reservation, issued owner and first presentation", async () => {
  const x = await setup();
  const result = await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  expect(result.kind).toBe("persisted");
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "ready", available: 1 });
  const other = await insertTestTeachingActivity(f.sql, f.scope, x.courseId);
  await f.sql`UPDATE opening_teaching_activities SET goal_json=(SELECT goal_json FROM opening_teaching_activities WHERE id=${x.activityId}),
    source_ids=ARRAY[${x.sourceId}]::uuid[] WHERE id=${other}`;
  const reservations = await Promise.allSettled([x.activityId, other].map(activityId => f.sql.begin(tx =>
    reserveOpeningCourseQuestion(tx, f.scope, x.requirement, activityId, { kind: "new_question" }))));
  expect(reservations.filter(row => row.status === "fulfilled")).toHaveLength(1);
  const [reserved] = await f.sql`SELECT id,reserved_activity_id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`;
  const activityId = String(reserved!.reserved_activity_id);
  await expect(f.sql.begin(async tx => { await issueOpeningReservedQuestion(tx, f.scope, activityId); throw new Error("after issue"); }))
    .rejects.toThrow("after issue");
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND kind='presented'`).toHaveLength(0);
  const content = createOpeningTeachingContentRepository(f.sql);
  const [one, two] = await Promise.all([content.getClientInit(f.scope, activityId), content.getClientInit(f.scope, activityId)]);
  expect(one?.blocks).toEqual(two?.blocks); expect(one?.blocks).toHaveLength(1);
  expect(one?.blocks[0]?.content).toMatchObject({ text: candidate.text });
  expect(JSON.stringify(one)).not.toContain(candidate.answer);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  const [issued] = await f.sql`SELECT state,issued_item_version_id FROM opening_course_reserved_questions WHERE id=${reserved!.id}`;
  expect(issued).toMatchObject({ state: "issued" }); expect(issued!.issued_item_version_id).toBeTruthy();
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}
    AND item_version_id=${issued!.issued_item_version_id} AND kind='presented'`).toHaveLength(1);
  expect(await readCourseQuestionExposure(f.sql, f.scope, { ...x.input, reservedQuestionId: randomUUID(), identityRefId: randomUUID(),
    text: "计算 137 × 19", interaction: candidate.interaction, familyId: "arithmetic:*" }))
    .toMatchObject({ coverage: "complete", exactExposed: true, familyExposed: true });
  await produceReservedQuestion(x.input, { generate: async () => JSON.stringify({ ...candidate, text: "139*23", answer: "3197" }), admitAndPersist: x.admit });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement, { kind: "same_family", familyId: "arithmetic:*" }))
    .toMatchObject({ status: "ready", available: 1 });
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement, { kind: "new_family", excludedFamilyIds: [] }))
    .toMatchObject({ status: "missing", available: 0 });
  expect(JSON.stringify(await readOpeningBackupRecords(f.sql, f.scope))).not.toContain(candidate.answer);
});

it("runs server-only pinned authority inside the original publication transaction before any spec writes", async () => {
  const x = await setup(), content = createOpeningTeachingContentRepository(f.sql), blockId = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  const error = Object.assign(new Error("original purpose pin changed"), { code: "CONFLICT" });
  let checked = false;
  await expect(content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id,
    expectedVersion: 0, revisionNumber: 1, blockOrder: [{ blockId, position: 0, role: "teach", blockType: "text" }] }, undefined,
  async tx => {
    checked = true;
    await tx`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'pinned-context-test','teaching','{}','{}',0)`;
    throw error;
  })).rejects.toBe(error);
  expect(checked).toBe(true);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} AND surface_key='pinned-context-test'`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(0);
});
it("rejects changed-back purpose using the original compiler pin in the actual publication transaction", async () => {
  const x = await setup(), purposes = createOpeningCourseReadySourcesRepository(f.sql), content = createOpeningTeachingContentRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: x.activityId, sourceIds: [x.sourceId], materialUse: "teaching" });
  const blockId = randomUUID(), unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await f.sql`UPDATE course_asset_memberships SET purpose=NULL,updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: 1, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }] }, undefined,
    tx => purposes.assertSourcePurposePin(f.scope, pin, tx))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(0);
});
it("holds the original purpose pin through actual publication, preventing a concurrent classification change", async () => {
  const x = await setup(), purposes = createOpeningCourseReadySourcesRepository(f.sql), content = createOpeningTeachingContentRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId: x.activityId, sourceIds: [x.sourceId], materialUse: "teaching" });
  const blockId = randomUUID(), unit = await content.createUnit(f.scope, { title: "Arithmetic", blocks: [{ id: blockId, type: "text", content: { text: "Lesson" } }] });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const publication = content.publishActivitySpec(f.scope, { activityId: x.activityId, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: 1, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }], sourceRefs: [{ sourceId: x.sourceId, version: 1 }] }, undefined,
  async tx => { await purposes.assertSourcePurposePin(f.scope, pin, tx); entered(); await held; });
  await ready;
  try {
    await expect(f.sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId}
        AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await publication; }
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(1);
});
it("uses the actual compiler/retriever caller and publishes with the original server purpose pin", async () => {
  const x = await setup();
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 10000 }),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
  const providerInput = await deps.buildProviderInput!(f.scope, payload);
  expect(providerInput.chunks).toHaveLength(1);
  expect(providerInput.chunks[0]!.sourceId).toBe(x.sourceId);
  const unit = await deps.ensureTeachingUnitId!(f.scope, payload);
  const hints = { direction: "Use the operation.", concept: "Rational arithmetic.", firstStep: "Multiply the numbers." };
  const output = { text: JSON.stringify({ blocks: [
    { type: "text", text: "Arithmetic operations on rational numbers.", citedChunkIds: [providerInput.chunks[0]!.id] },
    { type: "prompt", text: "2+3", interaction: { kind: "numeric" } },
    { type: "answer_key", text: "5", hints, ...rankPedagogy },
    { type: "prompt", text: "3+4", interaction: { kind: "numeric" } },
    { type: "answer_key", text: "7", hints, ...rankPedagogy },
  ] }), citedChunkIds: [], requestId: "fake-provider-fixture", candidates: [], inputTokens: 1, outputTokens: 1 };
  const publish = await deps.buildPublishInput!(f.scope, { ...payload, teachingUnitId: unit }, output, providerInput);
  expect(JSON.stringify(publish)).not.toContain("purposeRevision");
  const teachingUnit = await createOpeningTeachingContentRepository(f.sql).getUnit(f.scope, unit);
  const [before] = await f.sql`SELECT current_revision_number FROM library_documents WHERE id=${teachingUnit!.documentId}`;
  expect(Number(before!.current_revision_number)).toBe(1);
  expect(await f.sql`SELECT id FROM library_blocks WHERE document_id=${teachingUnit!.documentId} AND content->>'text'='draft'`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${teachingUnit!.documentId}`).toHaveLength(1);
  await deps.publishActivitySpec(f.scope, publish);
  const [revision] = await f.sql`SELECT id FROM library_revisions WHERE document_id=${teachingUnit!.documentId} AND revision_number=2`;
  expect(revision!.id).toBeTruthy();
  const graph = JSON.stringify(await f.sql`SELECT * FROM library_revisions WHERE document_id=${teachingUnit!.documentId} ORDER BY revision_number`);
  await deps.publishActivitySpec(f.scope, publish);
  await deps.publishActivitySpec(f.scope, { ...publish, expectedVersion: 1, verificationStatus: "structure_ok" });
  expect(JSON.stringify(await f.sql`SELECT * FROM library_revisions WHERE document_id=${teachingUnit!.documentId} ORDER BY revision_number`)).toBe(graph);
  expect(await f.sql`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activityId}`).toHaveLength(1);
  await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(deps.publishActivitySpec(f.scope, { ...publish, expectedVersion: 1, verificationStatus: "structure_ok" }))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects a changed purpose between the actual compiler input and public block construction", async () => {
  const x = await setup();
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 10000 }),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
  const input = await deps.buildProviderInput!(f.scope, payload);
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(deps.buildPublishInput!(f.scope, { ...payload, teachingUnitId: randomUUID() }, null, input))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("runs fake-provider generation through the production worker, real budget ledger and private admission without replay resend", async () => {
  const x = await setup(), requests: string[] = [];
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const bytes of request) body.push(Buffer.from(bytes));
    const raw = Buffer.concat(body).toString("utf8"); requests.push(raw);
    const messages = (JSON.parse(raw) as { messages: Array<{ content: unknown }> }).messages;
    const privateCall = JSON.stringify(messages).includes("Generate one new reserved assessment question");
    const source = x.chunkId;
    const hints = { direction: "Use operations.", concept: "Rational arithmetic.", firstStep: "Add the numbers." };
    const output = privateCall ? candidate : { blocks: [
      { type: "text", text: "Arithmetic operations on rational numbers.", citedChunkIds: source ? [source] : [] },
      { type: "prompt", text: "2+3", interaction: { kind: "numeric" } },
      { type: "answer_key", text: "5", hints, ...rankPedagogy },
      { type: "prompt", text: "3+4", interaction: { kind: "numeric" } },
      { type: "answer_key", text: "7", hints, ...rankPedagogy },
    ] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "fake-reserved",
      choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [name, value] of Object.entries({ OPENING_TEACHING_COMPILER_ENABLED: "1", OPENING_TEACHING_VALIDATION_ENABLED: "0",
      OPENING_PROVIDER_ALLOW_LOCAL: "1", OPENING_MODEL_API_KEY: "test-private-generation", OPENING_MODEL_DEFAULT_ID: "reserved-fixture",
      OPENING_MODEL_DAILY_CAP_CENTS: "100000", OPENING_MODEL_CATALOG: JSON.stringify([{ id: "reserved-fixture", label: "Fixture",
        providerId: "fixture", providerLabel: "Fixture", modelName: "fixture", apiKeyEnv: "OPENING_MODEL_API_KEY",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }]) })) vi.stubEnv(name, value);
    const payload = { mode: "generate" as const, activityId: x.activityId, expectedContentVersion: 0, clientKey: randomUUID(), sourceIds: [x.sourceId] };
    const job = { id: randomUUID(), workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId, key: randomUUID(), kind: "compile-teaching-unit",
      payload, result: null, state: "running" as const, privacyEpoch: 0 };
    await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES(${job.id},${f.scope.workspaceId},${f.scope.ownerUserId},${job.key},${job.kind},${f.sql.json(payload)},'running')`;
    const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100000 }),
      chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
    const handler = createCompileTeachingUnitHandler(deps);
    expect(await handler(job, payload)).toMatchObject({ generateStatus: "needs_check" });
    expect(requests).toHaveLength(2);
    const rows = await f.sql`SELECT question_json,key_json FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ question_json: { text: candidate.text }, key_json: { answer: candidate.answer } });
    const revisions = JSON.stringify(await f.sql`SELECT blocks FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`);
    expect(revisions).not.toContain(candidate.text); expect(revisions).not.toContain(candidate.answer);
    const budget = await f.sql`SELECT state,result_ref FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId} ORDER BY request_id`;
    expect(budget).toHaveLength(2); expect(budget.every(row => row.state === "completed")).toBe(true);
    expect(await handler(job, payload)).toMatchObject({ replayed: true }); expect(requests).toHaveLength(2);
    expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
    expect(JSON.stringify(await f.sql`SELECT blocks FROM library_revisions WHERE workspace_id=${f.scope.workspaceId}`)).toBe(revisions);
    expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(JSON.stringify(await readOpeningBackupRecords(f.sql, f.scope))).not.toContain(candidate.answer);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it("keeps unsupported private inventory missing while saved-question exposure and mastery remain unknown", async () => {
  const x = await setup();
  await f.sql`UPDATE course_requirements SET requirement_key='rank',verification=${f.sql.json({ kind: "rubric", status: "ready",
    exerciseKeys: ["rank"], rubric: "Explain rank", missingReasons: [] })} WHERE id=${x.requirement.id}`;
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  const snapshot = await route.read(f.scope, x.courseId), item = snapshot.requirements[0]!;
  expect(item.reservedSupply).toMatchObject({ status: "missing", available: 0 });
  expect(item.questionCoverage).toEqual({ savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" });
  expect(snapshot.summary.verified).toBe(0);
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
it("revalidates pinned source/requirement versions after generation and leaves no half write", async () => {
  const x = await setup();
  await expect(produceReservedQuestion(x.input, { generate: async () => {
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
    return JSON.stringify(candidate);
  }, admitAndPersist: x.admit })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
