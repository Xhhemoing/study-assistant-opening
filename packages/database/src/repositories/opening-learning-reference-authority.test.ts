import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { LearningObservation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const time = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString();
const reference = { attemptId: id(6), problemId: id(7), itemVersionId: id(8), referenceId: id(9),
  method: "A claimed independent review", scope: "whole_answer" as const, checkerId: id(99), outcome: "correct" as const };
const observation: LearningObservation = {
  id: id(3), workspaceId: scope.workspaceId, sessionId: id(4), courseId: id(5),
  attemptId: id(6), problemId: id(7), itemVersionId: id(8), sourceIds: [id(9)], sourceVersions: { [id(9)]: 1 },
  skillLabel: "fractions", requirementKey: "fractions-1", answer: "1", outcome: "correct", assistance: "independent",
  clientKey: "observation-key", occurredAt: time(4), startedAt: time(3), submittedAt: time(4), recordedAt: time(4),
  verdictSource: "reference_checked", referenceSourceId: id(9), referenceCheck: reference,
  sourceTurnIds: [], evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
};

function database(priors: Record<string, unknown>[] = []) {
  return ((strings: TemplateStringsArray | unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return {};
    const query = strings.join("?");
    // Nested identity predicates are SQL fragments, not executed mock queries.
    if (query.trimStart().startsWith("(v.teaching_revision_id")) return {};
    if (query.includes("FROM opening_course_knowledge") || query.includes("WITH current_nodes AS")) return {};
    if (query.includes("SELECT * FROM (?) identity") || query.includes("FROM opening_exam_attempt_links")) return Promise.resolve([]);
    if (query.includes("FROM opening_study_intent_events")) return Promise.resolve([]);
    if (!query.includes("FROM ")) return {};
    if (query.includes("FROM opening_learning_sessions")) return Promise.resolve([{ id: id(4), course_id: id(5) }]);
    if (query.includes("FROM opening_help_exposures") || query.includes("FROM opening_privacy_exclusions")) return Promise.resolve([]);
    if (query.includes("FROM opening_source_versions")) return Promise.resolve([{ source_id: id(9), version: 1, availability: "available" }]);
    if (query.includes("FROM opening_sources")) return Promise.resolve([{ id: id(9), version: 1, upload_state: "uploaded" }]);
    if (query.includes("FROM opening_learning_item_versions")) return Promise.resolve([{ id: id(8), problem_id: id(7), course_id: id(5) }]);
    if (query.includes("o.attempt_id IS NOT NULL")) return Promise.resolve(priors);
    if (query.includes("FROM opening_learning_observations")) return Promise.resolve([{ id: id(3), answer: "1", recorded_at: time(4), source_ids: [id(9)], source_versions: { [id(9)]: 1 } }]);
    throw new Error(`Unexpected evidence query: ${query}`);
  }) as unknown as Sql;
}

describe("manual reference provenance and exposure", () => {
  it("does not trust historical owner checks or an authority claim embedded in stored JSON", async () => {
    const forged = { ...observation, referenceCheck: { ...reference, referenceCheckAuthority: "independent_review" } };
    const facts = await readOpeningLearningEvidenceContext(database(), scope, forged);
    expect(facts.context.referenceCheckAuthority).toBe("learner");
    expect(evaluateEvidenceEligibility(facts.observation, facts.context)).toMatchObject({
      independentAttempt: "yes", verifiedCorrect: "unknown", policyVersion: "opening-evidence-v3",
    });
  });

  it.each(["self_report", "reference_checked"] as const)("retains %s reference exposure at the actual check time", async verdictSource => {
    const prior = { id: id(20), attempt_id: id(21), problem_id: id(7), item_version_id: id(8),
      verdict_source: verdictSource, submitted_at: time(1), recorded_at: time(5) };
    const beforeCheck = await readOpeningLearningEvidenceContext(database([prior]), scope, observation);
    expect(evaluateEvidenceEligibility(beforeCheck.observation, beforeCheck.context).independentAttempt).toBe("yes");
    const afterCheck = await readOpeningLearningEvidenceContext(database([prior]), scope, {
      ...observation, startedAt: time(6), submittedAt: time(7),
    });
    const eligibility = evaluateEvidenceEligibility(afterCheck.observation, {
      ...afterCheck.context,
      delayedCheck: { protocolId: "new-question-check", attemptId: id(6), earliestAt: Date.parse(time(6)), priorAnswerPolicy: "require_unseen_problem" },
    });
    expect(eligibility.independentAttempt).toBe("yes");
    expect(eligibility.reasonCodes).toContain("prior_answer_exposure");
    expect(eligibility.usableForDelayedCheck).toBe("no");
    expect(afterCheck.context.helpHistory?.exposures[0]?.deliveredAt).toBe(Date.parse(time(5)));
  });

  it("keeps missing historical check timing uncertain", async () => {
    const facts = await readOpeningLearningEvidenceContext(database([{ id: id(20), attempt_id: id(21), problem_id: id(7),
      item_version_id: id(8), verdict_source: "self_report", submitted_at: time(1), recorded_at: null }]), scope, observation);
    expect(evaluateEvidenceEligibility(facts.observation, facts.context).independentAttempt).toBe("unknown");
  });

  it("keeps another attempt's reference comparison during this answer unresolved", async () => {
    const facts = await readOpeningLearningEvidenceContext(database([{ id: id(20), attempt_id: id(21), problem_id: id(7),
      item_version_id: id(8), verdict_source: "self_report", submitted_at: time(1), recorded_at: time(5) }]), scope, {
      ...observation, startedAt: time(3), submittedAt: time(6),
    });
    expect(facts.context.helpHistory?.exposures[0]?.deliveredAt).toBe(Date.parse(time(5)));
    const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
    expect(eligibility.independentAttempt).toBe("unknown");
    expect(eligibility.reasonCodes).toContain("help_association_unknown");
  });

  it("does not backdate another attempt's post-submission comparison into this answer", async () => {
    const facts = await readOpeningLearningEvidenceContext(database([{ id: id(20), attempt_id: id(21), problem_id: id(7),
      item_version_id: id(8), verdict_source: "self_report", submitted_at: time(1), recorded_at: time(5) }]), scope, observation);
    expect(facts.context.helpHistory?.exposures[0]?.deliveredAt).toBe(Date.parse(time(5)));
    const eligibility = evaluateEvidenceEligibility(facts.observation, facts.context);
    expect(eligibility.independentAttempt).toBe("yes");
    expect(eligibility.reasonCodes).not.toContain("prior_answer_exposure");
    expect(eligibility.reasonCodes).not.toContain("help_association_unknown");
  });

  it("does not turn a later self-comparison of this attempt into help before its own submission", async () => {
    const facts = await readOpeningLearningEvidenceContext(database([{ id: id(20), attempt_id: observation.attemptId, problem_id: id(7),
      item_version_id: id(8), verdict_source: "self_report", submitted_at: time(1), recorded_at: time(5) }]), scope, observation);
    expect(facts.context.helpHistory?.exposures).toEqual([]);
    expect(evaluateEvidenceEligibility(facts.observation, facts.context).independentAttempt).toBe("yes");
  });
});
