import { describe, expect, it } from "vitest";
import { PAGE_CITATION_CLARIFY_MESSAGE } from "./tutor-policy";
import { tutorFailureForDisplay, TUTOR_FAILURE_MESSAGE, TUTOR_UNKNOWN_MESSAGE, TUTOR_CANCELLED_MESSAGE } from "./tutor-failure";

describe("tutor failure presentation", () => {
  it.each([null, "database password", { message: "SQL /private/config token=secret" }, { code: "__proto__", message: "secret" }, { code: "untrusted-code" }])("never renders unclassified stored diagnostics: %j", error => {
    expect(tutorFailureForDisplay("failed", error)).toEqual({ message: TUTOR_FAILURE_MESSAGE });
  });
  it("uses fixed actionable quota copy rather than the stored message", () => {
    expect(tutorFailureForDisplay("failed", { code: "BUDGET_EXCEEDED", message: "SQL secret" }))
      .toEqual({ code: "BUDGET_EXCEEDED", message: "今日 AI 预算已达上限，请在设置中核对预算，或明天再试。" });
  });
  it("retains the controlled clarify action without trusting its stored text", () => {
    expect(tutorFailureForDisplay("failed", { code: "page_not_in_sources", nextAction: "clarify", message: "internal" }))
      .toEqual({ code: "page_not_in_sources", nextAction: "clarify", message: PAGE_CITATION_CLARIFY_MESSAGE });
    expect(tutorFailureForDisplay("failed", { nextAction: "clarify", message: "internal" }))
      .toEqual({ message: TUTOR_FAILURE_MESSAGE });
  });
  it("preserves unknown outcome and cancellation meanings", () => {
    expect(tutorFailureForDisplay("outcome_unknown", { message: "raw unknown" })).toEqual({ message: TUTOR_UNKNOWN_MESSAGE });
    expect(tutorFailureForDisplay("cancelled", { message: "raw cancel" })).toEqual({ message: TUTOR_CANCELLED_MESSAGE });
    expect(tutorFailureForDisplay("running", { message: "stale diagnostic" })).toBeNull();
    expect(tutorFailureForDisplay("succeeded", null)).toBeNull();
  });
});
