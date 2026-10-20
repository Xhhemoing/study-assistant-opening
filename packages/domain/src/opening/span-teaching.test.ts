import { describe, expect, it } from "vitest";
import { applyExplicitStudyIntent, applyStudySessionSignal, createSpanTeachingSequence, DEFAULT_STUDY_SESSION_INTENT, spanModeForIntent, studySupportAffectsIndependence, updateStudySessionIntent } from "./span-teaching";
import { getSpanProblem, listSpanTeachingProblems, spanProblemStem } from "./span-teaching-catalog";
import { listSpanReservedProblems, spanValidationEligibility } from "./span-heldout-catalog";
import { solveSpanProblem } from "./span-verifier";
describe("span teaching and intent rules", () => {
  it("makes the six teaching commitments concrete in all three modes", () => {
    for (const mode of ["self_study", "overview", "challenge"] as const) for (const move of createSpanTeachingSequence(mode)) {
      expect(move.targetKnowledgeComponents.length).toBeGreaterThan(0);
      expect(move.presentation.instructions).not.toBe("");
      expect(move.studentAction).not.toBe("");
      expect(move.allowedHelp).toBeTruthy();
      expect(move.expectedObservation).not.toBe("");
      expect(move.continuation.stopWhen).not.toBe("");
    }
    expect(createSpanTeachingSequence("self_study").map((move) => move.presentation.kind)).toEqual(["worked_example", "faded_example", "independent_item"]);
    expect(createSpanTeachingSequence("overview").at(-1)?.targetKnowledgeComponents).toContain("geometry:plane-equation");
    expect(createSpanTeachingSequence("challenge").at(-1)?.allowedHelp).toBe("language_only");
  });
  it("applies explicit language/pace/purpose choices immediately", () => {
    const intent = updateStudySessionIntent(DEFAULT_STUDY_SESSION_INTENT, { purpose: "overview", pace: "fast", language: "bilingual", timeBudgetMinutes: 8 });
    expect(spanModeForIntent(intent)).toBe("overview");
    expect(intent.timeBudgetMinutes).toBe(8);
    expect(() => updateStudySessionIntent(intent, { timeBudgetMinutes: -1 })).toThrow(RangeError);
  });
  it("routes explicit conversational preferences directly and confirms only real mode ambiguity", () => {
    expect(applyExplicitStudyIntent(DEFAULT_STUDY_SESSION_INTENT, "我只有8分钟，快速串讲，用英文，直接给关键步骤")).toMatchObject({ intent: { purpose: "overview", pace: "fast", language: "en", timeBudgetMinutes: 8, explanationStyle: "key_steps" }, needsConfirmation: false });
    expect(applyExplicitStudyIntent(DEFAULT_STUDY_SESSION_INTENT, "快速串讲还是拔高比较好？")).toEqual({ intent: DEFAULT_STUDY_SESSION_INTENT, signals: [], needsConfirmation: true });
    expect(applyExplicitStudyIntent(DEFAULT_STUDY_SESSION_INTENT, "我是猜的，刚才抄了答案").signals).toEqual(["guessed", "copied_answer"]);
  });
  it.each(["不要用英文", "不要快速串讲", "我没有抄答案", "我不是猜的"])("does not execute a negated preference or condition: %s", message => {
    expect(applyExplicitStudyIntent(DEFAULT_STUDY_SESSION_INTENT, message)).toEqual({ intent: DEFAULT_STUDY_SESSION_INTENT, signals: [], needsConfirmation: true });
  });
  it("records guesses and copying without changing mathematical correctness", () => {
    expect(applyStudySessionSignal(DEFAULT_STUDY_SESSION_INTENT, "guessed")).toMatchObject({ reportedGuess: true, restrictIndependence: false, changesCorrectness: false, needsLaterVerification: true });
    expect(applyStudySessionSignal(DEFAULT_STUDY_SESSION_INTENT, "copied_answer")).toMatchObject({ action: "continue", restrictIndependence: true, changesCorrectness: false });
    expect(applyStudySessionSignal(DEFAULT_STUDY_SESSION_INTENT, "confused").action).toBe("diagnose");
    expect(applyStudySessionSignal(DEFAULT_STUDY_SESSION_INTENT, "too_easy")).toMatchObject({ action: "increase_challenge", needsLaterVerification: true });
  });
  it("distinguishes language help from mathematical help against the assessed target", () => {
    expect(studySupportAffectsIndependence("faithful_translation", "mathematics")).toBe(false);
    expect(studySupportAffectsIndependence("term_definition", "mathematics")).toBe(false);
    expect(studySupportAffectsIndependence("faithful_translation", "english_reading")).toBe(true);
    for (const kind of ["modeling_hint", "equation_setup", "key_step", "answer"] as const) expect(studySupportAffectsIndependence(kind, "mathematics")).toBe(true);
  });
  it("keeps teaching and reserved identities disjoint and resolves immutable versions", () => {
    const teaching = listSpanTeachingProblems();
    const reserved = listSpanReservedProblems();
    expect(teaching.some((item) => reserved.some((other) => item.id === other.id))).toBe(false);
    expect(teaching.every((item) => solveSpanProblem(item).kind !== "unknown")).toBe(true);
    expect(getSpanProblem("span-example-2d", 1)?.version).toBe("1");
    expect(getSpanProblem("span-example-2d", 2)).toBeNull();
    expect(getSpanProblem(reserved[0]!.id)).toBeNull();
    expect(spanProblemStem(teaching[0]!)).toContain("检查全部坐标");
    teaching[0]!.vectors[0][0] = "999";
    expect(getSpanProblem("span-example-2d")!.vectors[0][0]).toBe("1");
  });
  it("excludes exposed/debugged item versions and does not claim transfer for new IDs", () => {
    const item = listSpanReservedProblems()[0]!;
    expect(spanValidationEligibility(item, [{ itemId: item.id, itemVersion: item.version, familyId: item.familyId, use: "debug", releasedAt: "2026-10-19T00:00:00Z" }], true)).toEqual({ eligible: false, reasons: ["previous_debug"], unseenFamily: false });
    expect(spanValidationEligibility({ ...item, id: "new-number-id" }, [{ itemId: item.id, itemVersion: item.version, familyId: item.familyId, use: "demonstration", releasedAt: "2026-10-19T00:00:00Z" }], true)).toEqual({ eligible: true, reasons: [], unseenFamily: false });
    expect(spanValidationEligibility(item, [])).toEqual({ eligible: false, reasons: ["exposure_history_unknown"], unseenFamily: false });
  });
});
