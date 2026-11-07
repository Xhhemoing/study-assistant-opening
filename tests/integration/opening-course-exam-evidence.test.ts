import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExamPack, ExamSprintOverview } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { readCourseRouteObservations } from "../../packages/database/src/repositories/opening-course-route-read";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "route-exam-fixture", version: "1", title: "Route exam", description: "Fixture",
  topics: ["other", "one", "two"].map(id => ({ id, title: id })),
  lessons: ["other", "one", "two"].map(id => ({ id, topicId: id, title: id, summary: "summary", steps: ["step"], workedExample: "example", pitfalls: ["pitfall"] })),
  questions: ["other", "one", "two"].map(id => ({ id, topicId: id, skillId: id === "other" ? "other-skill" : "target-skill", familyId: `family-${id}`, lessonId: id, pool: "training", difficulty: "foundation", prompt: `Question ${id}`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer: "a", explanation: "answer", hint: "hint", estimatedMinutes: 1 })),
  sourceItems: [], weekPlan: [], limitations: ["Fixture"],
};
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const key = () => `route-exam:${randomUUID()}`;
async function setup() {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Exam route',${courseId})`;
  const integration = createOpeningExamIntegrationRepository(f.sql, pack);
  const sprint = createOpeningExamSprintRepository(f.sql, pack);
  const bound = await integration.bind(f.scope, { clientKey: key(), courseId, milestoneId: null, expectedPackVersion: pack.version, createKnowledgeNodes: true, skills: [], materials: [] });
  const targetNode = bound.binding!.skills.find(skill => skill.skillId === "target-skill")!.nodeId;
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const suggestions = (await route.read(f.scope, courseId)).suggestions;
  const target = suggestions.find(row => row.knowledgeNodeId === targetNode)!;
  expect(target.requirementKey).toBe(`knowledge:${targetNode}`);
  const confirm = async () => {
    await route.confirm(f.scope, courseId, { expectedRevisions: [], requirements: suggestions, confirmScope: true });
    // The repository clock is truncated to milliseconds; separate confirmation from subsequent captures.
    await f.sql`SELECT pg_sleep(0.01)`;
  };
  const start = () => sprint.act(f.scope, { action: "start", mode: "diagnostic", clientKey: key() });
  const answer = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: "a", confidence: 4, clientKey: key() });
  const next = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "next", runId: view.activeRun!.id, clientKey: key() });
  const progress = async () => (await route.read(f.scope, courseId)).requirements.find(row => row.requirement.id === target.id)!;
  const all = async () => { let view = await start(); for (let i = 0; i < 3; i++) { await answer(view); if (i < 2) view = await next(view); } };
  return { courseId, route, target, confirm, start, answer, all, progress };
}

it("counts two distinct independently correct questions at the bound node", async () => {
  const x = await setup(); await x.confirm(); await x.all();
  expect((await x.progress()).status).toBe("verified");
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const projected = evidence.projected.filter(row => row.courseRequirement?.id === x.target.id);
  expect(projected).toHaveLength(2);
  expect(projected.every(row => row.requirementKey === x.target.requirementKey)).toBe(true);
  expect(evidence.raw.filter(row => projected.some(p => p.id === row.id)).every(row => row.requirementKey?.startsWith("exam-skill:"))).toBe(true);
});

it("keeps exam evidence local even when an earlier local answer is unverified", async () => {
  const x = await setup(); await x.confirm();
  const ref = x.target.sourceRefs[0]!;
  const learning = createOpeningLearningRepository(f.sql);
  const session = await learning.createSession(f.scope, { courseId: x.courseId, skillLabel: x.target.title, sourceIds: [ref.sourceId] });
  const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, { sessionId: session.id, clientKey: key(), requirementKey: x.target.requirementKey,
    problem: { sourceId: ref.sourceId, chunkId: ref.chunkId!, physicalPage: ref.page ?? 1, stemSnapshot: "Earlier local question", artifactKind: "reference_item" } });
  const binding = { id: x.target.id, revision: 1, stableSkillId: x.target.stableSkillId, requirementKey: x.target.requirementKey };
  await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=COALESCE(evaluation_spec,'{}'::jsonb) || ${f.sql.json({ courseRequirement: binding })}::jsonb WHERE id=${attempt.itemVersionId!}`;
  await learning.insertObservation(f.scope, { sessionId: session.id, attemptId: attempt.id, courseId: x.courseId, skillLabel: x.target.title, sourceIds: [ref.sourceId], problemId: attempt.problemId, clientKey: key(), answer: "unknown", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  expect((await x.progress()).status).toBe("needs_verification");
  await x.all(); expect((await x.progress()).status).toBe("verified");
});

it("does not count captures made before route confirmation", async () => {
  const x = await setup(); await x.all(); await x.confirm();
  expect((await x.progress()).status).toBe("unobserved");
});

it("does not count a published answer mapped to a different node", async () => {
  const x = await setup(); await x.confirm(); const first = await x.start();
  expect(first.currentAttempt!.questionId).toBe("other");
  await x.answer(first); expect((await x.progress()).status).toBe("unobserved");
});
