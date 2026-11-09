import { describe, expect, it } from "vitest";
import { evaluateReservedRetestQualification, reservedRetestUnavailable } from "./opening-course-reserved-selection";
import { mapLearningAttempt } from "./opening-learning-attempts";

// Synthetic server-evidence fixture only; no learner/model blind solve is claimed.
const complete = { contentCurrent: true, purposeCurrent: true, sourcesCurrent: true, stableIdentity: true,
  preIssueHistoryComplete: true, previouslyUnseen: true, noHelp: true, noAnswerReveal: true,
  independentBlindSolve: true };
describe("reserved independent retest qualification", () => {
  it("requires every independent evidence item, not a correct verdict", () => {
    expect(evaluateReservedRetestQualification(complete)).toEqual({ eligible: true, reasons: [] });
    expect(evaluateReservedRetestQualification({})).toMatchObject({ eligible: false });
  });
  it.each(Object.keys(complete) as Array<keyof typeof complete>)("refuses missing/false %s", key => {
    for (const missing of [false, null, undefined]) {
      const result = evaluateReservedRetestQualification({ ...complete, [key]: missing });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toHaveLength(1);
    }
  });
  it("invalidates after help or reveal, even when all version/identity evidence matches", () => {
    expect(evaluateReservedRetestQualification({ ...complete, noHelp: false, noAnswerReveal: false })).toMatchObject({
      eligible: false, reasons: [{ code: "help_not_excluded" }, { code: "answer_reveal_not_excluded" }],
    });
  });
  it("never trusts historical eligible JSON and explains old issued hinted attempts", () => {
    for (const create_intent of [{}, { reservedRetestQualification: { eligible: true, reasons: [] } }]) {
      const mapped = mapLearningAttempt({ id: 'attempt', client_key: 'reserved-issued:private', create_intent });
      expect(mapped.reservedRetestQualification).toMatchObject({ eligible: false });
      expect(mapped.reservedRetestQualification?.reasons).toHaveLength(9);
    }
  });
  it("never upgrades the production hinted path or treats its own issuance as prior exposure", () => {
    const result = reservedRetestUnavailable();
    expect(result.eligible).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toEqual([
      "stable_identity_missing", "pre_issue_history_missing", "unseen_evidence_missing", "help_not_excluded",
      "answer_reveal_not_excluded", "independent_blind_solve_missing",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/2603|137|keyRef|answer_key/);
  });
});
