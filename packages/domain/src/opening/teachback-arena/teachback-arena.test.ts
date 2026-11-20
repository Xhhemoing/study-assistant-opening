import { describe, expect, it } from "vitest";
import { binarySearchTeachback, checkTeachbackRetestConflict, evaluateTeachbackDiagnosis, launchTeachbackArena,
  recordTeachbackDiagnosis, type TeachbackDiagnosisSubmission, type TeachbackRetestWindow } from "./index";

const target = { courseId: "algorithms", requirementKey: "interval", conceptId: "binary-search" };
const challenge = binarySearchTeachback(target);
const now = new Date("2026-09-01T12:00:00Z");
const clear = { now, windows: [] };
const diagnosis = { challengeId: challenge.challengeId, selectedRepairId: "exclude-mid", invariantRuleId: "shrinking-candidates" };
const correct = { ...diagnosis, stepId: "advance" };
const window: TeachbackRetestWindow = { ...target, status: "accepted", times: { deadlineAt: "2026-09-01T12:00:09.999Z" } };

describe("teachback-arena-v1", () => {
  it("presents the junior's derivation and all choices, without disclosing the rubric", () => {
    const view = launchTeachbackArena(challenge, clear);
    expect(view).toEqual({ version: "teachback-arena-v1", challengeId: challenge.challengeId, prompt: challenge.prompt,
      steps: challenge.steps, repairs: challenge.repairs, invariantRules: challenge.invariantRules });
  });

  it.each([
    [{ stepId: "conclude" }, "symptom_step_trapped"],
    [{ stepIndex: 3, selectedRepairId: "limit" }, "symptom_step_trapped"],
    [{ stepId: "bounds" }, "missed_flaw"], [{ stepId: "unknown" }, "missed_flaw"],
    [{ stepIndex: 4 }, "missed_flaw"], [{ stepIndex: -1 }, "missed_flaw"], [{ stepIndex: 2.1 }, "missed_flaw"],
    [{ stepIndex: 2, stepId: "conclude" }, "missed_flaw"],
    [{ stepId: "advance", selectedRepairId: "limit" }, "right_step_wrong_repair"],
    [{ stepId: "advance", invariantRuleId: "bounded-runtime" }, "right_step_wrong_repair"],
    [{ stepIndex: 2 }, "full_rebuttal_verified"], [{ stepId: "advance", stepIndex: 2 }, "full_rebuttal_verified"],
  ] as const)("judges %o as %s", (selection, verdict) => {
    expect(evaluateTeachbackDiagnosis(challenge, { ...diagnosis, ...selection }, clear)).toBe(verdict);
  });

  it("keeps the justification paired with its repair when multiple rebuttals are valid", () => {
    const alternative = { ...challenge, rubric: { ...challenge.rubric, validRebuttals: [
      ...challenge.rubric.validRebuttals, { selectedRepairId: "alternative", invariantRuleId: "another-rule" },
    ] } };
    expect(evaluateTeachbackDiagnosis(alternative, { ...correct, selectedRepairId: "alternative" }, clear))
      .toBe("right_step_wrong_repair");
  });

  it("returns a deterministic coaching record and rejects a submission for another challenge", () => {
    expect(recordTeachbackDiagnosis(challenge, correct, clear)).toEqual({ version: "teachback-arena-v1",
      challengeId: challenge.challengeId, submission: correct, evaluatedAt: now.toISOString(), verdict: "full_rebuttal_verified" });
    const other: TeachbackDiagnosisSubmission = { ...correct, challengeId: "other" };
    expect(() => recordTeachbackDiagnosis(challenge, other, clear)).toThrow(/different teachback challenge/);
  });
});

describe("delayed retest isolation", () => {
  it.each([{ ...window, conceptId: "different" }, { ...window, requirementKey: "other", status: "in_progress" as const }])(
    "blocks launch and rechecks a newly protected target before returning feedback or recording it", active => {
      const snapshot = { now, windows: [active] };
      expect(launchTeachbackArena(challenge, clear).challengeId).toBe(correct.challengeId);
      const conflict = { code: "ACTIVE_RETEST_WINDOW_CONFLICT", httpStatus: 409, retryAfter: 10 };
      expect(checkTeachbackRetestConflict(target, snapshot)).toMatchObject(conflict);
      for (const act of [() => launchTeachbackArena(challenge, snapshot),
        () => recordTeachbackDiagnosis(challenge, correct, snapshot),
        () => evaluateTeachbackDiagnosis(challenge, correct, snapshot)]) {
        expect(act).toThrowError(expect.objectContaining(conflict));
      }
    });

  it.each([undefined, null])("keeps a different requirement protected when its concept is %s", conceptId => {
    const snapshot = { now, windows: [{ ...window, requirementKey: "another-requirement", conceptId }] };
    const conflict = expect.objectContaining({ code: "ACTIVE_RETEST_WINDOW_CONFLICT", httpStatus: 409, retryAfter: 10 });
    expect(() => launchTeachbackArena(challenge, snapshot)).toThrowError(conflict);
    expect(() => recordTeachbackDiagnosis(challenge, correct, snapshot)).toThrowError(conflict);
  });

  it("keeps the deadline instant protected and releases the next millisecond", () => {
    const time = Date.parse(window.times.deadlineAt!);
    expect(checkTeachbackRetestConflict(target, { windows: [window], now: new Date(time) })?.retryAfter).toBe(1);
    expect(checkTeachbackRetestConflict(target, { windows: [window], now: new Date(time + 1) })).toBeNull();
  });

  it("uses the latest active deadline and preserves an open-ended legacy window", () => {
    const longer = { ...window, times: { deadlineAt: "2026-09-01T12:01:59.999Z" } };
    expect(checkTeachbackRetestConflict(target, { now, windows: [longer, window] })?.retryAfter).toBe(120);
    const legacy = { status: "in_progress" as const, times: { deadlineAt: null } };
    expect(checkTeachbackRetestConflict(target, { now, windows: [legacy, longer] })).toMatchObject({ retryAfter: null });
  });

  it("allows unrelated courses or targets and retests outside the active lifecycle", () => {
    const windows = [
      { ...window, courseId: "different-course" }, { ...window, requirementKey: "other", conceptId: "sort" },
      ...(["completed", "proposed", "cancelled", "declined", "superseded", "invalidated"] as const)
        .map(status => ({ ...window, status })),
    ];
    expect(checkTeachbackRetestConflict(target, { now, windows })).toBeNull();
  });

  it("fails closed on invalid time evidence", () => {
    expect(() => launchTeachbackArena(challenge, { now, windows: [{ ...window, times: { deadlineAt: "invalid" } }] })).toThrow(RangeError);
    expect(() => launchTeachbackArena(challenge, { now: new Date(NaN), windows: [] })).toThrow(RangeError);
  });
});
