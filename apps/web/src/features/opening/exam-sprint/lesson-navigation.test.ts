import type { ExamLesson, ExamSprintOverview } from "@aistudy/contracts";
import { describe, expect, it, vi } from "vitest";
import { attemptElementId, confirmedSprintLesson, confirmedSprintLessonRequest, findSprintLesson, focusSprintTarget, lessonElementId, prepareSprintLesson, revealSprintLesson, sprintLessonUnavailableReason } from "./lesson-navigation";

const lesson: ExamLesson = { id: "limits", topicId: "sequences", title: "极限", summary: "摘要", steps: [], workedExample: "例题", pitfalls: [] };
function fixture(): ExamSprintOverview {
  const identity = { packVersion: "1", contentFingerprint: "content-v1", mappingVersion: "mapping-v1" };
  return {
    pack: { id: "test", version: "1", title: "测试", description: "", topics: [], lessons: [{ id: lesson.id, topicId: lesson.topicId, title: lesson.title, summary: lesson.summary, exposureIdentity: identity }], sourceItems: [], weekPlan: [], limitations: [] },
    lessonContents: [], state: { version: 1, startedAt: "2026-10-20T00:00:00Z", examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] }, attempts: [], currentAttempt: null, activeRun: null, skills: [], recommendations: [],
    summary: { sourceTotal: 0, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 }, workload: { remainingItems: 0, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
  };
}

describe("sprint lesson navigation", () => {
  it("captures the exact version and training context and rejects unavailable legacy or mock entries", () => {
    const data = fixture();
    expect(prepareSprintLesson(data, lesson.id)).toEqual({ action: "open_lesson", lessonId: lesson.id, expectedRunId: null, expectedAttemptId: null, ...data.pack.lessons[0]!.exposureIdentity });
    expect(prepareSprintLesson(data, "missing")).toBeNull();
    data.pack.lessons[0]!.exposureIdentity = null;
    expect(prepareSprintLesson(data, lesson.id)).toBeNull();
    expect(sprintLessonUnavailableReason(data, lesson.id)).toContain("版本");
    data.activeRun = { id: "mock-1", mode: "mock-a", questionIds: [], startedAt: data.state.startedAt, deadlineAt: null, completedAt: null };
    expect(prepareSprintLesson(data, lesson.id)).toBeNull();
    expect(sprintLessonUnavailableReason(data, lesson.id)).toContain("交卷");
  });

  it("accepts only the confirmed exact content while rejecting changed identity, context or duplicate body", () => {
    const data = fixture();
    const intent = prepareSprintLesson(data, lesson.id)!;
    expect(confirmedSprintLesson(data, intent)).toBeNull();
    const content = { exposureId: "exposure-1", lesson };
    data.lessonContents = [content];
    expect(confirmedSprintLesson(data, intent)).toBe(content);
    expect(confirmedSprintLesson(data, { ...intent, contentFingerprint: "old-content" })).toBeNull();
    expect(confirmedSprintLesson(data, { ...intent, mappingVersion: "old-map" })).toBeNull();
    expect(confirmedSprintLesson(data, { ...intent, packVersion: "old-pack" })).toBeNull();
    expect(confirmedSprintLesson(data, { ...intent, expectedRunId: "previous-run" })).toBeNull();
    expect(confirmedSprintLesson(data, { ...intent, expectedAttemptId: "previous-question" })).toBeNull();
    data.lessonContents.push({ exposureId: "ambiguous", lesson });
    expect(confirmedSprintLesson(data, intent)).toBeNull();
  });

  it("lets only the current navigation request show a response", () => {
    const data = fixture();
    data.lessonContents = [{ exposureId: "exposure-1", lesson }];
    const request = { intent: prepareSprintLesson(data, lesson.id)! };
    const newer = { intent: { ...request.intent } };
    expect(confirmedSprintLessonRequest(request, newer, data, data)).toBeNull();
    expect(confirmedSprintLessonRequest(request, null, data, data)).toBeNull();
    expect(confirmedSprintLessonRequest(request, request, data, null)).toBeNull();
    expect(confirmedSprintLessonRequest(request, request, data, data)?.exposureId).toBe("exposure-1");
  });
  it("resolves only the exact, unique lesson and never falls back to the first lesson", () => {
    const second = { ...lesson, id: "integrals" };
    expect(findSprintLesson([lesson, second], "integrals")).toBe(second);
    for (const id of [null, undefined, "", "missing"]) expect(findSprintLesson([lesson, second], id)).toBeNull();
    expect(findSprintLesson([lesson, { ...lesson }], lesson.id)).toBeNull();
  });

  it("reopens and focuses the exact lesson on every request without forced smooth motion", () => {
    const summary = { focus: vi.fn() };
    const details = { open: false, querySelector: vi.fn(() => summary), scrollIntoView: vi.fn() };
    const document = { getElementById: vi.fn(() => details) } as unknown as Pick<Document, "getElementById">;
    const specialId = "lesson #1:[x]";
    expect(revealSprintLesson(document, specialId)).toBe(true);
    expect(details.open).toBe(true);
    details.open = false;
    expect(revealSprintLesson(document, specialId)).toBe(true);
    expect(details.open).toBe(true);
    expect(document.getElementById).toHaveBeenLastCalledWith(lessonElementId(specialId));
    expect(summary.focus).toHaveBeenCalledTimes(2);
    expect(summary.focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(details.scrollIntoView).toHaveBeenLastCalledWith({ block: "start", behavior: "instant" });
  });

  it("returns to the original attempt target using navigation alone", () => {
    const target = { focus: vi.fn(), scrollIntoView: vi.fn() };
    const document = { getElementById: vi.fn(() => target) } as unknown as Pick<Document, "getElementById">;
    const id = attemptElementId("run-3-attempt-2");
    expect(focusSprintTarget(document, id)).toBe(true);
    expect(document.getElementById).toHaveBeenCalledWith(id);
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  });

  it("reports a missing or no-longer-rendered destination without opening another lesson", () => {
    const document = { getElementById: () => null };
    expect(revealSprintLesson(document, "gone")).toBe(false);
    expect(focusSprintTarget(document, "gone")).toBe(false);
    const malformed = { getElementById: () => ({ querySelector: () => null }) } as unknown as Pick<Document, "getElementById">;
    expect(revealSprintLesson(malformed, "missing-summary")).toBe(false);
  });
});
