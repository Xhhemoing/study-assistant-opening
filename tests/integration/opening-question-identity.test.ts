import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { compareCourseQuestionIdentity } from "@aistudy/domain";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { evaluateOpeningTeachingKeyAttempt } from "../../packages/database/src/repositories/opening-teaching-question-evaluation";
import { readResolvedTeachingQuestion, readTeachingQuestionForAttempt, readTeachingQuestionForGrading, type TeachingQuestionSpec } from "../../packages/database/src/repositories/opening-teaching-question";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

async function seed(secondContent: Record<string, unknown> = { text: "1+1", interaction: { kind: "numeric" } },
  firstContent: Record<string, unknown> = { text: "1+1", interaction: { kind: "numeric" } }) {
  const base = await learningAttemptFixture(f);
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [base.courseId],
    title: "Identity", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "Calculate" });
  const requirement = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "identity:add", title: "Addition",
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId: base.sourceId, sourceVersion: 1, chunkId: base.chunkId }],
    origin: "confirmed" as const, verification: { kind: "rubric" as const, status: "needs_check" as const, exerciseKeys: [], rubric: "Calculate", missingReasons: [] } };
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, base.courseId, { expectedRevisions: [], requirements: [requirement], confirmScope: true });
  const started = await route.start(f.scope, base.courseId, { goalId: goal.id, expectedGoalRevision: 1,
    requirementId: requirement.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Identical questions under different UUIDs", blocks: [
    { id: ids[0], type: "prompt", content: firstContent },
    { id: ids[1], type: "answer_key", content: { answer: "2", hidden: true } },
    { id: ids[2], type: "prompt", content: secondContent },
    { id: ids[3], type: "answer_key", content: { answer: "2", hidden: true } },
  ] });
  await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1, blockOrder: ids.map((blockId, position) => ({ blockId, position,
      role: position % 2 ? "answer_key" : "prompt", blockType: position % 2 ? "answer_key" : "prompt" })),
    sourceRefs: [{ sourceId: base.sourceId, version: 1, chunkId: base.chunkId }] });
  const session = await base.learning.createSession(f.scope, { activityId: started.activity.id, courseId: base.courseId,
    skillLabel: started.activity.learnerFocus!.skillLabel, sourceIds: [base.sourceId] });
  const start = (index: number) => base.attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
    teachingBlock: { blockId: ids[index * 2]!, contentVersion: 1 } });
  const first = await start(0), second = await start(1);
  const read = (itemVersionId: string) => f.sql.begin(async tx => {
    const [row] = await tx`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${itemVersionId}`;
    const spec = row!.evaluation_spec as TeachingQuestionSpec;
    return { spec, resolved: await readResolvedTeachingQuestion(tx, f.scope, spec) };
  });
  const evaluate = (attemptId: string, scope = f.scope) => f.sql.begin(async tx => {
    const [attempt] = await tx`SELECT * FROM opening_learning_attempts WHERE id=${attemptId}`;
    return evaluateOpeningTeachingKeyAttempt(tx, scope, attempt, "2", []);
  });
  const feedback = async () => {
    const observation = await base.learning.insertObservation(f.scope, { sessionId: session.id, activityId: started.activity.id,
      courseId: base.courseId, skillLabel: started.activity.learnerFocus!.skillLabel, sourceIds: [base.sourceId], attemptId: first.id,
      problemId: first.problemId, answer: "2", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
    await f.sql`UPDATE opening_learning_observations SET verdict_source='deterministic',server_evaluation=${f.sql.json({
      evaluatorVersion: "teaching-key-exact-v1", decision: "correct" })} WHERE id=${observation.id}`;
  };
  return { ...base, activityId: started.activity.id, first, second, read, evaluate, feedback };
}

it("uses actual published content to deduplicate different UUIDs in the real evaluation consumer, without backfilling records", async () => {
  const x = await seed();
  expect(x.first.problemId).not.toBe(x.second.problemId);
  const left = await x.read(x.first.itemVersionId!), right = await x.read(x.second.itemVersionId!);
  expect(compareCourseQuestionIdentity(left.resolved, right.resolved)).toBe("equivalent_exact");
  expect(await x.evaluate(x.second.id)).toMatchObject({ decision: "correct", priorFeedback: false });
  await x.feedback();
  expect(await x.evaluate(x.second.id)).toMatchObject({ decision: "correct", priorFeedback: true });
  const [saved] = await f.sql`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${x.second.itemVersionId!}`;
  expect(saved!.evaluation_spec).not.toHaveProperty("identity");
  expect(x.second).not.toHaveProperty("identity");
  expect(JSON.stringify(x.second)).not.toContain("keyRefId");
  const grading = await f.sql.begin(async tx => {
    const [item] = await tx`SELECT * FROM opening_learning_item_versions WHERE id=${x.second.itemVersionId!}`;
    return readTeachingQuestionForGrading(tx, f.scope, { ...item!, evaluation_spec: { ...right.spec, answerBlockId: left.spec.answerBlockId } });
  });
  expect(grading?.referenceText).toContain("2");
  expect(grading).not.toHaveProperty("identity");
});

it("does not ignore an actually displayed option change behind identical text", async () => {
  const content = (label: string) => ({ text: "1+1", interaction: { kind: "choice", options: [{ id: "A", label: "2" }, { id: "B", label }] } });
  const x = await seed(content("4"), content("3"));
  const first = await x.read(x.first.itemVersionId!), second = await x.read(x.second.itemVersionId!);
  expect(compareCourseQuestionIdentity(first.resolved, second.resolved)).toBe("different");
});

it.each(["question", "markdown", "prompt", "answer", "solution"])("ignores shadowed %s changes when resolving an exact duplicate through the real evaluator", async field => {
  const x = await seed({ text: "1+1", interaction: { kind: "numeric" }, [field]: "a different unused condition" });
  const first = await x.read(x.first.itemVersionId!), second = await x.read(x.second.itemVersionId!);
  expect(x.first.problemId).not.toBe(x.second.problemId);
  expect(compareCourseQuestionIdentity(first.resolved, second.resolved)).toBe("equivalent_exact");
  expect(second.resolved).toMatchObject({ conditions: "1+1", interaction: { kind: "numeric" } });
  await x.feedback();
  expect(await x.evaluate(x.second.id)).toMatchObject({ decision: "correct", priorFeedback: true });
});

it.each([
  { name: "conditions", content: { text: "1+1 with x>0", interaction: { kind: "numeric" } }, expected: "different" },
  { name: "unit", content: { text: "1+1", interaction: { kind: "numeric", unit: "m" } }, expected: "different" },
  { name: "options", content: { text: "1+1", interaction: { kind: "choice", options: [{ id: "A", label: "2" }, { id: "B", label: "3" }] } }, expected: "different" },
  { name: "figure reference", content: { text: "1+1", interaction: { kind: "numeric" }, figureRefs: [{ page: 2 }] }, expected: "unknown" },
  { name: "semantic candidate", content: { text: "Calculate the sum of one and one", interaction: { kind: "numeric" } }, expected: "candidate" },
])("does not supply exact/unseen evidence for $name", async ({ content, expected }) => {
  const x = await seed(content);
  const a = await x.read(x.first.itemVersionId!), b = await x.read(x.second.itemVersionId!);
  expect(compareCourseQuestionIdentity(a.resolved, b.resolved, expected === "candidate" ? "semantic" : undefined)).toBe(expected);
  await x.feedback();
  expect(await x.evaluate(x.second.id)).toBeNull();
});

it("keeps a related unknown history out of unseen authority without invalidating the current key", async () => {
  const x = await seed();
  await x.feedback();
  await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=${f.sql.json({ kind: "unresolved" })}
    WHERE id=${x.first.itemVersionId!}`;
  expect(await x.evaluate(x.second.id)).toMatchObject({ decision: "correct", priorFeedback: true });
});

it("rejects a contradictory key on the same question binding instead of treating it as unseen", async () => {
  const x = await seed(), first = await x.read(x.first.itemVersionId!), second = await x.read(x.second.itemVersionId!);
  await x.feedback();
  await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=${f.sql.json({ ...first.spec, answerBlockId: second.spec.answerBlockId })}
    WHERE id=${x.first.itemVersionId!}`;
  expect(await x.evaluate(x.first.id)).toBeNull();
  expect(await x.evaluate(x.second.id)).toMatchObject({ decision: "correct", priorFeedback: true });
});

it("rejects a wrong answer-key binding, other owner/workspace, stale publication and changed/unavailable source", async () => {
  const x = await seed(), a = await x.read(x.first.itemVersionId!), b = await x.read(x.second.itemVersionId!);
  await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=${f.sql.json({ ...b.spec, answerBlockId: a.spec.answerBlockId })}
    WHERE id=${x.second.itemVersionId!}`;
  expect(await x.evaluate(x.second.id)).toBeNull();
  await expect(f.sql.begin(async tx => {
    const [item] = await tx`SELECT * FROM opening_learning_item_versions WHERE id=${x.second.itemVersionId!}`;
    return readTeachingQuestionForGrading(tx, f.scope, item!);
  })).rejects.toThrow(/绑定不一致/);
  expect(await x.evaluate(x.first.id, { ...f.scope, ownerUserId: randomUUID() })).toBeNull();
  expect(await x.evaluate(x.first.id, { ...f.scope, workspaceId: randomUUID() })).toBeNull();
  await f.sql`UPDATE opening_teaching_activities SET content_version=content_version+1 WHERE id=${x.activityId}`;
  expect(await x.evaluate(x.first.id)).toBeNull();
  await expect(f.sql.begin(tx => readTeachingQuestionForAttempt(tx, f.scope, x.activityId,
    { blockId: a.spec.blockId, contentVersion: 1 }, { [x.sourceId]: 1 }))).rejects.toThrow(/changed/);
  await f.sql`UPDATE opening_teaching_activities SET content_version=content_version-1 WHERE id=${x.activityId}`;
  await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.sourceId}`;
  expect(await x.evaluate(x.first.id)).toBeNull();
});

it("does not reuse a renamed identity across content versions, answer roles or unresolved source figures", async () => {
  const x = await seed(), saved = await x.read(x.first.itemVersionId!);
  const changed = structuredClone(saved.resolved!);
  if (changed.identity.questionRef.kind === "teaching_question") changed.identity.questionRef.contentVersion++;
  expect(compareCourseQuestionIdentity(saved.resolved, changed)).toBe("conflict");
  await f.sql`UPDATE opening_teaching_activity_specs SET block_order=(SELECT jsonb_agg(CASE
    WHEN ref->>'blockId'=${saved.spec.answerBlockId!} THEN jsonb_set(ref,'{role}','"teach"') ELSE ref END)
    FROM jsonb_array_elements(block_order) ref) WHERE activity_id=${x.activityId}`;
  expect((await x.read(x.first.itemVersionId!)).resolved).toBeNull();
  await f.sql`UPDATE opening_source_chunks SET image_object_key='private-fixture-figure' WHERE id=${x.chunkId}`;
  expect((await x.read(x.second.itemVersionId!)).resolved).toBeNull();
});

it("withholds identity for a privacy-excluded source", async () => {
  const x = await seed();
  await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${x.sourceId})`;
  expect((await x.read(x.first.itemVersionId!)).resolved).toBeNull();
  expect(await x.evaluate(x.first.id)).toBeNull();
});
