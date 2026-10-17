import { describe, expect, it } from "vitest";
import { evidenceEligibilitySchema } from "./learning-evidence";

describe("evidence policy version read compatibility", () => {
  it.each(["opening-evidence-v1", "opening-evidence-v2"])("reads %s without rewriting its captured policy", policyVersion => {
    const value = { independentAttempt: "no", verifiedCorrect: "yes", usableForCurrentVersion: "yes",
      usableForDelayedCheck: "no", reasonCodes: ["exam_answer_changed"], policyVersion };
    expect(evidenceEligibilitySchema.parse(value)).toEqual(value);
  });
});
