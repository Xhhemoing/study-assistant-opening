import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CourseRouteStart, ExamPack } from "@aistudy/contracts";
import {
  createCourseMembershipRepository, createOpeningLearningGoalRepository,
  createOpeningLongTermPlanningRepository, createOpeningPlanningSettingsRepository,
  readOpeningLearningCapacity,
} from "@aistudy/database";
import { createCourseRouteService } from "../../apps/web/src/features/opening/teaching/course-route-service";
import { prepareSprintLesson } from "../../apps/web/src/features/opening/exam-sprint/lesson-navigation";
import { EXAM_LESSONS } from "../../packages/domain/src/opening/exam-sprint/lessons";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { readExamCourseEvidenceLinks } from "../../packages/database/src/repositories/opening-course-exam-evidence-projection";
import { readCourseRouteObservations } from "../../packages/database/src/repositories/opening-course-route-read";
import { readOpeningTeachingCompilerFocus } from "../../packages/database/src/repositories/opening-teaching-focus";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const key = () => randomUUID();
// Each call constructs a fresh service and its repositories; no replay cache survives.
const routes = () => createCourseRouteService(f.sql, { OPENING_TEACHING_COMPILER_ENABLED: "1" });

async function persistedFacts() {
  const activities = await f.sql`SELECT to_jsonb(a) AS fact FROM opening_teaching_activities a
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId} ORDER BY id`;
  const decisions = await f.sql`SELECT to_jsonb(d) AS fact FROM opening_learning_decisions d
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId} ORDER BY id`;
  const sprints = await f.sql`SELECT to_jsonb(s) AS fact FROM opening_exam_sprints s
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId} ORDER BY id`;
  const help = await f.sql`SELECT to_jsonb(h) AS fact FROM opening_exam_help_receipts h
    JOIN opening_exam_attempt_links l ON l.id=h.attempt_link_id
    JOIN opening_exam_sprints s ON s.id=l.sprint_id
    WHERE s.workspace_id=${f.scope.workspaceId} AND s.owner_user_id=${f.scope.ownerUserId} ORDER BY h.id`;
  return { activities, decisions, sprints, help };
}

it("shares converted-exam correction capacity across courses/goals and replays after service reconstruction without new facts", async () => {
  const courses = createCourseMembershipRepository(f.sql);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Midterm", slug: key() });
  const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Other course", slug: key() });
  const goals = createOpeningLearningGoalRepository(f.sql);
  const createGoal = () => goals.create(f.scope, { clientKey: key(), courseIds: [course.id, other.id],
    title: "Explain independently", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120,
    priority: 1, learningMode: "understand", successCriteria: "Correct the failed part" });
  const goal = await createGoal(), alternate = await createGoal();
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, {
    weekOneMonday: "2026-09-07", periodTimes: {}, dailyWindow: { start: "08:00", end: "18:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "18:00", end: "19:00" },
    sleep: { start: "23:00", end: "07:00" }, timeZone: "UTC",
  });
  await createOpeningLongTermPlanningRepository(f.sql).command(f.scope, {
    action: "settings", dailyMinutes: 30, bufferMinutes: 0, expectedRevision: 0,
  });

  // Private server-authored input only. No stored snapshot, outcome or balance is seeded by SQL.
  const lesson = structuredClone(EXAM_LESSONS[0]!);
  const targetKey = `midterm-left:${key()}`, siblingKey = `midterm-right:${key()}`;
  const questionIdentityRefId = key(), leftIdentity = key(), rightIdentity = key();
  const pack: ExamPack = {
    id: "midterm-lifecycle-fixture", version: "1", title: "Midterm lifecycle", description: "Fixture only",
    topics: [{ id: lesson.topicId, title: "Limits" }], lessons: [lesson],
    questions: ["first", "pending"].map((id, index) => ({
      id, topicId: lesson.topicId, skillId: index === 0 ? "target" : "sibling", lessonId: lesson.id,
      familyId: `lifecycle-family-${index}`, pool: "mock-a", difficulty: "foundation", prompt: `Question ${index}`,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer: "a",
      explanation: "Reference answer", hint: "Check conditions", estimatedMinutes: 5,
      ...(index === 0 ? { partSnapshot: {
        packId: "midterm-lifecycle-fixture", packVersion: "1", questionId: id, familyId: `lifecycle-family-${index}`,
        questionIdentityRefId, parts: [
          { partId: "left", identityRefId: leftIdentity, requirementKey: targetKey,
            evaluator: { kind: "choice-options-v1" as const, correctOptionIds: ["b"] } },
          { partId: "right", identityRefId: rightIdentity, requirementKey: siblingKey,
            evaluator: { kind: "choice-options-v1" as const, correctOptionIds: ["a"] } },
        ],
      } } : {}),
    })), sourceItems: [], weekPlan: [], limitations: ["No provider or effectiveness claim"],
  };
  const bound = await createOpeningExamIntegrationRepository(f.sql, pack).bind(f.scope, {
    clientKey: key(), courseId: course.id, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [], materials: [],
  });
  const targetNode = bound.binding!.skills.find(skill => skill.skillId === "target")!.nodeId;
  const suggestions = (await routes().read(f.scope, course.id)).suggestions;
  const confirmed = await routes().confirm(f.scope, course.id, {
    expectedRevisions: [], confirmScope: true, requirements: suggestions.map(row => ({ ...row,
      requirementKey: row.knowledgeNodeId === targetNode ? targetKey : siblingKey,
      goalIds: [goal.id, alternate.id],
    })),
  });
  const target = confirmed.requirements.find(row => row.requirement.requirementKey === targetKey)!.requirement;
  // Share the already bound readable material through the ordinary membership/confirmation APIs.
  for (const sourceId of new Set(target.sourceRefs.map(ref => ref.sourceId))) {
    await courses.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId: other.id,
      assetType: "source", assetId: sourceId, role: "core", visibility: "course" });
  }
  const otherRoute = await routes().confirm(f.scope, other.id, { expectedRevisions: [], confirmScope: true,
    requirements: [{ ...suggestions[0]!, id: key(), stableSkillId: key(), knowledgeNodeId: null,
      requirementKey: `other:${key()}`, sourceRefs: target.sourceRefs, goalIds: [goal.id, alternate.id] }],
  });
  const otherRequirement = otherRoute.requirements[0]!.requirement;
  const input = (requirement: typeof target, minutes: number, selectedGoal = goal): CourseRouteStart => ({
    goalId: selectedGoal.id, expectedGoalRevision: selectedGoal.revision, requirementId: requirement.id,
    expectedRequirementRevision: requirement.revision, clientKey: key(), minutes,
  });
  const occupied = await routes().start(f.scope, other.id, input(otherRequirement, 10));
  expect(occupied.kind).toBe("ready");
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(10);

  const sprint = createOpeningExamSprintRepository(f.sql, pack);
  const first = await sprint.act(f.scope, { action: "start", mode: "mock-a", clientKey: key() });
  expect(first.currentAttempt!.questionId).toBe("first");
  const answered = await sprint.act(f.scope, { action: "answer", attemptId: first.currentAttempt!.id,
    answer: "a", confidence: 4, clientKey: key() });
  const pending = await sprint.act(f.scope, { action: "next", runId: first.activeRun!.id, clientKey: key() });
  expect(prepareSprintLesson(pending, lesson.id)).toBeNull();
  const intent = prepareSprintLesson(pending, lesson.id, true);
  if (!intent || intent.action !== "switch_to_teaching") throw new Error("Expected explicit mock conversion");
  const conversion = { ...intent, clientKey: key() };
  const converted = await sprint.act(f.scope, conversion);
  expect(converted.activeRun).toBeNull();
  expect(converted.attempts[0]).toMatchObject({ id: first.currentAttempt!.id, answer: "a", correct: true,
    answeredAt: answered.attempts[0]!.answeredAt, durationSeconds: answered.attempts[0]!.durationSeconds });
  const links = await readExamCourseEvidenceLinks(f.sql, f.scope, course.id);
  expect(links).toHaveLength(1);
  const link = links[0]!;
  expect(link.parts).toEqual([
    expect.objectContaining({ partId: "left", outcome: "incorrect", assistance: "independent" }),
    expect.objectContaining({ partId: "right", outcome: "correct", assistance: "independent" }),
  ]);
  const originalEvidence = await readCourseRouteObservations(f.sql, f.scope, course.id, false);
  expect(originalEvidence.raw).toHaveLength(1);
  expect((await routes().read(f.scope, course.id)).requirements.find(row => row.requirement.id === target.id)!.status)
    .toBe("needs_correction");
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(10);

  const correctionInput = input(target, 20);
  const correction = await routes().start(f.scope, course.id, correctionInput);
  if (correction.kind !== "ready") throw new Error(JSON.stringify(correction));
  expect(correction.resumed).toBe(false);
  const focus = { questionIdentityRefId, partId: "left", identityRefId: leftIdentity, requirementKey: targetKey };
  expect(correction.activity.learnerFocus).toMatchObject({ activityKind: "targeted_explain",
    focusObservationId: link.observationId, examPartFocus: focus });
  expect(await readOpeningTeachingCompilerFocus(f.sql, f.scope, correction.activity.id))
    .toMatchObject({ learnerFocus: { examPartFocus: focus } });
  const capacity = await readOpeningLearningCapacity(f.sql, f.scope);
  expect(capacity).toMatchObject({ usedMinutes: 30, budget: { dailyMinutes: 30, bufferMinutes: 0, revision: 1 } });
  expect(capacity.activities).toHaveLength(2);
  const saved = await persistedFacts();
  expect(saved.decisions).toHaveLength(2);
  const [reservation] = await f.sql`SELECT goal_json->'learningBudget' AS budget FROM opening_teaching_activities
    WHERE id=${correction.activity.id}`;
  expect(reservation!.budget).toMatchObject({ minutes: 20, goalId: goal.id, goalRevision: goal.revision, budgetRevision: 1 });

  // Drop/rebuild the service/repository objects, including the exam repository. Same keys restore persisted facts.
  const replay = await routes().start(f.scope, course.id, correctionInput);
  expect(replay).toMatchObject({ kind: "ready", resumed: true, activity: { id: correction.activity.id } });
  expect((await createOpeningExamSprintRepository(f.sql, pack).act(f.scope, conversion)).state).toEqual(converted.state);
  expect(await persistedFacts()).toEqual(saved);
  expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(30);

  // Neither another goal for the exam course nor another course receives a separate allowance.
  for (const [courseId, requirement] of [[course.id, target], [other.id, otherRequirement]] as const) {
    await expect(routes().start(f.scope, courseId, input(requirement, 5, alternate)))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("共同预算不足") });
    expect(await persistedFacts()).toEqual(saved); // No empty activity, decision receipt, help or exam mutation.
    expect((await readOpeningLearningCapacity(f.sql, f.scope)).usedMinutes).toBe(30);
  }
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, course.id)).toEqual(links);
  expect(await readCourseRouteObservations(f.sql, f.scope, course.id, false)).toEqual(originalEvidence);
  expect((await createOpeningExamSprintRepository(f.sql, pack).read(f.scope)).attempts).toEqual(converted.attempts);
});
