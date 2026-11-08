import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, readOpeningBackupRecords } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { admitOpeningReservedCandidate, readOpeningReservedSupply, reserveOpeningCourseQuestion } from "../../packages/database/src/repositories/opening-course-reserved-selection";
import { produceReservedQuestion } from "../../packages/ai/src/opening/reserved-question-producer";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import type { CourseRouteRequirementInput } from "@aistudy/contracts";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
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
  const admit = async (candidate: Parameters<Parameters<typeof produceReservedQuestion>[1]["admitAndPersist"]>[0]) => {
    const { scope, text, interaction, answer, ...pinned } = candidate;
    return admitOpeningReservedCandidate(f.sql, scope, activity.activity.id, pinned, { text, interaction, answer });
  };
  return { sourceId, courseId, requirement, activityId: activity.activity.id, input, admit };
}
const candidate = { text: "137*19", interaction: { kind: "numeric" as const }, answer: "2603" };
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
it("requires complete schema protection before generated supply can reserve and issue", async () => {
  const x = await setup();
  const result = await produceReservedQuestion(x.input, { generate: async () => JSON.stringify(candidate), admitAndPersist: x.admit });
  expect(result.kind).toBe("persisted");
  expect(await readOpeningReservedSupply(f.sql, f.scope, x.requirement)).toMatchObject({ status: "unknown", available: 0 });
  // The schema owner has not yet handed off all five sticky history guards.
  // These are genuine rejected consumer transactions, NOT an unseen positive.
  await expect(f.sql.begin(tx => reserveOpeningCourseQuestion(tx, f.scope, x.requirement, x.activityId, { kind: "new_question" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
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
it("revalidates pinned source/requirement versions after generation and leaves no half write", async () => {
  const x = await setup();
  await expect(produceReservedQuestion(x.input, { generate: async () => {
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
    return JSON.stringify(candidate);
  }, admitAndPersist: x.admit })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_course_reserved_questions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});
