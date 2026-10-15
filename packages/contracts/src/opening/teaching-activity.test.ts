import { expect, it } from "vitest";
import {
  teachingActivityAssociateCourseInputSchema,
  teachingActivityCreateInputSchema,
  teachingActivitySchema,
  teachingLearnerFocusSchema,
} from "./teaching-activity";
import {
  learningSessionCreateInputSchema,
  observationInputSchema,
} from "./learning";

const uuid = "11111111-1111-4111-8111-111111111111";

it("allows creating a teaching activity without a course", () => {
  const parsed = teachingActivityCreateInputSchema.parse({
    clientKey: "activity-key-1",
    intentKind: "question",
    intentSummary: "Why does this identity hold?",
    createIntent: { intentKind: "question", intentSummary: "Why does this identity hold?" },
  });
  expect(parsed.courseId).toBeUndefined();
});

it("accepts optional null courseId on create and associate", () => {
  expect(
    teachingActivityCreateInputSchema.parse({
      clientKey: "activity-key-2",
      intentKind: "topic",
      intentSummary: "Linear algebra review",
      courseId: null,
      createIntent: { intentKind: "topic" },
    }).courseId,
  ).toBeNull();
  expect(
    teachingActivityAssociateCourseInputSchema.parse({ courseId: null }).courseId,
  ).toBeNull();
  expect(
    teachingActivityAssociateCourseInputSchema.parse({ courseId: uuid }).courseId,
  ).toBe(uuid);
});

it("requires courseId on v1 learning session and observation schemas", () => {
  expect(learningSessionCreateInputSchema.safeParse({
    skillLabel: "fractions",
    sourceIds: [],
  }).success).toBe(false);
  expect(observationInputSchema.safeParse({
    sessionId: uuid,
    skillLabel: "fractions",
    sourceIds: [],
    answer: "1",
    outcome: "unverified",
    assistance: "unknown",
    clientKey: "observation-key",
  }).success).toBe(false);
  expect(learningSessionCreateInputSchema.safeParse({
    courseId: uuid,
    skillLabel: "fractions",
    sourceIds: [],
  }).success).toBe(true);
  expect(observationInputSchema.safeParse({
    sessionId: uuid,
    courseId: uuid,
    skillLabel: "fractions",
    sourceIds: [],
    answer: "1",
    outcome: "unverified",
    assistance: "unknown",
    clientKey: "observation-key",
  }).success).toBe(true);
});

it("parses a stored teaching activity with null courseId", () => {
  const row = teachingActivitySchema.parse({
    id: uuid,
    workspaceId: uuid,
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    courseId: null,
    status: "active",
    generateStatus: "ready",
    intentKind: "material",
    intentSummary: "From uploaded notes",
    sourceIds: [],
    pathVersion: 1,
    contentVersion: 0,
    clientKey: "activity-key-3",
    createdAt: "2026-10-11T02:00:00.000Z",
    updatedAt: "2026-10-11T02:00:00.000Z",
  });
  expect(row.courseId).toBeNull();
});

it("accepts a server-built learner focus and rejects unknown kinds or extra fields", () => {
  const focus = {
    skillLabel: "矩阵乘法",
    activityKind: "targeted_explain",
    reasonCode: "verified_incorrect",
    focusObservationId: uuid,
    recentAssistance: ["independent", "hinted"],
    strategyVersion: "adaptive-1",
  };
  expect(teachingLearnerFocusSchema.parse(focus)).toEqual(focus);
  expect(teachingLearnerFocusSchema.safeParse({ ...focus, activityKind: "lecture" }).success).toBe(false);
  expect(teachingLearnerFocusSchema.safeParse({ ...focus, mastery: 0.9 }).success).toBe(false);
  expect(teachingLearnerFocusSchema.safeParse({ ...focus, recentAssistance: ["hinted", "hinted", "hinted", "hinted"] }).success).toBe(false);
});
