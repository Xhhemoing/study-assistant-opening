import { describe, expect, it } from "vitest";
import { applyExamSprintCommand, createExamSprintState, validExamLessonExposure } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "../../../domain/src/opening/exam-sprint/catalog";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

const startedAt = "2026-10-20T08:00:00.000Z", openedAt = "2026-10-20T08:01:00.000Z";
function captured() {
  const pack = structuredClone(EXAM_SPRINT_PACK);
  let state = applyExamSprintCommand(createExamSprintState(startedAt), { action: "start", mode: "diagnostic", clientKey: "snapshot-start" }, pack, startedAt);
  const lesson = pack.lessons.find(item => item.id === "complex-arithmetic")!, mapping = validExamLessonExposure(lesson)!;
  state = applyExamSprintCommand(state, { action: "open_lesson", lessonId: lesson.id,
    expectedRunId: state.runs[0]!.id, expectedAttemptId: state.attempts[0]!.id, clientKey: "snapshot-lesson",
    packVersion: pack.version, contentFingerprint: mapping.contentFingerprint, mappingVersion: mapping.mappingVersion,
  }, pack, openedAt);
  return { pack, state };
}

describe("Sprint snapshot lesson ledger boundary", () => {
  it("round trips real frozen exposure identities, including partial example mappings", () => {
    const { pack, state } = captured();
    expect(parseExamSprintSnapshot(JSON.parse(JSON.stringify(pack)), JSON.parse(JSON.stringify(state)))).toEqual({ pack, state });
    expect(state.lessonExposures).toHaveLength(1);
    expect(state.attempts[0]!.lessonExposureIds).toEqual([state.lessonExposures![0]!.id]);
  });

  it("defaults an old missing ledger to empty without inventing attempt references", () => {
    const { pack, state } = captured();
    delete state.lessonExposures;
    for (const attempt of state.attempts) {
      delete attempt.lessonExposureIds; delete attempt.seenExampleExposureIds;
      delete attempt.partialExampleExposureIds; delete attempt.firstFamilyExposure;
    }
    const parsed = parseExamSprintSnapshot(pack, state);
    expect(parsed.state.lessonExposures).toEqual([]);
    expect(parsed.state.attempts[0]).not.toHaveProperty("lessonExposureIds");
    expect(parsed.state.attempts[0]).not.toHaveProperty("firstFamilyExposure");
  });

  it.each(["missing receipt", "wrong run", "wrong lesson", "wrong fingerprint", "changed family map", "changed body", "after answer", "duplicate reference", "duplicate authorization"])("rejects %s instead of manufacturing clean exposure history", scenario => {
    const { pack, state } = captured(), attempt = state.attempts[0]!, exposure = state.lessonExposures![0]!;
    if (scenario === "missing receipt") state.lessonExposures = [];
    if (scenario === "wrong run") exposure.runId = "not-a-run";
    if (scenario === "wrong lesson") exposure.lessonId = "not-a-lesson";
    if (scenario === "wrong fingerprint") exposure.contentFingerprint = "unreviewed";
    if (scenario === "changed family map") exposure.displayedFamilyIds = [];
    if (scenario === "changed body") pack.lessons[0]!.workedExample += " changed";
    if (scenario === "duplicate reference") attempt.lessonExposureIds!.push(exposure.id);
    if (scenario === "duplicate authorization") state.lessonExposures!.push({ ...exposure, id: "different-id", clientKey: "different-key" });
    if (scenario === "after answer") {
      const question = pack.questions.find(item => item.id === attempt.questionId)!;
      Object.assign(attempt, { answeredAt: startedAt, answer: question.answer, correct: true, confidence: 4, durationSeconds: 0 });
    }
    expect(() => parseExamSprintSnapshot(pack, state)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("preserves nullable partial-family qualification without requiring a new database column", () => {
    const { pack, state } = captured();
    state.attempts[0]!.firstFamilyExposure = null;
    expect(parseExamSprintSnapshot(pack, state).state.attempts[0]!.firstFamilyExposure).toBeNull();
  });
});
